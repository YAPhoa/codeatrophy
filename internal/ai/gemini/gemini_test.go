package gemini

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/ai/aitest"
)

const key = "AIza-test-verysecret"

// models serves native-shaped model pages from pages, keyed by page token
// ("" for the first), and records each request.
type models struct {
	pages    map[string]string
	status   int
	requests []*http.Request
}

func (m *models) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Path != "/v1beta/models" {
		http.NotFound(w, r)
		return
	}
	m.requests = append(m.requests, r)
	if m.status != 0 {
		w.WriteHeader(m.status)
	}
	fmt.Fprint(w, m.pages[r.URL.Query().Get("pageToken")])
}

func lister(t *testing.T, base string) ai.ModelLister {
	t.Helper()
	p, err := New(ai.Config{BaseURL: base, APIKey: key})
	if err != nil {
		t.Fatal(err)
	}
	return p.(ai.ModelLister)
}

// Only models that support generateContent are kept, without the models/
// prefix; entries without the field, or of an unexpected shape, are
// skipped.
func TestListModelsKeepsTextModels(t *testing.T) {
	m := &models{pages: map[string]string{"": `{"models":[
		{"name":"models/gemini-3.5-flash","supportedGenerationMethods":["generateContent","countTokens","createCachedContent"]},
		{"name":"models/gemini-embedding-002","supportedGenerationMethods":["embedContent","countTextTokens"]},
		{"name":"models/gemini-3.5-flash-tts","supportedGenerationMethods":["countTokens"]},
		{"name":"models/gemini-live-3.5","supportedGenerationMethods":["bidiGenerateContent"]},
		{"name":"models/imagen-5","supportedGenerationMethods":["predict"]},
		{"name":"models/no-methods"},
		{"name":"models/null-methods","supportedGenerationMethods":null},
		{"name":"models/string-methods","supportedGenerationMethods":"generateContent"},
		{"name":"models/odd-methods","supportedGenerationMethods":[7,null,"generateContent"]},
		{"name":7,"supportedGenerationMethods":["generateContent"]},
		{"supportedGenerationMethods":["generateContent"]},
		{"name":"models/","supportedGenerationMethods":["generateContent"]},
		"models/not-an-object",
		null,
		{"name":"gemma-5-27b-it","supportedGenerationMethods":["generateContent"]}
	]}`}}
	srv := httptest.NewServer(m)
	defer srv.Close()
	ids, err := lister(t, srv.URL+"/v1beta").ListModels(context.Background())
	if err != nil || strings.Join(ids, ",") != "gemini-3.5-flash,odd-methods,gemma-5-27b-it" {
		t.Errorf("ids %v, err %v", ids, err)
	}
}

// The key goes in the x-goog-api-key header, never in the URL, and pages
// are followed up to the cap.
func TestListModelsPagesWithTheKeyInAHeader(t *testing.T) {
	page := func(name, next string) string {
		return fmt.Sprintf(`{"models":[{"name":"models/%s","supportedGenerationMethods":["generateContent"]}],"nextPageToken":%q}`, name, next)
	}
	m := &models{pages: map[string]string{"": page("a", "t2"), "t2": page("b", "t3"), "t3": `{"models":[]}`}}
	srv := httptest.NewServer(m)
	defer srv.Close()
	ids, err := lister(t, srv.URL+"/v1beta/").ListModels(context.Background())
	if err != nil || strings.Join(ids, ",") != "a,b" || len(m.requests) != 3 {
		t.Fatalf("ids %v, err %v, %d requests", ids, err, len(m.requests))
	}
	for _, r := range m.requests {
		if r.Header.Get("x-goog-api-key") != key || r.Header.Get("Authorization") != "" {
			t.Errorf("headers: %v", r.Header)
		}
		if strings.Contains(r.URL.String(), key) || r.URL.Query().Has("key") || r.URL.Query().Get("pageSize") != "1000" {
			t.Errorf("URL: %s", r.URL)
		}
	}
	if m.requests[0].URL.Query().Has("pageToken") || m.requests[2].URL.Query().Get("pageToken") != "t3" {
		t.Errorf("page tokens: %s, %s", m.requests[0].URL, m.requests[2].URL)
	}

	// A service that always offers another page is read up to the cap.
	m = &models{pages: map[string]string{"": page("first", "again"), "again": page("again", "again")}}
	srv2 := httptest.NewServer(m)
	defer srv2.Close()
	ids, err = lister(t, srv2.URL+"/v1beta").ListModels(context.Background())
	if err != nil || len(m.requests) != maxModelListPages || len(ids) != maxModelListPages {
		t.Errorf("capped: %d requests, ids %v, err %v", len(m.requests), ids, err)
	}
	// An empty object is an empty page: Google leaves empty lists out.
	m = &models{pages: map[string]string{"": `{}`}}
	srv3 := httptest.NewServer(m)
	defer srv3.Close()
	if ids, err := lister(t, srv3.URL+"/v1beta").ListModels(context.Background()); err != nil || len(ids) != 0 {
		t.Errorf("empty: %v %v", ids, err)
	}
}

