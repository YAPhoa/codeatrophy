package httpapi_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"codeathropy/internal/ai"
	"codeathropy/internal/ai/aitest"
	"codeathropy/internal/app"
	"codeathropy/internal/domain"
	"codeathropy/internal/httpapi"
	"codeathropy/internal/judge/judgetest"
	"codeathropy/internal/secrets"
	"codeathropy/internal/store/sqlite"
	"codeathropy/internal/webui"
)

type client struct {
	t   *testing.T
	srv *httptest.Server
	ai  *aitest.Provider
}

func newServer(t *testing.T) *client {
	t.Helper()
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatal(err)
	}
	box, _ := secrets.NewBox(bytes.Repeat([]byte{9}, 32))
	fake := &aitest.Provider{}
	model := "claude-opus-5-5"
	a := app.New(app.Options{
		Store: db, Engine: judgetest.New("python"), Secrets: box,
		Providers: map[string]ai.Factory{ai.ProviderAnthropic: fake.Factory(), ai.ProviderOpenAICompatible: fake.Factory()},
		ProviderDefaults: map[string]app.ProviderDefaults{
			ai.ProviderAnthropic:        {Model: &model, BaseURL: "https://api.anthropic.com"},
			ai.ProviderOpenAICompatible: {BaseURL: "https://api.openai.com/v1"},
		},
		Limits:  domain.Limits{MaxImportBytes: 1 << 20, MaxSourceBytes: 1 << 10},
		Version: "0.1.0", MCP: app.MCPInfo{Enabled: true, Path: "/mcp"},
	})
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	web := webui.NewHandler(fstest.MapFS{
		"index.html":      {Data: []byte("<!doctype html><title>UI</title>")},
		"assets/app-1.js": {Data: []byte("console.log(1)")},
		"favicon.svg":     {Data: []byte("<svg/>")},
	})
	mcp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("mcp")) })
	srv := httptest.NewServer(httpapi.New(httpapi.Options{App: a, Web: web, MCP: mcp, MCPPath: "/mcp",
		AllowedOrigins: []string{"https://allowed.example"}}))
	t.Cleanup(func() {
		srv.Close()
		a.Stop()
		db.Close()
	})
	return &client{t: t, srv: srv, ai: fake}
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
		"maxStylePresets", "maxStyleNameChars", "maxStyleInstructionsChars", "maxModelIdChars", "maxApiKeyChars",
		"maxBundleNameChars", "maxBundleDescriptionChars", "maxImportUncompressedBytes", "maxImportEntries", "maxPageSize",
		"maxRequestBytes"} {
		if lim[k] == nil {
			t.Errorf("limits.%s missing", k)
		}
	}
	if _, old := lim["maxTestCaseCount"]; old {
		t.Error("maxTestCaseCount was renamed to maxGeneratedTestCases")
	}
	for k, want := range map[string]float64{"maxGeneratedTestCases": 30, "maxSummaryChars": 5000, "maxTextBytes": 1048576,
		"maxSourceUrlChars": 2048, "maxCollectionNameChars": 200, "maxTestCasesPerItem": 1000, "maxTestDataBytes": 8388608} {
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
	c.expect("PUT", api+"/settings/ai", `{"activeProvider":"anthropic"}`, 422)
	r := c.expect("PUT", api+"/settings/ai", `{"activeProvider":"anthropic","providers":{"anthropic":{"apiKey":"sk-ant-SECRETVALUE-abcd"}}}`, 200)
	if strings.Contains(string(r.body), "SECRETVALUE") {
		t.Fatal("PUT echoed the key")
	}
	r = c.expect("GET", api+"/settings/ai", "", 200)
	if strings.Contains(string(r.body), "SECRETVALUE") || !strings.Contains(string(r.body), `"apiKeyHint":"…abcd"`) {
		t.Errorf("GET settings: %s", r.body)
	}
	res := c.expect("POST", api+"/settings/ai/test", `{"provider":"anthropic"}`, 200).json(t)
	if res["ok"] != true || res["error"] != nil {
		t.Errorf("test: %v", res)
	}
	c.expect("POST", api+"/settings/ai/test", `{"provider":"gemini"}`, 422)
	if m := c.expect("GET", api+"/meta", "", 200).json(t)["ai"].(map[string]any); m["enabled"] != true || m["model"] != "claude-opus-5-5" {
		t.Errorf("meta ai after setup: %v", m)
	}
}

func TestStylesAndDraftEndpoints(t *testing.T) {
	c := newServer(t)
	c.expect("POST", api+"/ai/draft", `{"text":"x"}`, 503)
	c.expect("PUT", api+"/settings/ai", `{"activeProvider":"anthropic","providers":{"anthropic":{"apiKey":"sk-1234"}}}`, 200)
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
	d := c.expect("POST", api+"/ai/draft", `{"text":"x"}`, 200).json(t)
	if st := d["style"].(map[string]any); st["id"] != p["id"] || st["name"] != "House" {
		t.Errorf("style: %v", d["style"])
	}
	if d["draft"].(map[string]any)["problem"] != nil || len(d["draft"].(map[string]any)["testCases"].([]any)) != 0 {
		t.Errorf("draft: %v", d["draft"])
	}
	d = c.expect("POST", api+"/ai/draft", `{"text":"x","styleId":null}`, 200).json(t)
	if v, ok := d["style"]; !ok || v != nil {
		t.Errorf("style should be present and null: %v", d)
	}
	c.expect("POST", api+"/ai/draft", `{"text":"x","styleId":"nope"}`, 422)
	c.expect("PATCH", api+"/styles/"+p["id"].(string), `{"isDefault":false}`, 200)
	c.expect("DELETE", api+"/styles/"+p["id"].(string), "", 204)
	c.expect("DELETE", api+"/styles/"+p["id"].(string), "", 404)
	c.ai.Respond = func(ai.GenerateRequest) (any, error) { return nil, ai.Errorf(500, "provider exploded") }
	if r := c.expect("POST", api+"/ai/draft", `{"text":"x"}`, 502); r.errorCode(t) != "upstream_error" {
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
}

func multipartBody(t *testing.T, data []byte, strategy string) (string, *bytes.Buffer) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if strategy != "" {
		mw.WriteField("strategy", strategy)
	}
	fw, _ := mw.CreateFormFile("file", "b.codeathropy.zip")
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
		r.header.Get("Content-Disposition") != `attachment; filename=my-notes.codeathropy.zip` {
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
	c.expect("DELETE", api+"/tags/systems", "", 204)
	c.expect("DELETE", api+"/tags/systems", "", 404)
	c.expect("DELETE", api+"/collections/"+a, "", 204)
}
