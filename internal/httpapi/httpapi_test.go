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
	app *app.App
	srv *httptest.Server
	ai  *aitest.Provider
	// h is the root handler, for tests that call it directly.
	h http.Handler
}

func newServer(t *testing.T, opts ...func(*httpapi.Options)) *client {
	t.Helper()
	return newServerWith(t, nil, opts...)
}

// newServerWith is newServer with a change to the application's options.
func newServerWith(t *testing.T, appOpts func(*app.Options), opts ...func(*httpapi.Options)) *client {
	t.Helper()
	ctx := context.Background()
	db := teststore.Open(t)
	box, _ := secrets.NewBox(bytes.Repeat([]byte{9}, 32))
	fake := &aitest.Provider{}
	model := "claude-opus-5-5"
	ao := app.Options{
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
	}
	if appOpts != nil {
		appOpts(&ao)
	}
	a := app.New(ao)
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
	})
	mcp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("mcp")) })
	o := httpapi.Options{App: a, Web: web, MCP: mcp, MCPPath: "/mcp",
		AllowedOrigins: []string{"https://allowed.example"}}
	for _, fn := range opts {
		fn(&o)
	}
	h := httpapi.New(o)
	srv := httptest.NewServer(h)
	t.Cleanup(func() {
		srv.Close()
		a.Stop()
	})
	return &client{t: t, app: a, srv: srv, ai: fake, h: h}
}

// defaultProvider saves a ready provider and makes it the default.
func (c *client) defaultProvider() string {
	c.t.Helper()
	id := c.expect("POST", api+"/settings/ai/providers", `{"name":"Default","kind":"anthropic","apiKey":"sk-ant-def-1111"}`, 201).json(c.t)["id"].(string)
	c.expect("PUT", api+"/settings/ai", `{"defaultProviderId":"`+id+`"}`, 200)
	return id
}

// readingAnswer is a provider's answer to a draft request.
func readingAnswer(ai.GenerateRequest) (any, error) {
	return map[string]any{"type": "reading", "title": "Generated", "summary": "", "body": "b", "difficulty": nil,
		"tags": []string{}, "problem": nil, "testCases": []any{}, "assumptions": []string{}}, nil
}

