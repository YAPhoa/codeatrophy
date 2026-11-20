package httpapi_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/ai/aitest"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/httpapi"
	"codeatrophy/internal/judge/judgetest"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store/teststore"
	"codeatrophy/internal/webui"
)

type client struct {
	t   *testing.T
	srv *httptest.Server
	ai  *aitest.Provider
}

// lastHandler is the handler of the most recent newServer, for tests that
// call it directly.
var lastHandler http.Handler

func newServer(t *testing.T, opts ...func(*httpapi.Options)) *client {
	t.Helper()
	ctx := context.Background()
	db := teststore.Open(t)
	box, _ := secrets.NewBox(bytes.Repeat([]byte{9}, 32))
	fake := &aitest.Provider{}
	model := "claude-opus-5-5"
	a := app.New(app.Options{
		Store: db, Engine: judgetest.New("python"), Secrets: box,
		Providers: map[string]ai.Factory{ai.ProviderAnthropic: fake.Factory(), ai.ProviderGemini: fake.Factory(),
			ai.ProviderOpenAICompatible: fake.Factory()},
		ProviderDefaults: map[string]app.ProviderDefaults{
			ai.ProviderAnthropic:        {Model: &model, BaseURL: "https://api.anthropic.com"},
			ai.ProviderGemini:           {BaseURL: "https://generativelanguage.googleapis.com/v1beta"},
			ai.ProviderOpenAICompatible: {BaseURL: "https://api.openai.com/v1"},
		},
		Limits:  domain.Limits{MaxImportBytes: 1 << 20, MaxSourceBytes: 1 << 10},
		Version: "0.1.0", MCP: app.MCPInfo{Enabled: true, Path: "/mcp"},
	})
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	presets, _ := a.ListStylePresets(ctx)
	// Tests start without the built-in style presets, which have tests of
	// their own in the store.
	for _, p := range presets.Items {
		if err := a.DeleteStylePreset(ctx, p.ID); err != nil {
			t.Fatal(err)
		}
	}
	web := webui.NewHandler(fstest.MapFS{
		"index.html":      {Data: []byte("<!doctype html><title>UI</title>")},
		"assets/app-1.js": {Data: []byte("console.log(1)")},
		"favicon.svg":     {Data: []byte("<svg/>")},
	})
	mcp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("mcp")) })
	o := httpapi.Options{App: a, Web: web, MCP: mcp, MCPPath: "/mcp",
		AllowedOrigins: []string{"https://allowed.example"}}
	for _, fn := range opts {
		fn(&o)
	}
	lastHandler = httpapi.New(o)
	srv := httptest.NewServer(lastHandler)
	t.Cleanup(func() {
		srv.Close()
		a.Stop()
	})
	return &client{t: t, srv: srv, ai: fake}
}

// statusOfCode maps an error code to the HTTP status a synchronous request
// would have answered with.
var statusOfCode = map[string]int{"upstream_error": 502, "ai_unavailable": 503, "validation_failed": 422,
	"not_found": 404, "conflict": 409, "internal": 500, "interrupted": 500, "judge_unavailable": 503}

// generate starts an AI generation the way the old synchronous endpoints
// were called — /ai/draft and /items/{id}/ai/variant become drafts — and
// waits for its job. A request refused up front is returned as it is; a
// job that succeeded as 200 with its result; a failed one as its error
// with the status the endpoint used to give.
func (c *client) generate(path, body string) response {
	c.t.Helper()
	target := path
	switch {
	case strings.HasSuffix(path, "/ai/draft"):
		target, body = api+"/drafts", `{"kind":"capture","generate":`+body+`}`
	case strings.HasSuffix(path, "/ai/variant"):
		id := strings.TrimSuffix(strings.TrimPrefix(path, api+"/items/"), "/ai/variant")
		target, body = api+"/drafts", `{"kind":"variant","variantOf":"`+id+`","generate":`+body+`}`
	}
	r := c.do("POST", target, body)
	if r.status != http.StatusAccepted {
		return r
	}
	m := r.json(c.t)
	id, _ := m["id"].(string)
	if job, ok := m["job"].(map[string]any); ok {
		id = job["id"].(string)
	}
	j := c.waitJob(id)
	var detail struct {
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	raw := c.expect("GET", api+"/ai/jobs/"+id, "", 200).body
	if err := json.Unmarshal(raw, &detail); err != nil {
		c.t.Fatal(err)
	}
	switch detail.Status {
	case "succeeded":
		return response{status: 200, body: detail.Result}
	case "failed":
		code := j["error"].(map[string]any)["code"].(string)
		return response{status: statusOfCode[code], body: []byte(`{"error":` + string(detail.Error) + `}`)}
	}
	c.t.Fatalf("job %s ended %s", id, detail.Status)
	return response{}
}

// expectAI is generate with an expected status.
func (c *client) expectAI(path, body string, status int) response {
	c.t.Helper()
	r := c.generate(path, body)
	if r.status != status {
		c.t.Fatalf("POST %s: status %d, want %d: %s", path, r.status, status, r.body)
	}
	return r
}

// waitJob polls an AI job until it has finished.
func (c *client) waitJob(id string) map[string]any {
	c.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		j := c.expect("GET", api+"/ai/jobs/"+id, "", 200).json(c.t)
		if s := j["status"]; s != "queued" && s != "running" {
			return j
		}
		if time.Now().After(deadline) {
			c.t.Fatalf("job %s is still %v", id, j["status"])
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type response struct {
	status int
	header http.Header
	body   []byte
}

func (r response) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("not JSON (%d): %s", r.status, r.body)
	}
	return m
}

func (r response) errorCode(t *testing.T) string {
	t.Helper()
	e, _ := r.json(t)["error"].(map[string]any)
	if e == nil {
		t.Fatalf("no error body: %s", r.body)
	}
	return e["code"].(string)
}

func (c *client) do(method, path, body string, headers ...string) response {
	c.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, c.srv.URL+path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return response{resp.StatusCode, resp.Header, b}
}

func (c *client) expect(method, path, body string, status int) response {
	c.t.Helper()
	r := c.do(method, path, body)
	if r.status != status {
		c.t.Fatalf("%s %s: status %d, want %d: %s", method, path, r.status, status, r.body)
	}
	return r
}

const api = "/api/v1"

func TestItemsLifecycle(t *testing.T) {
	c := newServer(t)
	it := c.expect("POST", api+"/items", `{"type":"problem","title":"Two Sum","tags":["array"],
		"testCases":[{"stdin":"1 2","expectedStdout":"3","isSample":true}]}`, 201).json(t)
	id := it["id"].(string)
	if it["revision"] != float64(1) || it["testCaseCount"] != float64(1) {
		t.Errorf("created: %v", it)
	}
	list := c.expect("GET", api+"/items?q=two&type=problem&status=todo,in_progress&tag=array&sort=relevance&limit=5", "", 200).json(t)
	if list["total"] != float64(1) {
		t.Errorf("list: %v", list)
	}
	c.expect("GET", api+"/items/"+id, "", 200)
	r := c.expect("PATCH", api+"/items/"+id, `{"title":"x","expectedRevision":7}`, 409)
	if f := r.json(t)["error"].(map[string]any)["fields"].(map[string]any); f["revision"] != float64(1) {
		t.Errorf("conflict fields: %v", f)
	}
	c.expect("PATCH", api+"/items/"+id, `{"title":"Two Sum II","expectedRevision":1}`, 200)
	r = c.expect("PATCH", api+"/items/"+id, `{"problem":{"timeLimitMs":"fast"}}`, 422)
	if f := r.json(t)["error"].(map[string]any)["fields"].(map[string]any); f["problem.timeLimitMs"] == nil {
		t.Errorf("type error fields: %v", f)
	}
	c.expect("PATCH", api+"/items/"+id, `{"title":`, 400)
	c.expect("POST", api+"/items/"+id+"/edits", `{"field":"body","edits":[{"oldText":"nope","newText":"x"}]}`, 422)
	c.expect("POST", api+"/items/bulk", `{"ids":["`+id+`"],"action":"setFavorite","favorite":true}`, 200)
	c.expect("GET", api+"/items?sort=position", "", 400)
	c.expect("GET", api+"/items?limit=abc", "", 400)
	c.expect("GET", api+"/items?limit=201", "", 400)
	c.expect("GET", api+"/items?limit=0", "", 400)
	c.expect("GET", api+"/items?offset=-1", "", 400)
	if got := c.expect("GET", api+"/items?id="+id+"&id=nope", "", 200).json(t); got["total"] != float64(1) {
		t.Errorf("id filter: %v", got)
	}
	facets := c.expect("GET", api+"/items/facets?type=problem&status=done&tag=array&sort=title", "", 200).json(t)
	if fmt.Sprint(facets) != "map[byDifficulty:map[easy:0 hard:0 medium:0 none:0] byStatus:map[done:0 in_progress:0 todo:1] byTag:map[] byType:map[problem:0 reading:0]]" {
		t.Errorf("facets: %v", facets)
	}
	facets = c.expect("GET", api+"/items/facets?type=reading&tag=array", "", 200).json(t)
	if fmt.Sprint(facets["byType"]) != "map[problem:1 reading:0]" {
		t.Errorf("type facets: %v", facets)
	}
	c.expect("GET", api+"/items/facets?difficulty=brutal", "", 400)
	c.expect("GET", api+"/items/missing", "", 404)
	c.expect("DELETE", api+"/items/"+id, "", 204)
	c.expect("DELETE", api+"/items/"+id, "", 404)
}

func TestErrorShapesAndRouting(t *testing.T) {
	c := newServer(t)
	r := c.expect("POST", api+"/items", `{"title":"no type"}`, 422)
	e := r.json(t)["error"].(map[string]any)
	if e["code"] != "validation_failed" || e["message"] == "" || e["fields"].(map[string]any)["type"] == nil {
		t.Errorf("validation error shape: %v", e)
	}
	r = c.expect("GET", api+"/items/nope", "", 404)
	if _, ok := r.json(t)["error"].(map[string]any)["fields"]; ok {
		t.Error("fields only for validation_failed")
	}
	if c.expect("GET", api+"/unknown", "", 404).errorCode(t) != "not_found" {
		t.Error("unknown endpoint")
	}
	r = c.expect("PUT", api+"/items", "", 405)
	if !strings.Contains(r.header.Get("Allow"), "GET") || r.errorCode(t) == "" {
		t.Errorf("405: %v %s", r.header, r.body)
	}
	// /api and /mcp never fall through to the SPA.
	c.expect("GET", "/api", "", 404).errorCode(t)
	c.expect("GET", "/api/v2/anything", "", 404).errorCode(t)
	if r := c.expect("GET", "/mcp", "", 200); string(r.body) != "mcp" {
		t.Error("/mcp should reach the MCP handler")
	}
	// SPA: files are served, client routes fall back to index.html, missing assets are 404.
	if r := c.expect("GET", "/", "", 200); !strings.Contains(string(r.body), "<title>UI</title>") {
		t.Error("index")
	}
	if r := c.expect("GET", "/items/123/edit", "", 200); !strings.Contains(string(r.body), "<title>UI</title>") ||
		r.header.Get("Cache-Control") != "no-cache" {
		t.Error("SPA fallback")
	}
	if r := c.expect("GET", "/assets/app-1.js", "", 200); !strings.Contains(r.header.Get("Cache-Control"), "immutable") {
		t.Error("asset caching")
	}
	c.expect("GET", "/assets/missing.js", "", 404)
	c.expect("POST", "/settings", "", 405)
	if r := c.do("GET", api+"/meta", ""); r.header.Get("X-Content-Type-Options") != "nosniff" {
		t.Error("security headers")
	}
}

func TestCrossOriginWritesAreRejected(t *testing.T) {
	c := newServer(t)
	body := `{"type":"reading","title":"x"}`
	if r := c.do("POST", api+"/items", body, "Origin", "https://evil.example"); r.status != 403 || r.errorCode(t) != "forbidden" {
		t.Errorf("cross-origin POST: %d %s", r.status, r.body)
	}
	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:3000", "https://allowed.example", c.srv.URL} {
		if r := c.do("POST", api+"/items", body, "Origin", origin); r.status != 201 {
			t.Errorf("%s: %d %s", origin, r.status, r.body)
		}
	}
	if r := c.do("GET", api+"/meta", "", "Origin", "https://evil.example"); r.status != 200 {
		t.Error("reads are not origin-restricted")
	}
	if r := c.do("POST", api+"/items", body, "Origin", "null"); r.status != 403 {
		t.Error("an opaque origin is rejected")
	}
}