// The failures every lister reports the same way.
func TestListModelsFailures(t *testing.T) {
	aitest.CheckModelLister(t, aitest.ModelListService{
		Path: "/v1beta/models",
		Page: func(ids []string) string {
			models := make([]string, len(ids))
			for i, id := range ids {
				models[i] = `{"name":"models/` + id + `","supportedGenerationMethods":["generateContent"]}`
			}
			return `{"models":[` + strings.Join(models, ",") + `]}`
		},
		Key: key,
		New: func(t *testing.T, base string, client *http.Client) ai.ModelLister {
			p, err := New(ai.Config{BaseURL: base + "/v1beta", APIKey: key, HTTPClient: client})
			if err != nil {
				t.Fatal(err)
			}
			return p.(ai.ModelLister)
		},
		Unreachable: "could not reach the Gemini API: ",
		Cancelled:   "the request was cancelled",
	})
}

// Google answers an invalid key with 400 and the reason API_KEY_INVALID, and
// a key without access with 403; an answer that is not an object of models
// is not a model list.
func TestListModelsErrors(t *testing.T) {
	m := &models{pages: map[string]string{}}
	srv := httptest.NewServer(m)
	defer srv.Close()
	l := lister(t, srv.URL+"/v1beta")
	invalidKey := `{"error":{"code":400,"message":"API key not valid: ` + key + `","status":"INVALID_ARGUMENT",
		"details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}`
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{403, `{"error":{"message":"` + key + ` is not allowed"}}`, "rejected the API key"},
		{400, invalidKey, "rejected the API key"},
		{400, `{"error":{"message":"` + key + `"}}`, "HTTP 400"},
		{405, ``, "does not list its models"},
		{200, `<html>` + key + `</html>`, "not in the expected format"},
		{200, `[]`, "not in the expected format"},
		{200, `null`, "not in the expected format"},
		{200, `{"models":"` + key + `"}`, "not in the expected format"},
	} {
		m.status, m.pages[""] = c.status, c.body
		_, err := l.ListModels(context.Background())
		if err == nil || !strings.Contains(err.Error(), c.want) || strings.Contains(err.Error(), key) {
			t.Errorf("%d %.40s: %v", c.status, c.body, err)
		}
		want := c.status
		if want == 200 {
			want = 0
		}
		var pe *ai.Error
		if !errors.As(err, &pe) || pe.Status != want {
			t.Errorf("%d: status %v", c.status, err)
		}
	}

	// The size bound covers the pages together.
	half := `{"models":[{"name":"models/` + strings.Repeat("x", ai.MaxModelListBytes/2) + `"}],"nextPageToken":"n"}`
	m.status, m.pages[""], m.pages["n"] = 0, half, half
	if _, err := l.ListModels(context.Background()); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("two halves: %v", err)
	}
}