// jobOf returns the id of the job a 202 answer carries: the job itself, or
// a draft's job.
func jobOf(m map[string]any) string {
	if j, ok := m["job"].(map[string]any); ok {
		return j["id"].(string)
	}
	return m["id"].(string)
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

// jobOutcome waits for an AI job to finish and returns its status, its result
// and its error code ("" without one).
func (c *client) jobOutcome(id string) (status string, result map[string]any, code string) {
	c.t.Helper()
	c.waitJob(id)
	j := c.expect("GET", api+"/ai/jobs/"+id, "", 200).json(c.t)
	status, _ = j["status"].(string)
	result, _ = j["result"].(map[string]any)
	if e, ok := j["error"].(map[string]any); ok {
		code, _ = e["code"].(string)
	}
	return status, result, code
}

// waitSubmission polls a submission until it has completed.
func (c *client) waitSubmission(id string) map[string]any {
	c.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		sub := c.expect("GET", api+"/submissions/"+id, "", 200).json(c.t)
		if sub["status"] == "completed" {
			return sub
		}
		if time.Now().After(deadline) {
			c.t.Fatalf("submission %s is still %v", id, sub["status"])
		}
		time.Sleep(10 * time.Millisecond)
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

// fields returns the error's fields.
func (r response) fields(t *testing.T) map[string]any {
	t.Helper()
	e, _ := r.json(t)["error"].(map[string]any)
	f, _ := e["fields"].(map[string]any)
	return f
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

// expectField expects a 422 naming field.
func (c *client) expectField(method, path, body, field string) {
	c.t.Helper()
	r := c.expect(method, path, body, 422)
	if r.errorCode(c.t) != "validation_failed" || r.fields(c.t)[field] == nil {
		c.t.Errorf("%s %s %.60s: want fields.%s: %s", method, path, body, field, r.body)
	}
}

const api = "/api/v1"

func TestItemsLifecycle(t *testing.T) {
	c := newServer(t)
	it := c.expect("POST", api+"/items", `{"type":"problem","title":"Two Sum","body":"Given a and b.","tags":["array"],
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
	if f := r.fields(t); f["revision"] != float64(1) {
		t.Errorf("conflict fields: %v", f)
	}
	c.expect("PATCH", api+"/items/"+id, `{"title":"Two Sum II","expectedRevision":1}`, 200)
	c.expectField("PATCH", api+"/items/"+id, `{"problem":{"timeLimitMs":"fast"}}`, "problem.timeLimitMs")
	if c.expect("PATCH", api+"/items/"+id, `{"title":`, 400).errorCode(t) != "bad_request" {
		t.Error("malformed JSON")
	}
	c.expect("POST", api+"/items/"+id+"/edits", `{"field":"body","edits":[{"oldText":"nope","newText":"x"}]}`, 422)
	if got := c.expect("POST", api+"/items/"+id+"/edits", `{"field":"body","edits":[{"oldText":"a and b","newText":"two integers"}]}`, 200).json(t); got["body"] != "Given two integers." || got["id"] != id {
		t.Errorf("edits: %v", got)
	}
	if got := c.expect("POST", api+"/items/bulk", `{"ids":["`+id+`"],"action":"setFavorite","favorite":true}`, 200).json(t); got["affected"] != float64(1) {
		t.Errorf("bulk: %v", got)
	}
	for _, q := range []string{"sort=position", "limit=abc", "limit=201", "limit=0", "offset=-1", "favorite=maybe"} {
		c.expect("GET", api+"/items?"+q, "", 400)
	}
	if got := c.expect("GET", api+"/items?id="+id+"&id=nope", "", 200).json(t); got["total"] != float64(1) {
		t.Errorf("id filter: %v", got)
	}
	facets := c.expect("GET", api+"/items/facets?type=problem&status=done&tag=array&sort=title", "", 200).json(t)
	for _, k := range []string{"byType", "byStatus", "byDifficulty", "byTag"} {
		if _, ok := facets[k].(map[string]any); !ok {
			t.Errorf("facets.%s: %v", k, facets)
		}
	}
	if len(facets) != 4 {
		t.Errorf("facets: %v", facets)
	}
	c.expect("GET", api+"/items/facets?difficulty=brutal", "", 400)
	c.expect("GET", api+"/items/missing", "", 404)
	c.expect("DELETE", api+"/items/"+id, "", 204)
	c.expect("DELETE", api+"/items/"+id, "", 404)
}

// An item changed through the API records it as made over HTTP, whatever
// the body claims; summaries do not carry the record.
func TestItemChangeSource(t *testing.T) {
	c := newServer(t)
	it := c.expect("POST", api+"/items", `{"type":"reading","title":"R","createdBy":{"via":"mcp","client":"x","model":"y"}}`, 201).json(t)
	want := map[string]any{"via": "http", "client": nil, "model": nil}
	if fmt.Sprint(it["createdBy"]) != fmt.Sprint(want) || fmt.Sprint(it["lastUpdatedBy"]) != fmt.Sprint(want) {
		t.Errorf("created: %v / %v", it["createdBy"], it["lastUpdatedBy"])
	}
	list := c.expect("GET", api+"/items", "", 200).json(t)["items"].([]any)[0].(map[string]any)
	if _, ok := list["createdBy"]; ok {
		t.Errorf("a summary carries createdBy: %v", list)
	}
}

// The link endpoints, and the shapes of a link, a variant's origin and an
// item's link count, also once the items they name are deleted.
func TestItemLinksEndpoints(t *testing.T) {
	c := newServer(t)
	a := c.expect("POST", api+"/items", `{"type":"problem","title":"Two Sum","difficulty":"easy"}`, 201).json(t)["id"].(string)
	b := c.expect("POST", api+"/items", `{"type":"reading","title":"Hash maps"}`, 201).json(t)["id"].(string)
	v := c.expect("POST", api+"/items", `{"type":"problem","title":"Three Sum","variantOf":"`+a+`"}`, 201).json(t)
	if o, ok := v["variantOrigin"].(map[string]any); !ok || o["id"] != a || o["available"] != true ||
		o["title"] != "Two Sum" || o["type"] != "problem" || o["status"] != "todo" || o["difficulty"] != "easy" {
		t.Errorf("variantOrigin: %v", v["variantOrigin"])
	} else if at, ok := o["linkedAt"]; !ok || at != nil || len(o) != 7 {
		t.Errorf("variantOrigin keys: %v", o)
	}
	if got := c.expect("GET", api+"/items/"+b, "", 200).json(t); got["linkCount"] != float64(0) || got["variantOrigin"] != nil {
		t.Errorf("an unlinked item: %v", got)
	}
	links := c.expect("POST", api+"/items/"+a+"/links", `{"itemId":"`+b+`"}`, 200).json(t)["links"].([]any)
	l := links[0].(map[string]any)
	if len(links) != 1 || l["id"] != b || l["available"] != true || l["title"] != "Hash maps" || l["type"] != "reading" ||
		l["status"] != "todo" || l["difficulty"] != nil || l["linkedAt"] == nil || len(l) != 7 {
		t.Errorf("link: %v", links)
	}
	c.expect("POST", api+"/items/"+b+"/links", `{"itemId":"`+a+`"}`, 200)
	if got := c.expect("GET", api+"/items/"+b+"/links", "", 200).json(t)["links"].([]any); len(got) != 1 ||
		got[0].(map[string]any)["id"] != a {
		t.Errorf("the other side: %v", got)
	}
	list := c.expect("GET", api+"/items?id="+a, "", 200).json(t)["items"].([]any)
	if got := list[0].(map[string]any); got["linkCount"] != float64(1) || got["revision"] != float64(1) {
		t.Errorf("summary: %v", got)
	}
	c.expectField("POST", api+"/items/"+a+"/links", `{"itemId":"nope"}`, "itemId")
	c.expectField("POST", api+"/items/"+a+"/links", `{"itemId":"`+a+`"}`, "itemId")
	c.expectField("POST", api+"/items/"+a+"/links", `{}`, "itemId")
	c.expect("POST", api+"/items/nope/links", `{"itemId":"`+a+`"}`, 404)
	c.expect("GET", api+"/items/nope/links", "", 404)

	c.expect("DELETE", api+"/items/"+a, "", 204)
	l = c.expect("GET", api+"/items/"+b+"/links", "", 200).json(t)["links"].([]any)[0].(map[string]any)
	if l["available"] != false || l["title"] != "Two Sum" || l["type"] != "problem" || l["status"] != nil || l["difficulty"] != nil {
		t.Errorf("a link to a deleted item: %v", l)
	}
	got := c.expect("GET", api+"/items/"+v["id"].(string), "", 200).json(t)
	if o := got["variantOrigin"].(map[string]any); got["variantOf"] != a || o["available"] != false || o["title"] != "Two Sum" ||
		o["status"] != nil || got["revision"] != float64(1) {
		t.Errorf("the variant of a deleted item: %v", got)
	}
	c.expect("DELETE", api+"/items/"+b+"/links/"+a, "", 204)
	c.expect("DELETE", api+"/items/"+b+"/links/"+a, "", 204)
	c.expect("DELETE", api+"/items/nope/links/"+a, "", 404)
	if got := c.expect("GET", api+"/items/"+b+"/links", "", 200).json(t)["links"].([]any); len(got) != 0 {
		t.Errorf("after unlinking: %v", got)
	}
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
	if !strings.HasPrefix(r.header.Get("Content-Type"), "application/json") {
		t.Errorf("error content type: %v", r.header)
	}
	if c.expect("GET", api+"/unknown", "", 404).errorCode(t) != "not_found" {
		t.Error("unknown endpoint")
	}
	r = c.expect("PUT", api+"/items", "", 405)
	if r.header.Get("Allow") != "GET, POST" || r.errorCode(t) != "bad_request" {
		t.Errorf("405: %v %s", r.header, r.body)
	}
	// /api and /mcp never fall through to the UI.
	for _, path := range []string{"/api", "/api/v2/anything"} {
		if c.expect("GET", path, "", 404).errorCode(t) != "not_found" {
			t.Errorf("%s: not a JSON 404", path)
		}
	}
	if r := c.expect("GET", "/mcp", "", 200); string(r.body) != "mcp" {
		t.Error("/mcp should reach the MCP handler")
	}
	// Every other path is the UI's.
	if r := c.expect("GET", "/items/123/edit", "", 200); !strings.Contains(string(r.body), "<title>UI</title>") {
		t.Error("a client route should reach the UI")
	}
	// Security headers: API responses are never cached and load nothing, the
	// UI is never framed and keeps the policy its handler sets.
	for _, path := range []string{api + "/meta", api + "/nope", "/mcp"} {
		h := c.do("GET", path, "").header
		if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Referrer-Policy") != "no-referrer" ||
			h.Get("X-Frame-Options") != "" || h.Get("Content-Security-Policy") != "default-src 'none'; frame-ancestors 'none'" {
			t.Errorf("%s headers: %v", path, h)
		}
		if path != "/mcp" && h.Get("Cache-Control") != "no-store" {
			t.Errorf("%s: Cache-Control %q", path, h.Get("Cache-Control"))
		}
	}
	if h := c.do("GET", "/", "").header; h.Get("X-Frame-Options") != "DENY" || h.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.HasPrefix(h.Get("Content-Security-Policy"), "default-src 'self'; ") {
		t.Errorf("UI headers: %v", h)
	}
}

// Without an MCP handler the endpoint answers a JSON 404.
func TestMCPDisabled(t *testing.T) {
	c := newServer(t, func(o *httpapi.Options) { o.MCP = nil })
	for _, path := range []string{"/mcp", "/mcp/x"} {
		if r := c.do("POST", path, `{}`); r.status != 404 || r.errorCode(t) != "not_found" {
			t.Errorf("%s: %d %s", path, r.status, r.body)
		}
	}
}

// A panicking handler answers 500 internal, and the server keeps serving.
func TestPanicIsAnInternalError(t *testing.T) {
	c := newServer(t, func(o *httpapi.Options) {
		o.Web = http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") })
	})
	if r := c.do("GET", "/somewhere", ""); r.status != 500 || r.errorCode(t) != "internal" {
		t.Errorf("panic: %d %s", r.status, r.body)
	}
	c.expect("GET", api+"/meta", "", 200)
}

// repeatReader reads an endless run of one byte.
type repeatReader byte

func (b repeatReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = byte(b)
	}
	return len(p), nil
}

func TestRequestBodies(t *testing.T) {
	c := newServer(t)
	// An empty body decodes as {}: validated, not malformed.
	c.expectField("POST", api+"/items", "", "type")
	c.expect("PUT", api+"/settings/preferences", "", 200)
	c.expect("POST", api+"/drafts", "", 422)
	// A body over limits.maxRequestBytes is 413, for decoded and kept bodies alike.
	for _, path := range []string{api + "/items", api + "/ai/code"} {
		body := io.MultiReader(strings.NewReader(`{"title":"`), io.LimitReader(repeatReader('a'), domain.MaxRequestBytes))
		req := httptest.NewRequest("POST", path, body)
		req.Host = "localhost"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		c.h.ServeHTTP(rec, req)
		r := response{rec.Code, rec.Header(), rec.Body.Bytes()}
		if r.status != 413 || r.errorCode(t) != "too_large" {
			t.Errorf("%s: %d %s", path, r.status, r.body)
		}
	}
}

func TestCrossOriginWritesAreRejected(t *testing.T) {
	c := newServer(t)
	body := `{"type":"reading","title":"x"}`
	if r := c.do("POST", api+"/items", body, "Origin", "https://evil.example"); r.status != 403 || r.errorCode(t) != "forbidden" {
		t.Errorf("cross-origin POST: %d %s", r.status, r.body)
	}
	// The UI through the dev server's proxy, and an allowed origin.
	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:3000"} {
		if r := c.do("POST", api+"/items", body, "Origin", origin, "Sec-Fetch-Site", "same-origin"); r.status != 201 {
			t.Errorf("%s: %d %s", origin, r.status, r.body)
		}
	}
	if r := c.do("POST", api+"/items", body, "Origin", "https://allowed.example"); r.status != 201 {
		t.Errorf("allowed origin: %d %s", r.status, r.body)
	}
	if r := c.do("GET", api+"/meta", "", "Origin", "https://evil.example"); r.status != 200 {
		t.Error("reads are not origin-restricted")
	}
	// HEAD and OPTIONS are not state-changing either: the origin check lets
	// them through to routing.
	if r := c.do("HEAD", api+"/meta", "", "Origin", "https://evil.example"); r.status != 200 {
		t.Errorf("HEAD: %d", r.status)
	}
	if r := c.do("OPTIONS", api+"/items", "", "Origin", "https://evil.example"); r.status != 405 || r.header.Get("Allow") == "" {
		t.Errorf("OPTIONS: %d %v", r.status, r.header)
	}
	// Opaque and non-http(s) origins are refused, loopback host or not.
	for _, origin := range []string{"null", "chrome-extension://abcdef", "file://", "ftp://localhost"} {
		if r := c.do("POST", api+"/items", body, "Origin", origin); r.status != 403 {
			t.Errorf("%s: %d", origin, r.status)
		}
	}
}

func TestMetaStatsAndSettings(t *testing.T) {
	c := newServer(t)
	meta := c.expect("GET", api+"/meta", "", 200).json(t)
	if meta["version"] != "0.1.0" {
		t.Errorf("meta: %v", meta)
	}
	if m := meta["ai"].(map[string]any); len(m) != 5 || m["enabled"] != false || m["providerId"] != nil || m["providerName"] != nil ||
		m["kind"] != nil || m["model"] != nil {
		t.Errorf("meta ai: %v", m)
	}
	j := meta["judge"].(map[string]any)
	langs, _ := j["languages"].([]any)
	if len(j) != 4 || j["enabled"] != true || j["engine"] != "fake" || j["healthy"] != true || len(langs) != 1 ||
		langs[0].(map[string]any)["id"] != "python" {
		t.Errorf("meta judge: %v", j)
	}
	if m := meta["mcp"].(map[string]any); len(m) != 4 || m["enabled"] != true || m["path"] != "/mcp" || m["authRequired"] != false {
		t.Errorf("meta mcp: %v", m)
	}
	if v, ok := meta["mcp"].(map[string]any)["url"]; !ok || v != nil {
		t.Errorf("mcp.url should be null without a public URL: %v", meta["mcp"])
	}
	lim := meta["limits"].(map[string]any)
	for _, k := range []string{"maxImportBytes", "maxSourceBytes", "maxTitleChars", "maxSummaryChars", "maxTextBytes",
		"maxSourceUrlChars", "maxSourceNoteChars", "maxTags", "maxTagChars", "maxCollectionNameChars",
		"maxCollectionDescriptionChars", "timeLimitMs", "memoryLimitKb", "maxTestCasesPerItem", "maxTestDataBytes",
		"maxTestCaseNameChars", "maxDraftTextChars", "maxInstructionChars", "maxPreviousDraftBytes", "maxGeneratedTestCases",
		"maxLargeInputBytes", "maxLargeTestCases", "maxStylePresets", "maxStyleNameChars", "maxStyleInstructionsChars", "maxSystemPromptChars", "maxModelIdChars", "maxApiKeyChars",
		"maxAiProviders", "maxAiProviderNameChars", "minAiTimeoutSeconds", "maxAiTimeoutSeconds", "maxBundleNameChars", "maxBundleDescriptionChars", "maxImportUncompressedBytes", "maxImportEntries", "maxPageSize",
		"maxRequestBytes", "maxImportCollections", "maxSolutionsPerItem", "maxSolutionNameChars", "maxSolutionNotesChars", "maxNotesChars", "maxLinksPerItem",
		"minPasswordChars", "maxPasswordBytes", "maxMcpTokens", "maxMcpTokenNameChars", "maxResultTextBytes", "maxAiLogTextBytes"} {
		if lim[k] == nil {
			t.Errorf("limits.%s missing", k)
		}
	}
	if len(lim) != 50 {
		t.Errorf("limits has %d keys, want 50", len(lim))
	}
	if _, old := lim["maxTestCaseCount"]; old {
		t.Error("maxTestCaseCount was renamed to maxGeneratedTestCases")
	}
	for k, want := range map[string]float64{"maxGeneratedTestCases": 30, "maxSummaryChars": 5000, "maxTextBytes": 1048576,
		"maxSourceUrlChars": 2048, "maxCollectionNameChars": 200, "maxTestCasesPerItem": 1000, "maxTestDataBytes": 8388608,
		"maxSolutionsPerItem": 50, "maxSolutionNameChars": 100, "maxSolutionNotesChars": 5000, "maxNotesChars": 4000, "maxLinksPerItem": 30, "maxImportCollections": 10000,
		"maxImportEntries": 1000000, "maxAiProviders": 20, "maxAiProviderNameChars": 60,
		"minAiTimeoutSeconds": 10, "maxAiTimeoutSeconds": 300, "maxSourceBytes": 1024, "maxRequestBytes": 33554432,
		"minPasswordChars": 8, "maxPasswordBytes": 72, "maxMcpTokens": 20, "maxMcpTokenNameChars": 60,
		"maxResultTextBytes": 65536, "maxAiLogTextBytes": 262144} {
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

	settings := c.expect("GET", api+"/settings/ai", "", 200).json(t)
	if settings["enabled"] != true || settings["defaultProviderId"] != nil || len(settings["providers"].([]any)) != 0 ||
		settings["kinds"].(map[string]any)["anthropic"].(map[string]any)["keyRequired"] != true {
		t.Errorf("initial settings: %v", settings)
	}
	if v, ok := settings["timeoutSeconds"]; !ok || v != float64(0) || settings["defaultTimeoutSeconds"] != float64(0) {
		t.Errorf("initial timeout: %v", settings)
	}
	if st := c.expect("PUT", api+"/settings/ai", `{"timeoutSeconds":120}`, 200).json(t); st["timeoutSeconds"] != float64(120) {
		t.Errorf("PUT timeout: %v", st)
	}
	c.expectField("PUT", api+"/settings/ai", `{"timeoutSeconds":9}`, "timeoutSeconds")
	c.expectField("PUT", api+"/settings/ai", `{"timeoutSeconds":"60"}`, "timeoutSeconds")

	// Provider CRUD; the key never comes back.
	p := c.expect("POST", api+"/settings/ai/providers", `{"name":"Personal key","kind":"anthropic"}`, 201).json(t)
	id := p["id"].(string)
	r := c.expect("PATCH", api+"/settings/ai/providers/"+id, `{"apiKey":"sk-ant-SECRETVALUE-abcd"}`, 200)
	if strings.Contains(string(r.body), "SECRETVALUE") || !strings.Contains(string(r.body), `"apiKeyHint":"…abcd"`) {
		t.Fatalf("PATCH: %s", r.body)
	}
	c.expect("PATCH", api+"/settings/ai/providers/nope", `{"model":"x"}`, 404)
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
	c.expect("POST", api+"/settings/ai/test", `{}`, 422)
	if m := c.expect("GET", api+"/meta", "", 200).json(t)["ai"].(map[string]any); m["enabled"] != true ||
		m["model"] != "claude-opus-5-5" || m["providerId"] != id || m["providerName"] != "Personal key" || m["kind"] != "anthropic" {
		t.Errorf("meta ai after setup: %v", m)
	}
	c.expect("DELETE", api+"/settings/ai/providers/"+id, "", 204)
	c.expect("DELETE", api+"/settings/ai/providers/"+id, "", 404)
}

// With a public URL and a token the meta says where MCP is and that it needs
// the token; without a judge engine the judge is off.
func TestMetaWithPublicURLAndNoJudge(t *testing.T) {
	c := newServerWith(t, func(o *app.Options) {
		o.Engine = nil
		o.MCP = app.MCPInfo{Enabled: true, Path: "/mcp", AuthRequired: true, PublicURL: "https://code.example.com/"}
	})
	r := c.expect("GET", api+"/meta", "", 200)
	meta := r.json(t)
	if m := meta["mcp"].(map[string]any); m["url"] != "https://code.example.com/mcp" || m["authRequired"] != true {
		t.Errorf("meta mcp: %v", m)
	}
	if j := meta["judge"].(map[string]any); j["enabled"] != false || j["engine"] != "none" || j["healthy"] != false ||
		!strings.Contains(string(r.body), `"languages":[]`) {
		t.Errorf("meta judge: %s", r.body)
	}
}

// POST /settings/ai/models lists a provider's models: models is null on
// failure, [] for an empty list.
func TestAIModelsEndpoint(t *testing.T) {
	c := newServer(t)
	id := c.expect("POST", api+"/settings/ai/providers", `{"name":"A","kind":"anthropic","apiKey":"sk-ant-1234"}`, 201).json(t)["id"].(string)
	c.ai.ListModelsFunc = func() ([]string, error) { return []string{"claude-a"}, nil }
	r := c.expect("POST", api+"/settings/ai/models", `{"providerId":"`+id+`"}`, 200)
	if res := r.json(t); fmt.Sprint(res["models"]) != "[claude-a]" || res["error"] != nil || len(res) != 2 {
		t.Errorf("listed: %s", r.body)
	}
	c.ai.ListModelsFunc = func() ([]string, error) { return nil, nil }
	if r := c.expect("POST", api+"/settings/ai/models", `{"providerId":"`+id+`"}`, 200); !strings.Contains(string(r.body), `"models":[]`) {
		t.Errorf("empty list: %s", r.body)
	}
	c.ai.ListModelsFunc = func() ([]string, error) { return nil, fmt.Errorf("unavailable") }
	r = c.expect("POST", api+"/settings/ai/models", `{"providerId":"`+id+`"}`, 200)
	if res := r.json(t); !strings.Contains(string(r.body), `"models":null`) || res["error"] == nil {
		t.Errorf("failing list: %s", r.body)
	}
	c.expect("POST", api+"/settings/ai/models", `{}`, 422)
	c.expect("GET", api+"/settings/ai/models", "", 405)
}

func TestStylesAndAILogEndpoints(t *testing.T) {
	c := newServer(t)
	c.expect("POST", api+"/drafts", `{"kind":"capture","generate":{"text":"x"}}`, 503)
	c.defaultProvider()
	p := c.expect("POST", api+"/styles", `{"name":"House","instructions":"HOUSE-STYLE","isDefault":true}`, 201).json(t)
	c.expect("POST", api+"/styles", `{"name":"house","instructions":"x"}`, 422)
	if list := c.expect("GET", api+"/styles", "", 200).json(t); len(list["items"].([]any)) != 1 {
		t.Errorf("styles: %v", list)
	}
	c.expect("PATCH", api+"/styles/"+p["id"].(string), `{"isDefault":false}`, 200)
	c.expect("PATCH", api+"/styles/nope", `{"isDefault":false}`, 404)
	c.expect("DELETE", api+"/styles/"+p["id"].(string), "", 204)
	c.expect("DELETE", api+"/styles/"+p["id"].(string), "", 404)

	// Three generations for the log, the last one failing.
	c.ai.Respond = readingAnswer
	for range 2 {
		d := c.expect("POST", api+"/drafts", `{"kind":"capture","generate":{"text":"x"}}`, 202).json(t)
		if status, _, _ := c.jobOutcome(jobOf(d)); status != "succeeded" {
			t.Fatalf("generation: %s", status)
		}
	}
	c.ai.Respond = func(ai.GenerateRequest) (any, error) { return nil, ai.Errorf(500, "provider exploded") }
	d := c.expect("POST", api+"/drafts", `{"kind":"capture","generate":{"text":"x"}}`, 202).json(t)
	if status, _, code := c.jobOutcome(jobOf(d)); status != "failed" || code != "upstream_error" {
		t.Errorf("failed generation: %s %s", status, code)
	}

	page := c.expect("GET", api+"/settings/ai/log?limit=2", "", 200).json(t)
	items := page["items"].([]any)
	if page["total"] != float64(3) || len(items) != 2 || page["next"] == nil {
		t.Fatalf("log page: %v", page)
	}
	first := items[0].(map[string]any)
	if first["request"] != nil || first["usage"] == nil {
		t.Errorf("entry: %v", first)
	}
	if detail := c.expect("GET", api+"/settings/ai/log/"+first["id"].(string), "", 200).json(t); detail["request"] == nil {
		t.Errorf("detail: %v", detail)
	}
	if next := c.expect("GET", api+"/settings/ai/log?limit=2&before="+page["next"].(string), "", 200).json(t); len(next["items"].([]any)) != 1 || next["next"] != nil {
		t.Errorf("second page: %v", next)
	}
	if second := c.expect("GET", api+"/settings/ai/log?limit=2&offset=2", "", 200).json(t); len(second["items"].([]any)) != 1 || second["total"] != float64(3) {
		t.Errorf("offset page: %v", second)
	}
	for _, q := range []string{"offset=-1", "offset=x", "limit=x", "limit=0", "limit=201", "offset=0&before=" + page["next"].(string), "before=garbage"} {
		c.expect("GET", api+"/settings/ai/log?"+q, "", 400)
	}
	c.expect("GET", api+"/settings/ai/log/nope", "", 404)
	c.expect("DELETE", api+"/settings/ai/log?before=nonsense", "", 400)
	c.expect("DELETE", api+"/settings/ai/log", "", 204)
	if page := c.expect("GET", api+"/settings/ai/log", "", 200).json(t); page["total"] != float64(0) {
		t.Errorf("cleared: %v", page)
	}
}

// Every route that starts a generation takes providerId: a ready one starts
// the job, one of the wrong type is 422 on the field.
func TestAIRoutesTakeAProvider(t *testing.T) {
	c := newServer(t)
	c.defaultProvider()
	other := c.expect("POST", api+"/settings/ai/providers", `{"name":"Other","kind":"anthropic","apiKey":"sk-ant-other-2222"}`, 201).json(t)["id"].(string)
	reading := c.expect("POST", api+"/items", `{"type":"reading","title":"R","body":"b"}`, 201).json(t)["id"].(string)
	problem := c.expect("POST", api+"/items", `{"type":"problem","title":"P","problem":{"referenceSolution":{"language":"python","source":"sum"}},
		"testCases":[{"stdin":"1 2","expectedStdout":"3","isSample":true}]}`, 201).json(t)["id"].(string)
	cases := map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "sum"},
		"cases": []map[string]any{{"name": "n", "rationale": "r", "stdin": "7 7", "predictedStdout": "14"}}}
	code := map[string]any{"code": []map[string]string{{"language": "python", "starterCode": "x", "prefix": "", "suffix": ""}}}
	routes := []struct {
		path, body string // body has a %s for the providerId member
		answer     any
	}{
		{api + "/drafts", `{"kind":"capture","generate":{"text":"x"%s}}`, nil},
		{api + "/drafts", `{"kind":"variant","variantOf":"` + reading + `","generate":{"mode":"similar"%s}}`, nil},
		{api + "/items/" + problem + "/ai/testcases", `{"count":1%s}`, cases},
		{api + "/ai/code", `{"body":"x","languages":["python"]%s}`, code},
	}
	for _, r := range routes {
		answer := r.answer
		c.ai.Respond = func(req ai.GenerateRequest) (any, error) {
			if answer == nil {
				return readingAnswer(req)
			}
			return answer, nil
		}
		started := c.expect("POST", r.path, fmt.Sprintf(r.body, `,"providerId":"`+other+`"`), 202).json(t)
		c.waitJob(jobOf(started))
		c.expectField("POST", r.path, fmt.Sprintf(r.body, `,"providerId":5`), "providerId")
	}
}

// POST /ai/code starts a code job.
func TestCodeEndpoint(t *testing.T) {
	c := newServer(t)
	form := `"title":"Coin Change","body":"## Input\n\nn and amount.","languages":["python","cpp"],"samples":[{"stdin":"3 11\n1 2 5\n","expectedStdout":"3\n"}]`
	if r := c.expect("POST", api+"/ai/code", `{`+form+`}`, 503); r.errorCode(t) != "ai_unavailable" {
		t.Errorf("without a provider: %s", r.body)
	}
	c.expectField("POST", api+"/ai/code", `{"body":"x","languages":"python"}`, "languages")
	c.expect("GET", api+"/ai/code", "", 405)
	c.defaultProvider()
	c.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{"code": []map[string]string{{"language": "python", "starterCode": "sum", "prefix": "", "suffix": ""}}}, nil
	}
	j := c.expect("POST", api+"/ai/code", `{`+form+`}`, 202).json(t)
	for _, k := range []string{"id", "kind", "itemId", "draftId", "title", "status", "origin", "error", "pickedUp", "createdAt", "startedAt", "finishedAt"} {
		if _, ok := j[k]; !ok {
			t.Errorf("AiJob lacks %s: %v", k, j)
		}
	}
	if j["kind"] != "code" || j["status"] != "queued" || j["draftId"] != nil || j["itemId"] != nil {
		t.Errorf("job: %v", j)
	}
	status, res, _ := c.jobOutcome(j["id"].(string))
	sc, _ := res["starterCode"].(map[string]any)
	h, _ := res["harness"].(map[string]any)
	if status != "succeeded" || sc["python"] != "sum" || h == nil || len(h) != 0 || res["check"] != nil || res["style"] != nil {
		t.Errorf("result: %s %v", status, res)
	}
	if u, _ := res["usage"].(map[string]any); u["logId"] == nil {
		t.Errorf("usage: %v", res["usage"])
	}
}

func TestSubmissionsEndpoints(t *testing.T) {
	c := newServer(t)
	id := c.expect("POST", api+"/items", `{"type":"problem","title":"P","testCases":[{"stdin":"1 2","expectedStdout":"3","isSample":true}]}`, 201).json(t)["id"].(string)
	sub := c.expect("POST", api+"/items/"+id+"/submissions", `{"language":"python","source":"sum","mode":"submit"}`, 202).json(t)
	if v, ok := sub["finishedAt"]; sub["status"] != "queued" || sub["verdict"] != nil || !ok || v != nil || sub["lineOffset"] != float64(0) {
		t.Errorf("queued: %v", sub)
	}
	done := c.waitSubmission(sub["id"].(string))
	if done["verdict"] != "accepted" || len(done["results"].([]any)) != 1 || done["lineOffset"] != float64(0) {
		t.Errorf("completed: %v", done)
	}
	c.waitSubmission(c.expect("POST", api+"/items/"+id+"/submissions", `{"language":"python","source":"sum","mode":"submit"}`, 202).json(t)["id"].(string))
	page := c.expect("GET", api+"/items/"+id+"/submissions?mode=submit", "", 200).json(t)
	all := page["items"].([]any)
	s0 := all[0].(map[string]any)
	if page["total"] != float64(2) || len(all) != 2 || s0["source"] != nil || s0["results"] != nil || s0["lineOffset"] != float64(0) {
		t.Errorf("summaries omit source and results: %v", page)
	}
	p := c.expect("GET", api+"/items/"+id+"/submissions?mode=submit&limit=1&offset=1", "", 200).json(t)
	if l := p["items"].([]any); p["total"] != float64(2) || len(l) != 1 || l[0].(map[string]any)["id"] != all[1].(map[string]any)["id"] {
		t.Errorf("limit and offset: %v", p)
	}
	for _, q := range []string{"limit=x", "offset=y", "limit=0", "offset=-1"} {
		c.expect("GET", api+"/items/"+id+"/submissions?"+q, "", 400)
	}
	c.expect("GET", api+"/submissions/nope", "", 404)

	chk0 := c.expect("POST", api+"/items/check", `{"type":"problem","title":"x","problem":{"referenceSolution":{"language":"python","source":"sum"}},
		"testCases":[{"stdin":"1 2","expectedStdout":"3"},{"stdin":"2 2","expectedStdout":"5"}]}`, 200)
	chk := chk0.json(t)
	if ch, _ := chk["check"].(map[string]any); ch["attempted"] != true || ch["total"] != float64(2) ||
		!strings.Contains(string(chk0.body), `"largeCases":[]`) {
		t.Errorf("item check: %s", chk0.body)
	}
	if v, _ := chk["cases"].([]any); len(v) != 2 || v[0].(map[string]any)["outcome"] == nil {
		t.Errorf("cases: %v", chk["cases"])
	} else if _, ok := v[0].(map[string]any)["error"]; !ok {
		t.Errorf("cases: %v", chk["cases"])
	}
	c.expect("POST", api+"/items/check", `{"type":"reading","title":"x"}`, 422)
}

// The test-case endpoints, each once.
func TestTestCaseEndpoints(t *testing.T) {
	c := newServer(t)
	id := c.expect("POST", api+"/items", `{"type":"problem","title":"P"}`, 201).json(t)["id"].(string)
	tc := c.expect("POST", api+"/items/"+id+"/testcases", `{"name":"a","stdin":"1 2","expectedStdout":"3"}`, 201).json(t)
	for _, k := range []string{"id", "itemId", "position", "name", "stdin", "expectedStdout", "isSample", "origin", "verified", "generator", "createdAt", "updatedAt"} {
		if _, ok := tc[k]; !ok {
			t.Errorf("TestCase lacks %s: %v", k, tc)
		}
	}
	if len(tc) != 12 || tc["itemId"] != id || tc["name"] != "a" || tc["generator"] != nil {
		t.Errorf("created: %v", tc)
	}
	a := tc["id"].(string)
	c.expectField("POST", api+"/items/"+id+"/testcases", `{"stdin":5,"expectedStdout":"x"}`, "stdin")
	c.expect("POST", api+"/items/nope/testcases", `{"expectedStdout":"x"}`, 404)
	bulk := c.expect("POST", api+"/items/"+id+"/testcases/bulk", `{"cases":[{"name":"b","expectedStdout":"x"},{"name":"c","expectedStdout":"y"}]}`, 200).json(t)
	if l := bulk["items"].([]any); len(l) != 3 {
		t.Fatalf("bulk: %v", bulk)
	}
	names := func(m map[string]any) (string, []string) {
		var ns, ids []string
		for _, x := range m["items"].([]any) {
			ns = append(ns, x.(map[string]any)["name"].(string))
			ids = append(ids, x.(map[string]any)["id"].(string))
		}
		return strings.Join(ns, ","), ids
	}
	got, ids := names(c.expect("GET", api+"/items/"+id+"/testcases", "", 200).json(t))
	if got != "a,b,c" {
		t.Errorf("list: %s", got)
	}
	order := `{"ids":["` + ids[2] + `","` + ids[0] + `","` + ids[1] + `"]}`
	if got, _ := names(c.expect("PUT", api+"/items/"+id+"/testcases/order", order, 200).json(t)); got != "c,a,b" {
		t.Errorf("order: %s", got)
	}
	c.expect("PUT", api+"/items/"+id+"/testcases/order", `{"ids":["nope"]}`, 422)
	if got := c.expect("PATCH", api+"/testcases/"+a, `{"name":"renamed"}`, 200).json(t); got["name"] != "renamed" || got["id"] != a {
		t.Errorf("PATCH: %v", got)
	}
	c.expect("PATCH", api+"/testcases/nope", `{"name":"x"}`, 404)
	c.expect("DELETE", api+"/testcases/"+a, "", 204)
	c.expect("DELETE", api+"/testcases/"+a, "", 404)
	c.expect("PATCH", api+"/testcases/"+a, `{"name":"x"}`, 404)
	reading := c.expect("POST", api+"/items", `{"type":"reading","title":"R"}`, 201).json(t)["id"].(string)
	c.expect("GET", api+"/items/"+reading+"/testcases", "", 422)
}

func multipartBody(t *testing.T, data []byte, strategy string) (string, *bytes.Buffer) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if strategy != "" {
		mw.WriteField("strategy", strategy)
	}
	if data != nil {
		fw, _ := mw.CreateFormFile("file", "b.codeatrophy.zip")
		fw.Write(data)
	}
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
	c.expect("POST", api+"/export", `{"scope":"everything"}`, 422)
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
	if r := other.upload(api+"/import", nil, "overwrite"); r.status != 400 || r.errorCode(t) != "bad_request" {
		t.Errorf("no file part: %d %s", r.status, r.body)
	}
	if r := other.upload(api+"/import", r.body, "merge"); r.status != 422 {
		t.Errorf("unknown strategy: %d", r.status)
	}
}

// The favorite and uncollected filters are read from the query.
func TestItemBooleanFilters(t *testing.T) {
	c := newServer(t)
	col := c.expect("POST", api+"/collections", `{"name":"Top"}`, 201).json(t)["id"].(string)
	a := c.expect("POST", api+"/items", `{"type":"reading","title":"A","favorite":true}`, 201).json(t)["id"].(string)
	b := c.expect("POST", api+"/items", `{"type":"reading","title":"B","collectionIds":["`+col+`"]}`, 201).json(t)["id"].(string)
	for q, want := range map[string]string{"favorite=true": a, "favorite=1": a, "favorite=false": b, "uncollected=true": a} {
		items := c.expect("GET", api+"/items?"+q, "", 200).json(t)["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["id"] != want {
			t.Errorf("%s: %v", q, items)
		}
	}
	for _, q := range []string{"favorite=maybe", "uncollected=2", "recursive=x"} {
		c.expect("GET", api+"/items?"+q, "", 400)
	}
}

func TestCollectionsAndTagsEndpoints(t *testing.T) {
	c := newServer(t)
	a := c.expect("POST", api+"/collections", `{"name":"A"}`, 201).json(t)["id"].(string)
	b := c.expect("POST", api+"/collections", `{"name":"B","parentId":"`+a+`"}`, 201).json(t)["id"].(string)
	if got := c.expect("GET", api+"/collections/"+b, "", 200).json(t); got["id"] != b || got["name"] != "B" || got["parentId"] != a ||
		got["itemCount"] != float64(0) {
		t.Errorf("GET collection: %v", got)
	}
	c.expect("GET", api+"/collections/nope", "", 404)
	if r := c.expect("PATCH", api+"/collections/"+a, `{"parentId":"`+b+`"}`, 409); r.errorCode(t) != "conflict" {
		t.Errorf("cycle: %s", r.body)
	}
	c.expect("PATCH", api+"/collections/nope", `{"name":"x"}`, 404)
	item := c.expect("POST", api+"/items", `{"type":"reading","title":"R","tags":["c++ systems"]}`, 201).json(t)["id"].(string)
	if got := c.expect("PUT", api+"/collections/"+a+"/items", `{"itemIds":["`+item+`"]}`, 200).json(t); fmt.Sprint(got["itemIds"]) != "["+item+"]" {
		t.Errorf("set items: %v", got)
	}
	// itemIds is required: missing or null is refused and changes nothing;
	// [] clears the membership.
	c.expectField("PUT", api+"/collections/"+a+"/items", `{}`, "itemIds")
	c.expectField("PUT", api+"/collections/"+a+"/items", `{"itemIds":null}`, "itemIds")
	if got := c.expect("GET", api+"/collections/"+a+"/items", "", 200).json(t); fmt.Sprint(got["itemIds"]) != "["+item+"]" {
		t.Errorf("a refused set changed the items: %v", got)
	}
	if r := c.expect("PUT", api+"/collections/"+a+"/items", `{"itemIds":[]}`, 200); !strings.Contains(string(r.body), `"itemIds":[]`) {
		t.Errorf("set no items: %s", r.body)
	}
	// Adding needs itemIds too; [] adds nothing.
	c.expectField("POST", api+"/collections/"+a+"/items", `{}`, "itemIds")
	c.expectField("POST", api+"/collections/"+a+"/items", `{"itemIds":null}`, "itemIds")
	if r := c.expect("POST", api+"/collections/"+a+"/items", `{"itemIds":[]}`, 200); !strings.Contains(string(r.body), `"itemIds":[]`) {
		t.Errorf("add no items: %s", r.body)
	}
	if got := c.expect("POST", api+"/collections/"+a+"/items", `{"itemIds":["`+item+`"]}`, 200).json(t); fmt.Sprint(got["itemIds"]) != "["+item+"]" {
		t.Errorf("add items: %v", got)
	}
	c.expect("DELETE", api+"/collections/"+a+"/items/"+item, "", 204)
	if list := c.expect("GET", api+"/collections", "", 200).json(t); len(list["items"].([]any)) != 2 {
		t.Errorf("collections: %v", list)
	}
	if members := c.expect("GET", api+"/collections/"+a+"/items", "", 200).json(t); len(members["itemIds"].([]any)) != 0 {
		t.Errorf("GET collection items: %v", members)
	}
	c.expect("GET", api+"/collections/nope/items", "", 404)
	// Tag names are URL-encoded in the path.
	if r := c.expect("PATCH", api+"/tags/c%2B%2B%20systems", `{"name":"systems"}`, 200).json(t); r["name"] != "systems" || r["count"] != float64(1) {
		t.Errorf("rename: %v", r)
	}
	c.expect("PATCH", api+"/tags/c%2B%2B%20systems", `{"name":"x"}`, 404)
	if tags := c.expect("GET", api+"/tags", "", 200).json(t)["items"].([]any); len(tags) != 1 || tags[0].(map[string]any)["name"] != "systems" {
		t.Errorf("tags: %v", tags)
	}
	c.expect("DELETE", api+"/tags/systems", "", 204)
	c.expect("DELETE", api+"/tags/systems", "", 404)
	c.expect("DELETE", api+"/collections/"+a, "", 204)
	c.expect("DELETE", api+"/collections/"+a, "", 404)
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
	for _, host := range []string{"localhost", "localhost:8081", "127.0.0.1:9", "[::1]:8484", "app.localhost", "lan.example:8484", "BOX.home.arpa"} {
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
	// The UI itself is served for any host.
	if r := c.hostDo("GET", "/", "evil.example"); r.status != 200 {
		t.Errorf("UI: %d", r.status)
	}
	// The UI opened at an allowed host may write.
	if r := c.do("POST", api+"/items", `{"type":"reading","title":"x"}`, "Origin", "http://lan.example:8484", "Sec-Fetch-Site", "same-origin"); r.status != 201 {
		t.Errorf("allowed host origin: %d %s", r.status, r.body)
	}
	star := newServer(t, func(o *httpapi.Options) { o.AllowedHosts = []string{"*"} })
	if r := star.hostDo("GET", api+"/meta", "anything.example"); r.status != 200 {
		t.Errorf("* accepts any host: %d", r.status)
	}
	// With the Host check off, a forged same-origin write (an Origin matching
	// the forged Host) is still refused: the origin is compared with the
	// configured set, never with the Host header.
	r := star.hostDo("POST", api+"/items", "evil.example", "Origin", "http://evil.example")
	if r.status != 403 || r.errorCode(t) != "forbidden" ||
		!strings.Contains(r.json(t)["error"].(map[string]any)["message"].(string), "CODEATROPHY_ALLOWED_ORIGINS") {
		t.Errorf("forged same-origin POST with *: %d %s", r.status, r.body)
	}
}

// Solution endpoints map the service's outcomes to their statuses.
func TestSolutionsEndpoints(t *testing.T) {
	c := newServer(t)
	it := c.expect("POST", api+"/items", `{"type":"problem","title":"P","problem":{"referenceSolution":{"language":"python","source":"sum"}}}`, 201).json(t)
	id := it["id"].(string)
	ref := it["problem"].(map[string]any)["referenceSolution"].(map[string]any)
	if ref["id"] == nil || ref["language"] != "python" {
		t.Fatalf("referenceSolution view: %v", ref)
	}
	list := c.expect("GET", api+"/items/"+id+"/solutions", "", 200).json(t)["items"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["isReference"] != true {
		t.Fatalf("solutions: %v", list)
	}
	other := c.expect("POST", api+"/items/"+id+"/solutions", `{"name":"Brute force","language":"python","source":"echo","notes":"slow"}`, 201).json(t)
	if other["isReference"] != false || other["itemId"] != id {
		t.Errorf("created: %v", other)
	}
	sid := other["id"].(string)
	c.expect("PATCH", api+"/solutions/"+sid, `{"isReference":true,"expectedRevision":99}`, 409)
	c.expect("PATCH", api+"/solutions/"+sid, `{"isReference":true,"expectedRevision":1}`, 200)
	c.expect("PATCH", api+"/solutions/"+sid, `{"name":"two lines"}`, 422)
	c.expect("PATCH", api+"/solutions/nope", `{"name":"x"}`, 404)
	c.expect("POST", api+"/items/"+id+"/testcases/verify", `{"solutionId":"nope"}`, 422)
	c.expect("POST", api+"/items/"+id+"/testcases/verify", `{"solutionId":"`+list[0].(map[string]any)["id"].(string)+`"}`, 200)
	c.expect("DELETE", api+"/solutions/"+sid, "", 204)
	c.expect("DELETE", api+"/solutions/"+sid, "", 404)
	reading := c.expect("POST", api+"/items", `{"type":"reading","title":"R"}`, 201).json(t)["id"].(string)
	c.expect("GET", api+"/items/"+reading+"/solutions", "", 422)
}

func TestWorkingCopyEndpoints(t *testing.T) {
	c := newServer(t)
	it := c.expect("POST", api+"/items", `{"type":"problem","title":"P"}`, 201).json(t)
	id := it["id"].(string)
	ws := api + "/items/" + id + "/workspace"
	if r := c.expect("GET", ws, "", 200); strings.TrimSpace(string(r.body)) != `{"items":[]}` {
		t.Errorf("no working copies: %s", r.body)
	}
	py := c.expect("PUT", ws+"/python", `{"source":"x = 1\r\n"}`, 200).json(t)
	if len(py) != 3 || py["language"] != "python" || py["source"] != "x = 1\n" || py["updatedAt"] == nil {
		t.Errorf("put: %v", py)
	}
	c.expect("PUT", ws+"/cpp", `{"source":""}`, 200)
	c.expect("PUT", ws+"/python", `{"source":"x = 2"}`, 200)
	list := c.expect("GET", ws, "", 200).json(t)["items"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["language"] != "python" || list[0].(map[string]any)["source"] != "x = 2" ||
		list[1].(map[string]any)["source"] != "" {
		t.Errorf("list: %v", list)
	}
	if got := c.expect("GET", api+"/items/"+id, "", 200).json(t); got["revision"] != it["revision"] || got["updatedAt"] != it["updatedAt"] {
		t.Errorf("the item changed: revision %v, updatedAt %v", got["revision"], got["updatedAt"])
	}

	c.expectField("PUT", ws+"/python", `{}`, "source")
	c.expectField("PUT", ws+"/python", `{"source":null}`, "source")
	c.expectField("PUT", ws+"/python", `{"source":"`+strings.Repeat("x", 64<<10+1)+`"}`, "source")
	c.expectField("PUT", ws+"/python", `{"source":3}`, "source")
	c.expectField("PUT", ws+"/cobol", `{"source":"x"}`, "language")
	c.expectField("DELETE", ws+"/cobol", "", "language")
	c.expect("PUT", ws+"/python", `{"source":`, 400)

	c.expect("DELETE", ws+"/python", "", 204)
	c.expect("DELETE", ws+"/python", "", 204)
	if list := c.expect("GET", ws, "", 200).json(t)["items"].([]any); len(list) != 1 {
		t.Errorf("after deleting python: %v", list)
	}

	reading := c.expect("POST", api+"/items", `{"type":"reading","title":"R"}`, 201).json(t)["id"].(string)
	missing := api + "/items/00000000-0000-4000-8000-000000000000/workspace"
	for _, base := range []string{api + "/items/" + reading + "/workspace", missing} {
		status := 422
		if base == missing {
			status = 404
		}
		c.expect("GET", base, "", status)
		c.expect("PUT", base+"/python", `{"source":"x"}`, status)
		c.expect("DELETE", base+"/python", "", status)
	}

	for path, allow := range map[string]string{ws: "GET", ws + "/python": "PUT, DELETE"} {
		r := c.expect("POST", path, `{}`, 405)
		if r.header.Get("Allow") != allow || r.errorCode(t) != "bad_request" {
			t.Errorf("POST %s: Allow %q, %s", path, r.header.Get("Allow"), r.body)
		}
	}

	c.expect("DELETE", api+"/items/"+id, "", 204)
	c.expect("GET", ws, "", 404)
}

// A solution's lastRun is null until it runs, then carries the run's figures.
func TestSolutionLastRun(t *testing.T) {
	c := newServer(t)
	id := c.expect("POST", api+"/items", `{"type":"problem","title":"P","testCases":[
		{"stdin":"1 2","expectedStdout":"3","isSample":true},{"stdin":"5 5","expectedStdout":"11"}]}`, 201).json(t)["id"].(string)
	sol := c.expect("POST", api+"/items/"+id+"/solutions", `{"name":"Sum","language":"python","source":"sum"}`, 201).json(t)
	if v, ok := sol["lastRun"]; !ok || v != nil {
		t.Errorf("a new solution's lastRun: %v", sol)
	}
	res := c.expect("POST", api+"/items/"+id+"/testcases/verify", `{"solutionId":"`+sol["id"].(string)+`"}`, 200).json(t)
	r := res["results"].([]any)[0].(map[string]any)
	for _, k := range []string{"timeMs", "memoryKb"} {
		if _, ok := r[k]; !ok {
			t.Errorf("a verify result lacks %s: %v", k, r)
		}
	}
	run, _ := c.expect("GET", api+"/items/"+id+"/solutions", "", 200).json(t)["items"].([]any)[0].(map[string]any)["lastRun"].(map[string]any)
	for _, k := range []string{"passed", "total", "timeMs", "memoryKb", "ranAt"} {
		if _, ok := run[k]; !ok {
			t.Errorf("lastRun lacks %s: %v", k, run)
		}
	}
	if len(run) != 5 {
		t.Errorf("lastRun after a verify: %v", run)
	}
}

// TestPreferencesEndpoints is the only test of the preference rules; they
// belong with the service's tests.
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
	for _, bad := range []struct{ body, field string }{
		{`{"editor":{"tabSize":3}}`, "editor.tabSize"}, {`{"editor":{"fontSize":25}}`, "editor.fontSize"}, {`{"theme":"dark"}`, "theme"},
		{`{"editor":{"tabSize":8,"vim":true}}`, "editor.vim"}, {`{"hideTestCases":"yes"}`, "hideTestCases"}, {`{"editor":true}`, "editor"},
		{`{"generatedTestCases":0}`, "generatedTestCases"}, {`{"generatedTestCases":31}`, "generatedTestCases"},
	} {
		c.expectField("PUT", api+"/settings/preferences", bad.body, bad.field)
	}
	// A body that is not an object is malformed.
	c.expect("PUT", api+"/settings/preferences", `[]`, 400)
	// Nothing from a rejected request is saved.
	if got := c.expect("GET", api+"/settings/preferences", "", 200).json(t); got["editor"].(map[string]any)["tabSize"] != float64(2) {
		t.Errorf("a rejected PUT changed something: %v", got)
	}
}

func TestPromptEndpoints(t *testing.T) {
	c := newServer(t)
	for path, keys := range map[string]int{api + "/settings/ai/system-prompt": 6, api + "/settings/ai/testcase-prompt": 4} {
		def := c.expect("GET", path, "", 200).json(t)
		if v, ok := def["custom"]; len(def) != keys || def["isCustom"] != false || !ok || v != nil || def["builtIn"] == "" ||
			!strings.HasPrefix(def["fixed"].(string), "# Fixed rules") {
			t.Errorf("%s built-in: %v", path, def)
		}
		got := c.expect("PUT", path, `{"custom":"My rules"}`, 200).json(t)
		if got["isCustom"] != true || got["custom"] != "My rules" {
			t.Errorf("%s set: %v", path, got)
		}
		c.expectField("PUT", path, `{"custom":1}`, "custom")
		c.expectField("PUT", path, `{}`, "custom")
		c.expect("DELETE", path, "", 204)
		if got := c.expect("GET", path, "", 200).json(t); got["isCustom"] != false || got["custom"] != nil {
			t.Errorf("%s after reset: %v", path, got)
		}
	}
}

// A request whose client has gone away is not reported as a server error.
func TestCanceledRequestIsNotAnInternalError(t *testing.T) {
	c := newServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, path := range []string{api + "/meta", api + "/items/00000000-0000-4000-8000-000000000001", api + "/items"} {
		req := httptest.NewRequest("GET", path, nil).WithContext(ctx)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		c.h.ServeHTTP(rec, req)
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
	c.defaultProvider()
	c.ai.Respond = readingAnswer
	c.expectField("POST", api+"/drafts", `{"kind":"capture","generate":{"text":""}}`, "text")
	d := c.expect("POST", api+"/drafts", `{"kind":"capture","generate":{"text":"some notes"}}`, 202).json(t)
	id := d["id"].(string)
	job := d["job"].(map[string]any)
	if job["draftId"] != id || job["kind"] != "draft" {
		t.Errorf("started: %v", d)
	}
	c.waitJob(job["id"].(string))
	got := c.expect("GET", api+"/drafts/"+id, "", 200).json(t)
	if _, ok := got["generation"].(map[string]any); !ok {
		t.Errorf("generated: %v", got)
	}
	// Lists carry summaries: no generation, no job result.
	list := c.expect("GET", api+"/drafts", "", 200).json(t)["items"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["generation"] != nil || list[0].(map[string]any)["id"] != id {
		t.Errorf("list: %v", list)
	}
	jobs := c.expect("GET", api+"/ai/jobs?draftId="+id, "", 200).json(t)["items"].([]any)
	if len(jobs) != 1 || jobs[0].(map[string]any)["result"] != nil {
		t.Errorf("jobs: %v", jobs)
	}
	rev := c.expect("PATCH", api+"/drafts/"+id, `{"basedOn":1,"content":{"form":{}}}`, 200).json(t)["revision"].(float64)
	if r := c.expect("PATCH", api+"/drafts/"+id, `{"edited":true,"expectedRevision":`+fmt.Sprint(rev-1)+`}`, 409); r.fields(t)["revision"] != rev {
		t.Errorf("conflict: %s", r.body)
	}
	c.expect("PATCH", api+"/drafts/nope", `{"edited":true}`, 404)
	c.waitJob(jobOf(c.expect("POST", api+"/drafts/"+id+"/generate", `{"text":"again","instruction":"shorter"}`, 202).json(t)))
	c.expect("POST", api+"/drafts/"+id+"/retry", "", 202)
	c.expect("POST", api+"/drafts/"+id+"/save", `{"item":{"type":"reading"}}`, 422)
	c.waitJob(jobOf(c.expect("GET", api+"/drafts/"+id, "", 200).json(t)))
	it := c.expect("POST", api+"/drafts/"+id+"/save", `{"item":{"type":"reading","title":"Kept"}}`, 201).json(t)
	if it["title"] != "Kept" {
		t.Errorf("saved: %v", it)
	}
	c.expect("GET", api+"/drafts/"+id, "", 404)
	c.expect("GET", api+"/items/"+it["id"].(string), "", 200)

	// A variant draft, written by hand, then discarded.
	v := c.expect("POST", api+"/drafts", `{"kind":"variant","variantOf":"`+it["id"].(string)+`","content":{}}`, 201).json(t)
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
	jid := c.expect("POST", api+"/ai/code", `{"body":"x","languages":["python"]}`, 202).json(t)["id"].(string)
	c.waitJob(jid)
	detail := c.expect("GET", api+"/ai/jobs/"+jid, "", 200).json(t)
	if detail["result"].(map[string]any)["starterCode"] == nil || detail["request"].(map[string]any)["body"] != "x" {
		t.Errorf("detail: %v", detail)
	}
	c.expect("POST", api+"/ai/jobs/"+jid+"/cancel", "", 200)
	if p := c.expect("POST", api+"/ai/jobs/"+jid+"/pickup", "", 200).json(t); p["pickedUp"] != true || p["result"] == nil {
		t.Errorf("picked up: %v", p)
	}
	if l := c.expect("GET", api+"/ai/jobs?pickedUp=true&kind=code&active=false&limit=5", "", 200).json(t)["items"].([]any); len(l) != 1 {
		t.Errorf("picked-up jobs: %v", l)
	}
	for _, q := range []string{"active=maybe", "pickedUp=2", "limit=0", "limit=x", "kind=chat"} {
		c.expect("GET", api+"/ai/jobs?"+q, "", 400)
	}
	c.expect("DELETE", api+"/ai/jobs/"+jid, "", 204)
	c.expect("GET", api+"/ai/jobs/"+jid, "", 404)
	c.expect("POST", api+"/ai/jobs/"+jid+"/cancel", "", 404)
	c.expect("POST", api+"/ai/jobs/"+jid+"/pickup", "", 404)
	c.expect("DELETE", api+"/ai/jobs/"+jid, "", 404)
}