func TestMetaStatsAndSettings(t *testing.T) {
	c := newServer(t)
	meta := c.expect("GET", api+"/meta", "", 200).json(t)
	if meta["version"] != "0.1.0" || meta["ai"].(map[string]any)["enabled"] != false || meta["ai"].(map[string]any)["model"] != nil {
		t.Errorf("meta: %v", meta)
	}
	lim := meta["limits"].(map[string]any)
	if lim["maxSourceBytes"] != float64(1024) || meta["mcp"].(map[string]any)["path"] != "/mcp" {
		t.Errorf("meta: %v", meta)
	}
	if v, ok := meta["mcp"].(map[string]any)["url"]; !ok || v != nil {
		t.Errorf("mcp.url should be null without a public URL: %v", meta["mcp"])
	}
	for _, k := range []string{"maxImportBytes", "maxSourceBytes", "maxTitleChars", "maxSummaryChars", "maxTextBytes",
		"maxSourceUrlChars", "maxSourceNoteChars", "maxTags", "maxTagChars", "maxCollectionNameChars",
		"maxCollectionDescriptionChars", "timeLimitMs", "memoryLimitKb", "maxTestCasesPerItem", "maxTestDataBytes",
		"maxTestCaseNameChars", "maxDraftTextChars", "maxInstructionChars", "maxPreviousDraftBytes", "maxGeneratedTestCases",
		"maxLargeInputBytes", "maxLargeTestCases", "maxStylePresets", "maxStyleNameChars", "maxStyleInstructionsChars", "maxSystemPromptChars", "maxModelIdChars", "maxApiKeyChars",
		"maxAiProviders", "maxAiProviderNameChars", "minAiTimeoutSeconds", "maxAiTimeoutSeconds", "maxBundleNameChars", "maxBundleDescriptionChars", "maxImportUncompressedBytes", "maxImportEntries", "maxPageSize",
		"maxRequestBytes", "maxImportCollections", "maxSolutionsPerItem", "maxSolutionNameChars", "maxSolutionNotesChars"} {
		if lim[k] == nil {
			t.Errorf("limits.%s missing", k)
		}
	}
	if len(lim) != 42 {
		t.Errorf("limits has %d keys, want 42", len(lim))
	}
	if _, old := lim["maxTestCaseCount"]; old {
		t.Error("maxTestCaseCount was renamed to maxGeneratedTestCases")
	}
	for k, want := range map[string]float64{"maxGeneratedTestCases": 30, "maxSummaryChars": 5000, "maxTextBytes": 1048576,
		"maxSourceUrlChars": 2048, "maxCollectionNameChars": 200, "maxTestCasesPerItem": 1000, "maxTestDataBytes": 8388608,
		"maxSolutionsPerItem": 50, "maxSolutionNameChars": 100, "maxSolutionNotesChars": 5000, "maxImportCollections": 10000,
		"maxImportEntries": 1000000, "maxAiProviders": 20, "maxAiProviderNameChars": 60,
		"minAiTimeoutSeconds": 10, "maxAiTimeoutSeconds": 300} {
		if lim[k] != want {
			t.Errorf("limits.%s = %v, want %v", k, lim[k], want)
		}
	}
	if tl := lim["timeLimitMs"].(map[string]any); tl["min"] != float64(domain.MinTimeLimitMs) || tl["max"] != float64(domain.MaxTimeLimitMs) {
		t.Errorf("timeLimitMs: %v", tl)
	}
	stats := c.expect("GET", api+"/stats", "", 200).json(t)
	if stats["items"].(map[string]any)["byDifficulty"].(map[string]any)["none"] != float64(0) {
		t.Errorf("stats keys: %v", stats)
	}
	if m := meta["ai"].(map[string]any); len(m) != 5 || m["providerId"] != nil || m["providerName"] != nil || m["kind"] != nil {
		t.Errorf("meta ai: %v", m)
	}
	settings := c.expect("GET", api+"/settings/ai", "", 200).json(t)
	if settings["enabled"] != true || settings["defaultProviderId"] != nil || len(settings["providers"].([]any)) != 0 ||
		settings["kinds"].(map[string]any)["anthropic"].(map[string]any)["keyRequired"] != true {
		t.Errorf("initial settings: %v", settings)
	}
	// The request timeout: the environment's (none here) until one is saved.
	if v, ok := settings["timeoutSeconds"]; !ok || v != float64(0) || settings["defaultTimeoutSeconds"] != float64(0) {
		t.Errorf("initial timeout: %v", settings)
	}
	if st := c.expect("PUT", api+"/settings/ai", `{"timeoutSeconds":120}`, 200).json(t); st["timeoutSeconds"] != float64(120) ||
		st["defaultTimeoutSeconds"] != float64(0) || st["defaultProviderId"] != nil {
		t.Errorf("PUT timeout: %v", st)
	}
	for _, js := range []string{`{"timeoutSeconds":9}`, `{"timeoutSeconds":301}`, `{"timeoutSeconds":12.5}`, `{"timeoutSeconds":"60"}`,
		`{"timeoutSeconds":true}`, `{"timeoutSeconds":[60]}`, `{"timeoutSeconds":{}}`, `{"timeoutSeconds":1e30}`} {
		r := c.expect("PUT", api+"/settings/ai", js, 422)
		if e := r.json(t)["error"].(map[string]any); e["code"] != "validation_failed" || e["fields"].(map[string]any)["timeoutSeconds"] == nil {
			t.Errorf("%s: %s", js, r.body)
		}
	}
	if st := c.expect("GET", api+"/settings/ai", "", 200).json(t); st["timeoutSeconds"] != float64(120) {
		t.Errorf("a rejected timeout changed the saved one: %v", st)
	}
	if st := c.expect("PUT", api+"/settings/ai", `{"timeoutSeconds":null}`, 200).json(t); st["timeoutSeconds"] != float64(0) {
		t.Errorf("null timeout: %v", st)
	}
	p := c.expect("POST", api+"/settings/ai/providers", `{"name":"Personal key","kind":"anthropic"}`, 201).json(t)
	id := p["id"].(string)
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+id+`"}`, 422)
	c.expect("POST", api+"/settings/ai/providers", `{"name":"personal KEY","kind":"anthropic"}`, 422)
	r := c.expect("PATCH", api+"/settings/ai/providers/"+id, `{"apiKey":"sk-ant-SECRETVALUE-abcd"}`, 200)
	if strings.Contains(string(r.body), "SECRETVALUE") || !strings.Contains(string(r.body), `"apiKeyHint":"…abcd"`) {
		t.Fatalf("PATCH: %s", r.body)
	}
	c.expect("PATCH", api+"/settings/ai/providers/"+id, `{"kind":"openai_compatible"}`, 422)
	c.expect("PATCH", api+"/settings/ai/providers/nope", `{"model":"x"}`, 404)
	if p["effort"] != nil {
		t.Errorf("a new provider's effort: %v", p["effort"])
	}
	r = c.expect("PATCH", api+"/settings/ai/providers/"+id, `{"effort":"max"}`, 422)
	if f := r.json(t)["error"].(map[string]any)["fields"].(map[string]any); f["effort"] == nil {
		t.Errorf("an unknown effort: %v", f)
	}
	if e := c.expect("PATCH", api+"/settings/ai/providers/"+id, `{"effort":"medium"}`, 200).json(t)["effort"]; e != "medium" {
		t.Errorf("effort after PATCH: %v", e)
	}
	r = c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+id+`"}`, 200)
	if strings.Contains(string(r.body), "SECRETVALUE") || r.json(t)["defaultProviderId"] != id {
		t.Errorf("PUT settings: %s", r.body)
	}
	r = c.expect("GET", api+"/settings/ai", "", 200)
	if strings.Contains(string(r.body), "SECRETVALUE") || !strings.Contains(string(r.body), `"isDefault":true`) {
		t.Errorf("GET settings: %s", r.body)
	}
	res := c.expect("POST", api+"/settings/ai/test", `{"providerId":"`+id+`"}`, 200).json(t)
	if res["ok"] != true || res["error"] != nil || res["modelsError"] != nil || len(res["models"].([]any)) != 1 {
		t.Errorf("test: %v", res)
	}
	res = c.expect("POST", api+"/settings/ai/test", `{"kind":"anthropic"}`, 200).json(t)
	if v, ok := res["models"]; res["ok"] != false || !ok || v != nil {
		t.Errorf("test without a key: %v", res)
	}
	c.expect("POST", api+"/settings/ai/test", `{"kind":"mistral"}`, 422)
	c.expect("POST", api+"/settings/ai/test", `{}`, 422)
	if m := c.expect("GET", api+"/meta", "", 200).json(t)["ai"].(map[string]any); m["enabled"] != true ||
		m["model"] != "claude-opus-5-5" || m["providerId"] != id || m["providerName"] != "Personal key" || m["kind"] != "anthropic" {
		t.Errorf("meta ai after setup: %v", m)
	}
	// The AI features switch: off keeps the default and refuses AI requests
	// as with no default; on again uses the same default.
	if st := c.expect("PUT", api+"/settings/ai", `{"enabled":false}`, 200).json(t); st["enabled"] != false || st["defaultProviderId"] != id {
		t.Errorf("switched off: %v", st)
	}
	if m := c.expect("GET", api+"/meta", "", 200).json(t)["ai"].(map[string]any); m["enabled"] != false || m["providerId"] != nil {
		t.Errorf("meta ai while switched off: %v", m)
	}
	for _, js := range []string{`{"text":"x"}`, `{"text":"x","providerId":"` + id + `"}`} {
		if e := c.expectAI(api+"/ai/draft", js, 503).json(t)["error"].(map[string]any); e["code"] != "ai_unavailable" {
			t.Errorf("draft while switched off: %v", e)
		}
	}
	for _, js := range []string{`{"enabled":"no"}`, `{"enabled":0}`, `{"enabled":null}`} {
		r := c.expect("PUT", api+"/settings/ai", js, 422)
		if e := r.json(t)["error"].(map[string]any); e["fields"].(map[string]any)["enabled"] == nil {
			t.Errorf("%s: %s", js, r.body)
		}
	}
	if st := c.expect("PUT", api+"/settings/ai", `{"enabled":true}`, 200).json(t); st["enabled"] != true || st["defaultProviderId"] != id {
		t.Errorf("switched on: %v", st)
	}
	if m := c.expect("GET", api+"/meta", "", 200).json(t)["ai"].(map[string]any); m["enabled"] != true || m["providerId"] != id {
		t.Errorf("meta ai when switched on: %v", m)
	}
	// With no default, switching on picks the first ready provider.
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":null}`, 200)
	if st := c.expect("PUT", api+"/settings/ai", `{"enabled":true}`, 200).json(t); st["defaultProviderId"] != id {
		t.Errorf("switched on with no default: %v", st)
	}
	c.expect("DELETE", api+"/settings/ai/providers/"+id, "", 204)
	c.expect("DELETE", api+"/settings/ai/providers/"+id, "", 404)
	if r := c.expect("PUT", api+"/settings/ai", `{"enabled":true}`, 422); !strings.Contains(string(r.body), `"enabled"`) {
		t.Errorf("switched on with nothing ready: %s", r.body)
	}
	if m := c.expect("GET", api+"/meta", "", 200).json(t)["ai"].(map[string]any); m["enabled"] != false {
		t.Errorf("meta ai after deleting the default: %v", m)
	}
}