// cancelledBody is a response whose body fails as a read does once the
// request's context is cancelled.
type cancelledBody struct{}

func (cancelledBody) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Request: r,
		Body: io.NopCloser(iotest.ErrReader(fmt.Errorf("reading the body: %w", context.Canceled)))}, nil
}

// A request cancelled while its model list is read is reported as
// cancelled, as one cancelled before an answer is.
func TestListModelsCancelledWhileReading(t *testing.T) {
	p, err := New(ai.Config{APIKey: key, HTTPClient: &http.Client{Transport: cancelledBody{}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.(ai.ModelLister).ListModels(context.Background())
	if err == nil || err.Error() != "the request was cancelled" {
		t.Errorf("got %v", err)
	}
}

// Once the entry bound is reached no further page is asked for.
func TestListModelsEntryBound(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(`{"models":[`)
	for i := range ai.MaxModelListEntries + 10 {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, `{"name":"models/m%d","supportedGenerationMethods":["generateContent"]}`, i)
	}
	sb.WriteString(`],"nextPageToken":"more"}`)
	m := &models{pages: map[string]string{"": sb.String()}}
	srv := httptest.NewServer(m)
	defer srv.Close()
	ids, err := lister(t, srv.URL+"/v1beta").ListModels(context.Background())
	if err != nil || len(ids) != ai.MaxModelListEntries || len(m.requests) != 1 {
		t.Errorf("bounded: %d ids, %d requests, %v", len(ids), len(m.requests), err)
	}
}

// Generation goes to the OpenAI-compatible endpoint under the base URL,
// with the same model and key, and the provider reports itself as gemini.
func TestGenerateThroughTheOpenAIEndpoint(t *testing.T) {
	var path, auth string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, auth = r.URL.Path, r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&body)
		fmt.Fprint(w, `{"model":"gemini-3.5-flash","choices":[{"finish_reason":"stop","message":{"content":"{\"ok\": true}"}}],
			"usage":{"prompt_tokens":3,"completion_tokens":4}}`)
	}))
	defer srv.Close()
	for _, base := range []string{srv.URL + "/v1beta", srv.URL + "/v1beta/"} {
		p, err := New(ai.Config{Model: "gemini-3.5-flash", BaseURL: base, APIKey: key})
		if err != nil {
			t.Fatal(err)
		}
		if p.Name() != ai.ProviderGemini || p.Model() != "gemini-3.5-flash" {
			t.Errorf("name %q, model %q", p.Name(), p.Model())
		}
		resp, err := p.Generate(context.Background(), ai.GenerateRequest{System: "S", User: "U", Schema: ai.PingSchema(),
			Effort: ai.EffortLow})
		if err != nil || string(resp.JSON) != `{"ok": true}` || *resp.OutputTokens != 4 {
			t.Errorf("response: %+v %v", resp, err)
		}
		if path != "/v1beta/openai/chat/completions" || auth != "Bearer "+key || body["model"] != "gemini-3.5-flash" ||
			body["reasoning_effort"] != "low" {
			t.Errorf("request: %s %q %v %v", path, auth, body["model"], body["reasoning_effort"])
		}
	}
	// Without a model it can list but not generate.
	p, err := New(ai.Config{BaseURL: srv.URL, APIKey: key})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()}); err == nil ||
		!strings.Contains(err.Error(), "no model") {
		t.Errorf("generate without a model: %v", err)
	}
	for _, bad := range []string{"ftp://x", "not a url", "https://"} {
		if _, err := New(ai.Config{Model: "m", BaseURL: bad}); err == nil || !strings.Contains(err.Error(), "Gemini base URL") {
			t.Errorf("%s: %v", bad, err)
		}
	}
	// The default base URL is Google's.
	d, _ := New(ai.Config{APIKey: key})
	if g := d.(*Provider); g.baseURL != DefaultBaseURL {
		t.Errorf("default base URL: %s", g.baseURL)
	}
}