// POST /settings/ai/models lists a provider's models without a generation
// request: models is null on failure, [] for an empty list.
func TestAIModelsEndpoint(t *testing.T) {
	c := newServer(t)
	const key = "sk-ant-SECRETVALUE-abcd"
	id := c.expect("POST", api+"/settings/ai/providers", `{"name":"A","kind":"anthropic","apiKey":"`+key+`"}`, 201).json(t)["id"].(string)
	c.ai.ListModelsFunc = func() ([]string, error) { return []string{"claude-b", "claude-a"}, nil }
	r := c.expect("POST", api+"/settings/ai/models", `{"providerId":"`+id+`","model":7}`, 200)
	if res := r.json(t); fmt.Sprint(res["models"]) != "[claude-a claude-b]" || res["error"] != nil || len(res) != 2 {
		t.Errorf("saved provider: %s", r.body)
	}
	c.ai.ListModelsFunc = func() ([]string, error) { return nil, nil }
	if r := c.expect("POST", api+"/settings/ai/models", `{"providerId":"`+id+`"}`, 200); !strings.Contains(string(r.body), `"models":[]`) {
		t.Errorf("empty list: %s", r.body)
	}
	r = c.expect("POST", api+"/settings/ai/models", `{"kind":"anthropic"}`, 200)
	if res := r.json(t); !strings.Contains(string(r.body), `"models":null`) || res["error"] == nil {
		t.Errorf("without a key: %s", r.body)
	}
	c.ai.ListModelsFunc = func() ([]string, error) { return nil, fmt.Errorf("invalid x-api-key %s", key) }
	r = c.expect("POST", api+"/settings/ai/models", `{"providerId":"`+id+`"}`, 200)
	if res := r.json(t); !strings.Contains(string(r.body), `"models":null`) || res["error"] == nil || strings.Contains(string(r.body), "SECRETVALUE") {
		t.Errorf("failing list: %s", r.body)
	}
	for _, js := range []string{`{}`, `{"kind":"mistral"}`, `{"providerId":"nope"}`, `{"providerId":"` + id + `","kind":"anthropic"}`} {
		c.expect("POST", api+"/settings/ai/models", js, 422)
	}
	c.expect("GET", api+"/settings/ai/models", "", 405)
	if n := len(c.ai.Requests()); n != 0 {
		t.Errorf("listing made %d generation requests", n)
	}
	if items := c.expect("GET", api+"/settings/ai/log", "", 200).json(t)["items"].([]any); len(items) != 0 {
		t.Errorf("listing was logged: %v", items)
	}
	p := c.expect("GET", api+"/settings/ai", "", 200).json(t)["providers"].([]any)[0].(map[string]any)
	if n := p["usage"].(map[string]any)["allTime"].(map[string]any)["requests"]; n != float64(0) {
		t.Errorf("listing was counted: %v", p["usage"])
	}
}

// The gemini kind is listed with its defaults, and its providers are saved,
// tested and listed like any other.
func TestGeminiKindEndpoints(t *testing.T) {
	c := newServer(t)
	kinds := c.expect("GET", api+"/settings/ai", "", 200).json(t)["kinds"].(map[string]any)
	if g, ok := kinds["gemini"].(map[string]any); !ok || g["defaultModel"] != nil || g["keyRequired"] != true ||
		g["defaultBaseUrl"] != "https://generativelanguage.googleapis.com/v1beta" || len(kinds) != 3 {
		t.Errorf("kinds: %v", kinds)
	}
	r := c.expect("POST", api+"/settings/ai/models", `{"kind":"gemini"}`, 200)
	if !strings.Contains(string(r.body), `"models":null`) || r.json(t)["error"] == nil {
		t.Errorf("without a key: %s", r.body)
	}
	const key = "AIza-SECRETVALUE-abcd"
	p := c.expect("POST", api+"/settings/ai/providers", `{"name":"G","kind":"gemini","apiKey":"`+key+`"}`, 201).json(t)
	if p["kind"] != "gemini" || p["ready"] != false || p["apiKeyHint"] != "…abcd" {
		t.Errorf("created: %v", p)
	}
	id := p["id"].(string)
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+id+`"}`, 422)
	c.ai.ListModelsFunc = func() ([]string, error) { return []string{"gemini-3.5-flash"}, nil }
	r = c.expect("POST", api+"/settings/ai/models", `{"providerId":"`+id+`"}`, 200)
	if res := r.json(t); fmt.Sprint(res["models"]) != "[gemini-3.5-flash]" || strings.Contains(string(r.body), "SECRETVALUE") {
		t.Errorf("models: %s", r.body)
	}
	p = c.expect("PATCH", api+"/settings/ai/providers/"+id, `{"model":"gemini-3.5-flash"}`, 200).json(t)
	if p["ready"] != true {
		t.Errorf("with a model: %v", p)
	}
	if res := c.expect("POST", api+"/settings/ai/test", `{"providerId":"`+id+`"}`, 200).json(t); res["ok"] != true {
		t.Errorf("test: %v", res)
	}
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+id+`"}`, 200)
	if m := c.expect("GET", api+"/meta", "", 200).json(t)["ai"].(map[string]any); m["kind"] != "gemini" || m["model"] != "gemini-3.5-flash" {
		t.Errorf("meta ai: %v", m)
	}
}

func TestStylesAndDraftEndpoints(t *testing.T) {
	c := newServer(t)
	c.expectAI(api+"/ai/draft", `{"text":"x"}`, 503)
	ap := c.expect("POST", api+"/settings/ai/providers", `{"name":"A","kind":"anthropic","apiKey":"sk-1234"}`, 201).json(t)
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+ap["id"].(string)+`"}`, 200)
	p := c.expect("POST", api+"/styles", `{"name":"House","instructions":"HOUSE-STYLE","isDefault":true}`, 201).json(t)
	c.expect("POST", api+"/styles", `{"name":"house","instructions":"x"}`, 422)
	list := c.expect("GET", api+"/styles", "", 200).json(t)
	if len(list["items"].([]any)) != 1 {
		t.Errorf("styles: %v", list)
	}
	c.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{"type": "reading", "title": "T", "summary": "", "body": "b", "difficulty": nil, "tags": []string{},
			"problem": nil, "testCases": []any{}, "assumptions": []string{}}, nil
	}
	d := c.expectAI(api+"/ai/draft", `{"text":"x"}`, 200).json(t)
	if st := d["style"].(map[string]any); st["id"] != p["id"] || st["name"] != "House" {
		t.Errorf("style: %v", d["style"])
	}
	if d["draft"].(map[string]any)["problem"] != nil || len(d["draft"].(map[string]any)["testCases"].([]any)) != 0 {
		t.Errorf("draft: %v", d["draft"])
	}
	d = c.expectAI(api+"/ai/draft", `{"text":"x","styleId":null}`, 200).json(t)
	if v, ok := d["style"]; !ok || v != nil {
		t.Errorf("style should be present and null: %v", d)
	}
	c.expectAI(api+"/ai/draft", `{"text":"x","styleId":"nope"}`, 422)
	c.expect("PATCH", api+"/styles/"+p["id"].(string), `{"isDefault":false}`, 200)
	c.expect("DELETE", api+"/styles/"+p["id"].(string), "", 204)
	c.expect("DELETE", api+"/styles/"+p["id"].(string), "", 404)
	c.ai.Respond = func(ai.GenerateRequest) (any, error) { return nil, ai.Errorf(500, "provider exploded") }
	if r := c.expectAI(api+"/ai/draft", `{"text":"x"}`, 502); r.errorCode(t) != "upstream_error" {
		t.Error("upstream error code")
	}

	// Large test cases are reported in the check (here: a reading, so
	// there is no check at all).
	if v, ok := d["check"]; !ok || v != nil {
		t.Errorf("check of a reading: %v", d["check"])
	}
	c.expectAI(api+"/ai/draft", `{"text":"x","largeTestCases":"yes"}`, 422)

	// The usage of a generation, and the AI log.
	u := d["usage"].(map[string]any)
	if u["logId"] == nil || u["model"] != "fake-model" || u["inputTokens"] != nil {
		t.Errorf("usage: %v", u)
	}
	for _, k := range []string{"durationMs", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"} {
		if _, ok := u[k]; !ok {
			t.Errorf("usage lacks %s: %v", k, u)
		}
	}
	page := c.expect("GET", api+"/settings/ai/log?limit=2", "", 200).json(t)
	items := page["items"].([]any)
	if page["total"] != float64(3) || len(items) != 2 || page["next"] == nil {
		t.Fatalf("log page: %v", page)
	}
	first := items[0].(map[string]any)
	if first["status"] != "failed" || first["operation"] != "draft" || first["request"] != nil || first["usage"] == nil {
		t.Errorf("entry: %v", first)
	}
	next := c.expect("GET", api+"/settings/ai/log?limit=2&before="+page["next"].(string), "", 200).json(t)
	if len(next["items"].([]any)) != 1 || next["next"] != nil {
		t.Errorf("second page: %v", next)
	}
	detail := c.expect("GET", api+"/settings/ai/log/"+u["logId"].(string), "", 200).json(t)
	if detail["request"].(map[string]any)["schema"] != "item_draft" || detail["truncated"] != false || detail["response"] == nil {
		t.Errorf("detail: %v", detail)
	}
	// Numbered pages.
	second := c.expect("GET", api+"/settings/ai/log?limit=2&offset=2", "", 200).json(t)
	if l := second["items"].([]any); len(l) != 1 || second["total"] != float64(3) || second["next"] != nil ||
		l[0].(map[string]any)["id"] != next["items"].([]any)[0].(map[string]any)["id"] {
		t.Errorf("offset page: %v", second)
	}
	if l := c.expect("GET", api+"/settings/ai/log?offset=1", "", 200).json(t)["items"].([]any); len(l) != 2 ||
		l[0].(map[string]any)["id"] != items[1].(map[string]any)["id"] {
		t.Errorf("offset 1: %v", l)
	}
	for _, q := range []string{"offset=-1", "offset=x", "limit=0", "limit=201", "offset=0&before=" + page["next"].(string)} {
		c.expect("GET", api+"/settings/ai/log?"+q, "", 400)
	}
	c.expect("GET", api+"/settings/ai/log?before=garbage", "", 400)
	c.expect("GET", api+"/settings/ai/log/nope", "", 404)
	c.expect("DELETE", api+"/settings/ai/log?before=nonsense", "", 400)
	c.expect("DELETE", api+"/settings/ai/log", "", 204)
	if page := c.expect("GET", api+"/settings/ai/log", "", 200).json(t); page["total"] != float64(0) {
		t.Errorf("cleared: %v", page)
	}
	st := c.expect("GET", api+"/settings/ai", "", 200).json(t)
	pu := st["providers"].([]any)[0].(map[string]any)["usage"].(map[string]any)
	if pu["allTime"].(map[string]any)["requests"] != float64(3) || pu["allTime"].(map[string]any)["failed"] != float64(1) ||
		pu["lastUsedAt"] == nil {
		t.Errorf("provider usage: %v", pu)
	}
}

// The AI routes pass providerId through: a named provider is used instead
// of the default, and a bad one is 422 on the field.
func TestAIRoutesTakeAProvider(t *testing.T) {
	c := newServer(t)
	def := c.expect("POST", api+"/settings/ai/providers", `{"name":"Default","kind":"anthropic","apiKey":"sk-ant-def-1111"}`, 201).json(t)
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+def["id"].(string)+`"}`, 200)
	other := c.expect("POST", api+"/settings/ai/providers", `{"name":"Other","kind":"anthropic","apiKey":"sk-ant-other-2222"}`, 201).json(t)
	reading := c.expect("POST", api+"/items", `{"type":"reading","title":"R","body":"b"}`, 201).json(t)["id"].(string)
	problem := c.expect("POST", api+"/items", `{"type":"problem","title":"P","problem":{"referenceSolution":{"language":"python","source":"sum"}},
		"testCases":[{"stdin":"1 2","expectedStdout":"3","isSample":true}]}`, 201).json(t)["id"].(string)
	readingDraft := map[string]any{"type": "reading", "title": "T", "summary": "", "body": "b", "difficulty": nil, "tags": []string{},
		"problem": nil, "testCases": []any{}, "assumptions": []string{}}
	cases := map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "sum"},
		"cases": []map[string]any{{"name": "n", "rationale": "r", "stdin": "7 7", "predictedStdout": "14"}}}
	routes := []struct {
		path, body string
		answer     any
	}{
		{api + "/ai/draft", `"text":"x"`, readingDraft},
		{api + "/items/" + reading + "/ai/variant", `"mode":"similar"`, readingDraft},
		{api + "/items/" + problem + "/ai/testcases", `"count":1`, cases},
	}
	lastKey := func() string {
		cs := c.ai.Configs()
		return cs[len(cs)-1].APIKey
	}
	for _, r := range routes {
		c.ai.Respond = func(ai.GenerateRequest) (any, error) { return r.answer, nil }
		c.expectAI(r.path, `{`+r.body+`}`, 200)
		if k := lastKey(); k != "sk-ant-def-1111" {
			t.Errorf("%s without providerId used %q", r.path, k)
		}
		res := c.expectAI(r.path, `{`+r.body+`,"providerId":"`+other["id"].(string)+`"}`, 200)
		if k := lastKey(); k != "sk-ant-other-2222" {
			t.Errorf("%s with providerId used %q", r.path, k)
		}
		// Large test cases: none asked for is an empty list, never null,
		// and the count is bounded.
		if strings.HasSuffix(r.path, "/testcases") && !strings.Contains(string(res.body), `"largeCases":[]`) {
			t.Errorf("%s: %s", r.path, res.body)
		}
		for _, n := range []string{"-1", "6", "1.5", "true"} {
			res := c.expectAI(r.path, `{`+r.body+`,"largeTestCases":`+n+`}`, 422)
			if e := res.json(t)["error"].(map[string]any); e["fields"].(map[string]any)["largeTestCases"] == nil {
				t.Errorf("%s with largeTestCases %s: %s", r.path, n, res.body)
			}
		}
		c.expectAI(r.path, `{`+r.body+`,"largeTestCases":5}`, 200)
		for _, bad := range []string{`"nope"`, `5`, `["x"]`} {
			res := c.expectAI(r.path, `{`+r.body+`,"providerId":`+bad+`}`, 422)
			if e := res.json(t)["error"].(map[string]any); e["code"] != "validation_failed" || e["fields"].(map[string]any)["providerId"] == nil {
				t.Errorf("%s with providerId %s: %s", r.path, bad, res.body)
			}
		}
	}
	if st := c.expect("GET", api+"/settings/ai", "", 200).json(t); st["defaultProviderId"] != def["id"] {
		t.Errorf("the default changed: %v", st["defaultProviderId"])
	}
}

// POST /ai/code works from the problem as the request gives it: no item is
// needed, and only the languages asked for come back.
func TestCodeEndpoint(t *testing.T) {
	c := newServer(t)
	form := `"title":"Coin Change","body":"## Input\n\nn and amount.","languages":["python","cpp"],"samples":[{"stdin":"3 11\n1 2 5\n","expectedStdout":"3\n"}]`
	c.expectAI(api+"/ai/code", `{`+form+`}`, 503)
	c.expectAI(api+"/ai/code", `{"body":"x","languages":["cobol"]}`, 422)
	c.expectAI(api+"/ai/code", `{"body":"x","languages":"python"}`, 422)
	c.expect("GET", api+"/ai/code", "", 405)
	def := c.expect("POST", api+"/settings/ai/providers", `{"name":"Default","kind":"anthropic","apiKey":"sk-ant-def-1111"}`, 201).json(t)
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+def["id"].(string)+`"}`, 200)
	other := c.expect("POST", api+"/settings/ai/providers", `{"name":"Other","kind":"anthropic","apiKey":"sk-ant-other-2222"}`, 201).json(t)
	c.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{"code": []map[string]string{
			{"language": "python", "starterCode": "sum", "prefix": "", "suffix": ""},
			{"language": "go", "starterCode": "package main", "prefix": "", "suffix": ""},
		}}, nil
	}
	res := c.expectAI(api+"/ai/code", `{`+form+`}`, 200)
	got := res.json(t)
	if sc := got["starterCode"].(map[string]any); len(sc) != 1 || sc["python"] != "sum" || got["check"] != nil || got["style"] != nil {
		t.Errorf("program: %s", res.body)
	}
	if !strings.Contains(string(res.body), `"harness":{}`) || got["usage"].(map[string]any)["logId"] == nil {
		t.Errorf("program: %s", res.body)
	}
	lastKey := func() string {
		cs := c.ai.Configs()
		return cs[len(cs)-1].APIKey
	}
	res = c.expectAI(api+"/ai/code", `{`+form+`,"interface":"function","providerId":"`+other["id"].(string)+`"}`, 200)
	got = res.json(t)
	if k := lastKey(); k != "sk-ant-other-2222" {
		t.Errorf("providerId: used %q", k)
	}
	ch := got["check"].(map[string]any)
	if h := got["harness"].(map[string]any); len(h) != 1 || h["python"] == nil || ch["attempted"] != true || len(ch["runners"].([]any)) != 1 {
		t.Errorf("function: %s", res.body)
	}
	c.expectAI(api+"/ai/code", `{`+form+`,"providerId":"nope"}`, 422)
	entry := c.expect("GET", api+"/settings/ai/log?operation=code", "", 200).json(t)
	if entry["total"] != float64(2) {
		t.Errorf("log: %v", entry)
	}
	c.ai.Respond = func(ai.GenerateRequest) (any, error) { return map[string]any{"code": []any{}}, nil }
	if r := c.expectAI(api+"/ai/code", `{`+form+`}`, 502); r.errorCode(t) != "upstream_error" {
		t.Error("upstream error code")
	}
}

func TestSubmissionsEndpoints(t *testing.T) {
	c := newServer(t)
	id := c.expect("POST", api+"/items", `{"type":"problem","title":"P","testCases":[{"stdin":"1 2","expectedStdout":"3","isSample":true}]}`, 201).json(t)["id"].(string)
	sub := c.expect("POST", api+"/items/"+id+"/submissions", `{"language":"python","source":"sum","mode":"submit"}`, 202).json(t)
	if sub["status"] != "queued" || sub["verdict"] != nil || sub["finishedAt"] != nil {
		t.Errorf("queued: %v", sub)
	}
	deadline := time.Now().Add(5 * time.Second)
	for sub["status"] != "completed" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		sub = c.expect("GET", api+"/submissions/"+sub["id"].(string), "", 200).json(t)
	}
	if sub["verdict"] != "accepted" || len(sub["results"].([]any)) != 1 {
		t.Errorf("completed: %v", sub)
	}
	page := c.expect("GET", api+"/items/"+id+"/submissions?mode=submit", "", 200).json(t)
	s0 := page["items"].([]any)[0].(map[string]any)
	if page["total"] != float64(1) || s0["source"] != nil || s0["results"] != nil {
		t.Errorf("summaries omit source and results: %v", page)
	}
	c.expect("POST", api+"/items/"+id+"/submissions", `{"language":"python","source":"`+strings.Repeat("x", 2000)+`"}`, 422)
	c.expect("POST", api+"/items/"+id+"/testcases/verify", `{}`, 422) // no reference solution
	chk0 := c.expect("POST", api+"/items/check", `{"type":"problem","title":"x","problem":{"referenceSolution":{"language":"python","source":"sum"}},
		"testCases":[{"stdin":"1 2","expectedStdout":"3"},{"stdin":"2 2","expectedStdout":"5"}]}`, 200)
	chk := chk0.json(t)
	if ch := chk["check"].(map[string]any); ch["passed"] != float64(1) || ch["total"] != float64(2) ||
		!strings.Contains(string(chk0.body), `"largeCases":[]`) {
		t.Errorf("item check: %v", chk)
	}
	if v := chk["cases"].([]any); len(v) != 2 || v[0].(map[string]any)["outcome"] != "passed" ||
		v[1].(map[string]any)["outcome"] != "wrong" || v[1].(map[string]any)["error"] != nil {
		t.Errorf("cases: %v", chk["cases"])
	}
	c.expect("POST", api+"/items/check", `{"type":"reading","title":"x"}`, 422)
	if s0["lineOffset"] != float64(0) || sub["lineOffset"] != float64(0) {
		t.Errorf("lineOffset: %v %v", s0["lineOffset"], sub["lineOffset"])
	}

	// A solution-only problem: the item carries its interface and harness,
	// and a language without a harness is 422.
	fn := c.expect("POST", api+"/items", `{"type":"problem","title":"F","problem":{"interface":"function",
		"harness":{"python":{"prefix":"x = 1\n","suffix":""}}},"testCases":[{"stdin":"1 2","expectedStdout":"3","isSample":true}]}`, 201).json(t)
	p := fn["problem"].(map[string]any)
	if p["interface"] != "function" || p["harness"].(map[string]any)["python"].(map[string]any)["prefix"] != "x = 1\n" {
		t.Errorf("function problem: %v", p)
	}
	fid := fn["id"].(string)
	c.expect("POST", api+"/items/"+fid+"/submissions", `{"language":"cpp","source":"sum"}`, 422)
	sub = c.expect("POST", api+"/items/"+fid+"/submissions", `{"language":"python","source":"sum"}`, 202).json(t)
	if sub["lineOffset"] != float64(1) || sub["source"] != "sum" {
		t.Errorf("function submission: %v", sub)
	}
	c.expect("PATCH", api+"/items/"+fid, `{"problem":{"interface":"program"}}`, 422)
	c.expect("PATCH", api+"/items/"+fid, `{"problem":{"interface":"program","harness":{}}}`, 200)
}

func multipartBody(t *testing.T, data []byte, strategy string) (string, *bytes.Buffer) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if strategy != "" {
		mw.WriteField("strategy", strategy)
	}
	fw, _ := mw.CreateFormFile("file", "b.codeatrophy.zip")
	fw.Write(data)
	mw.Close()
	return mw.FormDataContentType(), &buf
}

func (c *client) upload(path string, data []byte, strategy string) response {
	ct, body := multipartBody(c.t, data, strategy)
	req, _ := http.NewRequest("POST", c.srv.URL+path, body)
	req.Header.Set("Content-Type", ct)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return response{resp.StatusCode, resp.Header, b}
}

func TestExportImportEndpoints(t *testing.T) {
	c := newServer(t)
	c.expect("POST", api+"/items", `{"type":"reading","title":"Raft"}`, 201)
	r := c.expect("POST", api+"/export", `{"scope":"all","name":"My Notes"}`, 200)
	if r.header.Get("Content-Type") != "application/zip" ||
		r.header.Get("Content-Disposition") != `attachment; filename=my-notes.codeatrophy.zip` {
		t.Errorf("export headers: %v", r.header)
	}
	if _, err := zip.NewReader(bytes.NewReader(r.body), int64(len(r.body))); err != nil {
		t.Fatal(err)
	}
	other := newServer(t)
	pre := other.upload(api+"/import/preview", r.body, "")
	if pre.status != 200 || pre.json(t)["counts"].(map[string]any)["new"] != float64(1) {
		t.Errorf("preview: %d %s", pre.status, pre.body)
	}
	res := other.upload(api+"/import", r.body, "overwrite")
	if res.status != 200 || res.json(t)["created"] != float64(1) {
		t.Errorf("import: %d %s", res.status, res.body)
	}
	if bad := other.upload(api+"/import", []byte("not a zip"), ""); bad.status != 422 {
		t.Errorf("invalid bundle: %d", bad.status)
	}
	if big := other.upload(api+"/import/preview", bytes.Repeat([]byte("a"), 2<<20), ""); big.status != 413 || big.errorCode(t) != "too_large" {
		t.Errorf("too large: %d %s", big.status, big.body)
	}
	if r := other.do("POST", api+"/import", `{}`); r.status != 400 {
		t.Errorf("non-multipart upload: %d", r.status)
	}
	if r := other.upload(api+"/import", r.body, "merge"); r.status != 422 {
		t.Errorf("unknown strategy: %d", r.status)
	}
}

func TestStatsFavoritesAndUncollected(t *testing.T) {
	c := newServer(t)
	counts := func() (float64, float64) {
		items := c.expect("GET", api+"/stats", "", 200).json(t)["items"].(map[string]any)
		fav, unc := items["favorites"].(float64), items["uncollected"].(float64)
		if total := c.expect("GET", api+"/items?favorite=true", "", 200).json(t)["total"]; total != fav {
			t.Errorf("favorites = %v, GET /items?favorite=true total = %v", fav, total)
		}
		if total := c.expect("GET", api+"/items?uncollected=true", "", 200).json(t)["total"]; total != unc {
			t.Errorf("uncollected = %v, GET /items?uncollected=true total = %v", unc, total)
		}
		return fav, unc
	}
	if fav, unc := counts(); fav != 0 || unc != 0 {
		t.Errorf("empty library: favorites=%v uncollected=%v", fav, unc)
	}
	top := c.expect("POST", api+"/collections", `{"name":"Top"}`, 201).json(t)["id"].(string)
	nested := c.expect("POST", api+"/collections", `{"name":"Nested","parentId":"`+top+`"}`, 201).json(t)["id"].(string)
	c.expect("POST", api+"/items", `{"type":"reading","title":"A","favorite":true}`, 201)
	c.expect("POST", api+"/items", `{"type":"reading","title":"B","favorite":true,"collectionIds":["`+nested+`"]}`, 201)
	c.expect("POST", api+"/items", `{"type":"reading","title":"C"}`, 201)
	c.expect("POST", api+"/items", `{"type":"reading","title":"D","collectionIds":["`+top+`"]}`, 201)
	if fav, unc := counts(); fav != 2 || unc != 2 {
		t.Errorf("favorites=%v uncollected=%v, want 2 and 2", fav, unc)
	}
}

func TestCollectionsAndTagsEndpoints(t *testing.T) {
	c := newServer(t)
	a := c.expect("POST", api+"/collections", `{"name":"A"}`, 201).json(t)["id"].(string)
	b := c.expect("POST", api+"/collections", `{"name":"B","parentId":"`+a+`"}`, 201).json(t)["id"].(string)
	c.expect("PATCH", api+"/collections/"+a, `{"parentId":"`+b+`"}`, 409)
	c.expect("POST", api+"/items", `{"type":"reading","title":"R","tags":["c++/systems"]}`, 422)
	item := c.expect("POST", api+"/items", `{"type":"reading","title":"R","tags":["c++ systems"]}`, 201).json(t)["id"].(string)
	got := c.expect("PUT", api+"/collections/"+a+"/items", `{"itemIds":["`+item+`"]}`, 200).json(t)
	if len(got["itemIds"].([]any)) != 1 {
		t.Errorf("set items: %v", got)
	}
	c.expect("POST", api+"/collections/"+a+"/items", `{"itemIds":["`+item+`"]}`, 200)
	c.expect("DELETE", api+"/collections/"+a+"/items/"+item, "", 204)
	list := c.expect("GET", api+"/collections", "", 200).json(t)
	if len(list["items"].([]any)) != 2 {
		t.Errorf("collections: %v", list)
	}
	// Tag names are URL-encoded in the path.
	members := c.expect("GET", api+"/collections/"+a+"/items", "", 200).json(t)
	if len(members["itemIds"].([]any)) != 0 {
		t.Errorf("GET collection items: %v", members)
	}
	c.expect("GET", api+"/collections/nope/items", "", 404)
	c.expect("PATCH", api+"/tags/c%2B%2B%20systems", `{"name":"a/b"}`, 422)
	r := c.expect("PATCH", api+"/tags/c%2B%2B%20systems", `{"name":"systems"}`, 200).json(t)
	if r["name"] != "systems" || r["count"] != float64(1) {
		t.Errorf("rename: %v", r)
	}
	// A tag outlives its last item: listed with count 0 (the stats count
	// only carried tags), renamed, then deleted for good.
	c.expect("PATCH", api+"/items/"+item, `{"tags":[]}`, 200)
	tags := c.expect("GET", api+"/tags", "", 200).json(t)["items"].([]any)
	if len(tags) != 1 || tags[0].(map[string]any)["name"] != "systems" || tags[0].(map[string]any)["count"] != float64(0) {
		t.Errorf("tags after the last item dropped one: %v", tags)
	}
	if st := c.expect("GET", api+"/stats", "", 200).json(t); st["tags"] != float64(0) {
		t.Errorf("stats tags: %v", st["tags"])
	}
	r = c.expect("PATCH", api+"/tags/systems", `{"name":"empty"}`, 200).json(t)
	if r["name"] != "empty" || r["count"] != float64(0) {
		t.Errorf("rename of an empty tag: %v", r)
	}
	c.expect("PATCH", api+"/tags/systems", `{"name":"x"}`, 404)
	c.expect("DELETE", api+"/tags/empty", "", 204)
	c.expect("DELETE", api+"/tags/empty", "", 404)
	if tags := c.expect("GET", api+"/tags", "", 200).json(t)["items"].([]any); len(tags) != 0 {
		t.Errorf("tags after deleting: %v", tags)
	}
	c.expect("DELETE", api+"/collections/"+a, "", 204)
}

// hostDo sends a request with the given Host header.
func (c *client) hostDo(method, path, host string, headers ...string) response {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.srv.URL+path, nil)
	req.Host = host
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return response{resp.StatusCode, resp.Header, b}
}

// The Host header is checked on /api/ and /mcp before anything else, so a
// page on a rebound DNS name cannot reach the API even as a same-origin
// request.
func TestHostAllowList(t *testing.T) {
	c := newServer(t, func(o *httpapi.Options) { o.AllowedHosts = []string{"lan.example", "box.home.arpa"} })
	for _, host := range []string{"localhost", "localhost:8081", "127.0.0.1:9", "[::1]:8080", "app.localhost", "lan.example:8080", "BOX.home.arpa"} {
		if r := c.hostDo("GET", api+"/meta", host); r.status != 200 {
			t.Errorf("%s: %d %s", host, r.status, r.body)
		}
	}
	for _, host := range []string{"evil.example", "evil.example:8081", "192.168.1.20:8081", "lan.example.evil.example", "[::2]"} {
		for _, path := range []string{api + "/meta", "/mcp"} {
			r := c.hostDo("GET", path, host)
			if r.status != 403 || r.errorCode(t) != "forbidden" {
				t.Errorf("%s %s: %d %s", host, path, r.status, r.body)
				continue
			}
			if msg := r.json(t)["error"].(map[string]any)["message"].(string); !strings.Contains(msg, "CODEATROPHY_ALLOWED_HOSTS") {
				t.Errorf("the message names the setting: %s", msg)
			}
		}
	}
	// A forged same-origin request (Origin matching the forged Host) is refused too.
	if r := c.hostDo("POST", api+"/items", "evil.example", "Origin", "http://evil.example"); r.status != 403 {
		t.Errorf("rebound same-origin POST: %d", r.status)
	}
	// The UI itself is served for any host.
	if r := c.hostDo("GET", "/", "evil.example"); r.status != 200 {
		t.Errorf("UI: %d", r.status)
	}
	// An allowed host's origin may write.
	body := `{"type":"reading","title":"x"}`
	if r := c.do("POST", api+"/items", body, "Origin", "http://lan.example:8080"); r.status != 201 {
		t.Errorf("allowed host origin: %d %s", r.status, r.body)
	}
	// The origin check compares with the configured set, not the Host header.
	if r := c.do("POST", api+"/items", body, "Origin", "http://other.example"); r.status != 403 {
		t.Errorf("unlisted origin: %d", r.status)
	}
	star := newServer(t, func(o *httpapi.Options) { o.AllowedHosts = []string{"*"} })
	if r := star.hostDo("GET", api+"/meta", "anything.example"); r.status != 200 {
		t.Errorf("* accepts any host: %d", r.status)
	}
}

func TestSolutionsEndpoints(t *testing.T) {
	c := newServer(t)
	it := c.expect("POST", api+"/items", `{"type":"problem","title":"P","problem":{"referenceSolution":{"language":"python","source":"sum"}}}`, 201).json(t)
	id := it["id"].(string)
	ref := it["problem"].(map[string]any)["referenceSolution"].(map[string]any)
	if ref["id"] == nil || ref["language"] != "python" {
		t.Fatalf("referenceSolution view: %v", ref)
	}
	list := c.expect("GET", api+"/items/"+id+"/solutions", "", 200).json(t)["items"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["name"] != "Reference solution" || list[0].(map[string]any)["isReference"] != true {
		t.Fatalf("solutions: %v", list)
	}
	other := c.expect("POST", api+"/items/"+id+"/solutions", `{"name":"Brute force","language":"python","source":"echo","notes":"slow"}`, 201).json(t)
	if other["isReference"] != false || other["itemId"] != id {
		t.Errorf("created: %v", other)
	}
	sid := other["id"].(string)
	// Switching the reference is item content.
	c.expect("PATCH", api+"/solutions/"+sid, `{"isReference":true,"expectedRevision":99}`, 409)
	c.expect("PATCH", api+"/solutions/"+sid, `{"isReference":true,"expectedRevision":1}`, 200)
	got := c.expect("GET", api+"/items/"+id, "", 200).json(t)
	if got["revision"] != float64(2) || got["problem"].(map[string]any)["referenceSolution"].(map[string]any)["id"] != sid {
		t.Errorf("after switching: %v", got)
	}
	if r := c.do("PATCH", api+"/solutions/"+sid, `{"name":"two\u2028lines"}`); r.status != 422 {
		t.Errorf("multi-line name: %d", r.status)
	}
	if r := c.do("POST", api+"/items/"+id+"/testcases/verify", `{"solutionId":"nope"}`); r.status != 422 {
		t.Errorf("unknown solutionId: %d", r.status)
	}
	c.expect("POST", api+"/items/"+id+"/testcases/verify", `{"solutionId":"`+list[0].(map[string]any)["id"].(string)+`"}`, 200)
	c.expect("DELETE", api+"/solutions/"+sid, "", 204)
	c.expect("DELETE", api+"/solutions/"+sid, "", 404)
	if got := c.expect("GET", api+"/items/"+id, "", 200).json(t); got["problem"].(map[string]any)["referenceSolution"] != nil {
		t.Errorf("deleting the reference leaves none: %v", got["problem"])
	}
	reading := c.expect("POST", api+"/items", `{"type":"reading","title":"R"}`, 201).json(t)["id"].(string)
	c.expect("GET", api+"/items/"+reading+"/solutions", "", 422)
}

// A solution reports its last run on the test cases: null until it runs,
// set by a verification and by saving it from a submission of its code, and
// null again once its code changes.
func TestSolutionLastRun(t *testing.T) {
	c := newServer(t)
	id := c.expect("POST", api+"/items", `{"type":"problem","title":"P","testCases":[
		{"stdin":"1 2","expectedStdout":"3","isSample":true},{"stdin":"5 5","expectedStdout":"11"}]}`, 201).json(t)["id"].(string)
	sol := c.expect("POST", api+"/items/"+id+"/solutions", `{"name":"Sum","language":"python","source":"sum"}`, 201).json(t)
	if v, ok := sol["lastRun"]; !ok || v != nil {
		t.Errorf("a new solution's lastRun: %v", sol)
	}
	sid := sol["id"].(string)
	res := c.expect("POST", api+"/items/"+id+"/testcases/verify", `{"solutionId":"`+sid+`"}`, 200).json(t)
	if r := res["results"].([]any)[0].(map[string]any); r["memoryKb"] != float64(1024) || r["timeMs"] != float64(5) {
		t.Errorf("a verify result: %v", r)
	}
	run := c.expect("GET", api+"/items/"+id+"/solutions", "", 200).json(t)["items"].([]any)[0].(map[string]any)["lastRun"].(map[string]any)
	if len(run) != 5 || run["passed"] != float64(1) || run["total"] != float64(2) || run["timeMs"] != float64(5) ||
		run["memoryKb"] != float64(1024) || run["ranAt"] == nil {
		t.Errorf("lastRun after a verify: %v", run)
	}
	renamed := c.expect("PATCH", api+"/solutions/"+sid, `{"name":"Sum it up"}`, 200).json(t)
	if renamed["lastRun"] == nil {
		t.Error("a new name cleared lastRun")
	}
	if edited := c.expect("PATCH", api+"/solutions/"+sid, `{"source":"echo"}`, 200).json(t); edited["lastRun"] != nil {
		t.Errorf("a new source kept lastRun: %v", edited["lastRun"])
	}
	c.expect("PATCH", api+"/solutions/"+sid, `{"submissionId":"x"}`, 422)

	sub := c.expect("POST", api+"/items/"+id+"/submissions", `{"language":"python","source":"sum","mode":"submit"}`, 202).json(t)
	var done map[string]any
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if done = c.expect("GET", api+"/submissions/"+sub["id"].(string), "", 200).json(t); done["status"] == "completed" {
			break
		}
	}
	kept := c.expect("POST", api+"/items/"+id+"/solutions",
		`{"name":"Kept","language":"python","source":"sum","submissionId":"`+sub["id"].(string)+`"}`, 201).json(t)
	if run, _ := kept["lastRun"].(map[string]any); run == nil || run["passed"] != done["passedCount"] || run["total"] != float64(2) ||
		run["ranAt"] != done["finishedAt"] || run["memoryKb"] != done["memoryKb"] {
		t.Errorf("saved from a submission: %v (submission %v)", kept["lastRun"], done)
	}
	if other := c.expect("POST", api+"/items/"+id+"/solutions",
		`{"name":"Other","language":"python","source":"sum\nx","submissionId":"`+sub["id"].(string)+`"}`, 201).json(t); other["lastRun"] != nil {
		t.Errorf("saved from a submission of other code: %v", other["lastRun"])
	}
}

func TestPreferencesEndpoints(t *testing.T) {
	c := newServer(t)
	def := c.expect("GET", api+"/settings/preferences", "", 200).json(t)
	ed := def["editor"].(map[string]any)
	if def["hideTestCases"] != true || def["generatedTestCases"] != float64(8) || ed["tabSize"] != float64(4) || ed["fontSize"] != float64(14) || ed["lineWrapping"] != false ||
		ed["autocomplete"] != true || ed["closeBrackets"] != true || ed["matchBrackets"] != true {
		t.Errorf("defaults: %v", def)
	}
	got := c.expect("PUT", api+"/settings/preferences", `{"editor":{"tabSize":2}}`, 200).json(t)
	if got["editor"].(map[string]any)["tabSize"] != float64(2) || got["editor"].(map[string]any)["fontSize"] != float64(14) || got["hideTestCases"] != true {
		t.Errorf("deep merge: %v", got)
	}
	for _, bad := range []string{`{"editor":{"tabSize":3}}`, `{"editor":{"fontSize":25}}`, `{"theme":"dark"}`,
		`{"editor":{"tabSize":8,"vim":true}}`, `{"hideTestCases":"yes"}`, `{"editor":true}`, `[]`,
		`{"generatedTestCases":0}`, `{"generatedTestCases":31}`} {
		if r := c.do("PUT", api+"/settings/preferences", bad); r.status != 422 && r.status != 400 {
			t.Errorf("%s: %d", bad, r.status)
		}
	}
	// Nothing from a rejected request is saved.
	if got := c.expect("GET", api+"/settings/preferences", "", 200).json(t); got["editor"].(map[string]any)["tabSize"] != float64(2) {
		t.Errorf("a rejected PUT changed something: %v", got)
	}
}

func TestSystemPromptEndpoints(t *testing.T) {
	c := newServer(t)
	path := api + "/settings/ai/system-prompt"
	def := c.expect("GET", path, "", 200).json(t)
	if def["isCustom"] != false || def["custom"] != nil || !strings.HasPrefix(def["builtIn"].(string), "# Codeatrophy authoring conventions") ||
		!strings.HasPrefix(def["fixed"].(string), "# Fixed rules") || def["draftRules"] == "" || def["variantRules"] == "" {
		t.Errorf("built-in: %v", def)
	}
	got := c.expect("PUT", path, `{"custom":" My rules \n"}`, 200).json(t)
	if got["isCustom"] != true || got["custom"] != "My rules" || got["builtIn"] != def["builtIn"] {
		t.Errorf("set: %v", got)
	}
	for _, bad := range []string{`{}`, `{"custom":null}`, `{"custom":""}`, `{"custom":"a\u0000b"}`, `{"custom":1}`,
		`{"custom":"` + strings.Repeat("x", 20001) + `"}`} {
		if r := c.do("PUT", path, bad); r.status != 422 && r.status != 400 {
			t.Errorf("%.40s: %d", bad, r.status)
		}
	}
	if got := c.expect("GET", path, "", 200).json(t); got["custom"] != "My rules" {
		t.Errorf("a rejected PUT changed something: %v", got)
	}
	c.expect("DELETE", path, "", 204)
	if got := c.expect("GET", path, "", 200).json(t); got["isCustom"] != false || got["custom"] != nil {
		t.Errorf("after reset: %v", got)
	}
}

func TestTestCasePromptEndpoints(t *testing.T) {
	c := newServer(t)
	path := api + "/settings/ai/testcase-prompt"
	def := c.expect("GET", path, "", 200).json(t)
	if def["isCustom"] != false || def["custom"] != nil || !strings.HasPrefix(def["builtIn"].(string), "- For a program problem") ||
		!strings.HasPrefix(def["fixed"].(string), "# Fixed rules") {
		t.Errorf("built-in: %v", def)
	}
	got := c.expect("PUT", path, `{"custom":" My tests \n"}`, 200).json(t)
	if got["isCustom"] != true || got["custom"] != "My tests" || got["builtIn"] != def["builtIn"] || got["fixed"] != def["fixed"] {
		t.Errorf("set: %v", got)
	}
	if sp := c.expect("GET", api+"/settings/ai/system-prompt", "", 200).json(t); sp["isCustom"] != false {
		t.Errorf("the system prompt changed: %v", sp)
	}
	for _, bad := range []string{`{}`, `{"custom":null}`, `{"custom":""}`, `{"custom":"a\u0000b"}`, `{"custom":1}`,
		`{"custom":"` + strings.Repeat("x", 20001) + `"}`} {
		if r := c.do("PUT", path, bad); r.status != 422 && r.status != 400 {
			t.Errorf("%.40s: %d", bad, r.status)
		}
	}
	if got := c.expect("GET", path, "", 200).json(t); got["custom"] != "My tests" {
		t.Errorf("a rejected PUT changed something: %v", got)
	}
	c.expect("DELETE", path, "", 204)
	if got := c.expect("GET", path, "", 200).json(t); got["isCustom"] != false || got["custom"] != nil {
		t.Errorf("after reset: %v", got)
	}
}

// A request whose client has gone away is not reported as a server error.
func TestCanceledRequestIsNotAnInternalError(t *testing.T) {
	newServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, path := range []string{api + "/meta", api + "/items/00000000-0000-4000-8000-000000000001", api + "/items"} {
		req := httptest.NewRequest("GET", path, nil).WithContext(ctx)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		lastHandler.ServeHTTP(rec, req)
		if rec.Code != 499 {
			t.Errorf("%s: %d for a canceled request: %s", path, rec.Code, rec.Body)
		}
	}
}

// AI generations are jobs: they answer 202 at once, and their outcome is
// read from the job or, for a draft, from the draft.
func TestAIJobAndDraftEndpoints(t *testing.T) {
	c := newServer(t)
	c.expect("POST", api+"/drafts", `{"kind":"capture","generate":{"text":"x"}}`, 503)
	ap := c.expect("POST", api+"/settings/ai/providers", `{"name":"A","kind":"anthropic","apiKey":"sk-1234"}`, 201).json(t)
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+ap["id"].(string)+`"}`, 200)
	c.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{"type": "reading", "title": "Generated", "summary": "", "body": "b", "difficulty": nil,
			"tags": []string{}, "problem": nil, "testCases": []any{}, "assumptions": []string{}}, nil
	}
	c.expect("POST", api+"/ai/draft", `{"text":"x"}`, 404)
	if r := c.expect("POST", api+"/drafts", `{"kind":"capture","generate":{"text":""}}`, 422); !strings.Contains(string(r.body), `"text"`) {
		t.Errorf("generate field names: %s", r.body)
	}
	d := c.expect("POST", api+"/drafts", `{"kind":"capture","generate":{"text":"some notes","origin":"/drafts"}}`, 202).json(t)
	id := d["id"].(string)
	job := d["job"].(map[string]any)
	if d["state"] != "drafting" || job["draftId"] != id || job["kind"] != "draft" || job["origin"] != "/drafts" {
		t.Errorf("started: %v", d)
	}
	c.waitJob(job["id"].(string))
	got := c.expect("GET", api+"/drafts/"+id, "", 200).json(t)
	if got["state"] != "ready" || got["title"] != "Generated" || got["generationSeq"] != float64(1) ||
		got["generation"].(map[string]any)["draft"].(map[string]any)["title"] != "Generated" {
		t.Errorf("generated: %v", got)
	}
	list := c.expect("GET", api+"/drafts", "", 200).json(t)["items"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["generation"] != nil || list[0].(map[string]any)["state"] != "ready" {
		t.Errorf("list: %v", list)
	}
	jobs := c.expect("GET", api+"/ai/jobs?draftId="+id, "", 200).json(t)["items"].([]any)
	if len(jobs) != 1 || jobs[0].(map[string]any)["result"] != nil {
		t.Errorf("jobs: %v", jobs)
	}
	c.expect("PATCH", api+"/drafts/"+id, `{"basedOn":1,"content":{"form":{}},"expectedRevision":2}`, 200)
	if r := c.expect("PATCH", api+"/drafts/"+id, `{"edited":true,"expectedRevision":2}`, 409); !strings.Contains(string(r.body), `"revision":3`) {
		t.Errorf("conflict: %s", r.body)
	}
	if jobs := c.expect("GET", api+"/ai/jobs", "", 200).json(t)["items"].([]any); len(jobs) != 0 {
		t.Errorf("an adopted job is listed: %v", jobs)
	}
	c.expect("POST", api+"/drafts/"+id+"/generate", `{"text":"again","instruction":"shorter"}`, 202)
	c.waitJob(c.expect("GET", api+"/drafts/"+id, "", 200).json(t)["job"].(map[string]any)["id"].(string))
	c.expect("POST", api+"/drafts/"+id+"/retry", "", 202)
	c.expect("POST", api+"/drafts/"+id+"/save", `{"item":{"type":"reading"}}`, 422)
	c.waitJob(c.expect("GET", api+"/drafts/"+id, "", 200).json(t)["job"].(map[string]any)["id"].(string))
	it := c.expect("POST", api+"/drafts/"+id+"/save", `{"item":{"type":"reading","title":"Kept"}}`, 201).json(t)
	if it["title"] != "Kept" {
		t.Errorf("saved: %v", it)
	}
	c.expect("GET", api+"/drafts/"+id, "", 404)
	c.expect("GET", api+"/items/"+it["id"].(string), "", 200)

	// A variant draft, written by hand, then discarded.
	v := c.expect("POST", api+"/drafts", `{"kind":"variant","variantOf":"`+it["id"].(string)+`","content":{}}`, 201).json(t)
	if v["state"] != "edited" || v["title"] != "Variant of Kept" || v["job"] != nil {
		t.Errorf("variant: %v", v)
	}
	c.expect("POST", api+"/items/"+it["id"].(string)+"/ai/variant", `{"mode":"similar"}`, 404)
	c.expect("GET", api+"/drafts?variantOf="+it["id"].(string), "", 200)
	c.expect("GET", api+"/drafts?kind=note", "", 400)
	c.expect("POST", api+"/drafts/"+v["id"].(string)+"/retry", "", 422)
	c.expect("DELETE", api+"/drafts/"+v["id"].(string), "", 204)
	c.expect("DELETE", api+"/drafts/"+v["id"].(string), "", 404)

	// A job that is not a draft's, followed to the end, picked up and
	// dismissed.
	c.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{"code": []map[string]string{{"language": "python", "starterCode": "x", "prefix": "", "suffix": ""}}}, nil
	}
	j := c.expect("POST", api+"/ai/code", `{"body":"x","languages":["python"]}`, 202).json(t)
	jid := j["id"].(string)
	if j["status"] != "queued" || j["kind"] != "code" || j["draftId"] != nil {
		t.Errorf("code job: %v", j)
	}
	c.waitJob(jid)
	detail := c.expect("GET", api+"/ai/jobs/"+jid, "", 200).json(t)
	if detail["result"].(map[string]any)["starterCode"] == nil || detail["title"] != "x" || detail["request"].(map[string]any)["body"] != "x" {
		t.Errorf("detail: %v", detail)
	}
	c.expect("POST", api+"/ai/jobs/"+jid+"/cancel", "", 200)
	if p := c.expect("POST", api+"/ai/jobs/"+jid+"/pickup", "", 200).json(t); p["pickedUp"] != true || p["status"] != "succeeded" {
		t.Errorf("picked up: %v", p)
	}
	if l := c.expect("GET", api+"/ai/jobs?pickedUp=true&kind=code", "", 200).json(t)["items"].([]any); len(l) != 1 {
		t.Errorf("picked-up jobs: %v", l)
	}
	for _, q := range []string{"active=maybe", "pickedUp=2", "limit=0", "kind=chat"} {
		c.expect("GET", api+"/ai/jobs?"+q, "", 400)
	}
	c.expect("DELETE", api+"/ai/jobs/"+jid, "", 204)
	c.expect("GET", api+"/ai/jobs/"+jid, "", 404)
	c.expect("POST", api+"/ai/jobs/"+jid+"/cancel", "", 404)
}
