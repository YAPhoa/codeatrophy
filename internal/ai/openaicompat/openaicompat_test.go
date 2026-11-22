package openaicompat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/ai/aitest"
)

func TestGenerateWithJSONSchema(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		auth = r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&got)
		fmt.Fprint(w, `{"model":"llama3","choices":[{"finish_reason":"stop","message":{"content":"`+"```json\\n{\\\"ok\\\": true}\\n```"+`"}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}`)
	}))
	defer srv.Close()
	p, err := New(ai.Config{Model: "llama3", BaseURL: srv.URL + "/v1/"})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := p.Generate(context.Background(), ai.GenerateRequest{System: "S", User: "U", Schema: ai.PingSchema(), SchemaName: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if string(resp.JSON) != `{"ok": true}` || resp.Model != "llama3" ||
		resp.OutputTokens == nil || *resp.OutputTokens != 4 || resp.InputTokens == nil || *resp.InputTokens != 3 {
		t.Errorf("response: %+v", resp)
	}
	if auth != "" {
		t.Error("no Authorization header without a key")
	}
	rf := got["response_format"].(map[string]any)
	js := rf["json_schema"].(map[string]any)
	if rf["type"] != "json_schema" || js["strict"] != true || js["name"] != "ping" {
		t.Errorf("response_format: %v", rf)
	}
	msgs := got["messages"].([]any)
	if msgs[0].(map[string]any)["role"] != "system" || msgs[1].(map[string]any)["content"] != "U" {
		t.Errorf("messages: %v", msgs)
	}
	if _, ok := got["reasoning_effort"]; ok {
		t.Errorf("reasoning_effort sent without an effort level: %v", got["reasoning_effort"])
	}
}

// The effort level is sent as reasoning_effort on every request, a light
// one and the JSON-mode retry included.
func TestReasoningEffort(t *testing.T) {
	var sent []any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		sent = append(sent, body["reasoning_effort"])
		if body["response_format"].(map[string]any)["type"] == "json_schema" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":{"message":"response_format json_schema is not supported"}}`)
			return
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"{\"ok\": true}"}}]}`)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{Model: "m", BaseURL: srv.URL})
	if _, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema(), Light: true, Effort: ai.EffortMedium}); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(sent) != "[medium medium]" {
		t.Errorf("reasoning_effort sent: %v", sent)
	}
}

func TestErrorsCarryTheServiceMessage(t *testing.T) {
	body := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, body)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{Model: "m", BaseURL: srv.URL, APIKey: "k"})
	for _, c := range []struct{ body, want string }{
		{`{"error":{"message":"The model is overloaded."}}`, "the provider returned HTTP 503: The model is overloaded."},
		// The same object inside an array, as some services send it.
		{`[{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}]`, "the provider returned HTTP 503: The model is overloaded."},
		{`[]`, "the provider returned HTTP 503"},
		{`upstream connect error`, "the provider returned HTTP 503"},
	} {
		body = c.body
		_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
		if err == nil || err.Error() != c.want {
			t.Errorf("%s: got %v, want %q", c.body, err, c.want)
		}
	}
}

func TestFallsBackToJSONMode(t *testing.T) {
	var formats []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		rf := body["response_format"].(map[string]any)
		formats = append(formats, rf["type"].(string))
		if rf["type"] == "json_schema" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":{"message":"response_format json_schema is not supported"}}`)
			return
		}
		sys := body["messages"].([]any)[0].(map[string]any)["content"].(string)
		if !strings.Contains(sys, "JSON Schema") {
			t.Error("the schema should be added to the system prompt")
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"Sure! {\"ok\": true}"}}]}`)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{Model: "m", BaseURL: srv.URL, APIKey: "k-123456"})
	resp, err := p.Generate(context.Background(), ai.GenerateRequest{System: "S", User: "U", Schema: ai.PingSchema()})
	if err != nil {
		t.Fatal(err)
	}
	if string(resp.JSON) != `{"ok": true}` || strings.Join(formats, ",") != "json_schema,json_object" {
		t.Errorf("got %s via %v", resp.JSON, formats)
	}
}

func TestErrorsNeverContainTheKey(t *testing.T) {
	const key = "sk-proj-verysecret"
	status := 401
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key {
			t.Error("bearer token missing")
		}
		w.WriteHeader(status)
		fmt.Fprintf(w, `{"error":{"message":"Incorrect API key provided: %s"}}`, key)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{Model: "m", BaseURL: srv.URL, APIKey: key})
	for _, s := range []int{401, 429, 500} {
		status = s
		_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
		if err == nil || strings.Contains(err.Error(), key) {
			t.Errorf("%d: %v", s, err)
		}
	}
	// A provider without a model can be constructed (to list models) but
	// cannot generate.
	np, err := New(ai.Config{BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := np.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()}); err == nil ||
		!strings.Contains(err.Error(), "no model") {
		t.Errorf("generate without a model: %v", err)
	}
	if _, err := New(ai.Config{Model: "m", BaseURL: "ftp://x"}); err == nil {
		t.Error("the base URL must be http(s)")
	}
}

func TestRefusalAndTruncation(t *testing.T) {
	reply := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, reply) }))
	defer srv.Close()
	p, _ := New(ai.Config{Model: "m", BaseURL: srv.URL})
	for body, want := range map[string]string{
		`{"choices":[{"message":{"content":null,"refusal":"I can't"}}]}`:        "declined",
		`{"choices":[{"finish_reason":"length","message":{"content":"{\"o"}}]}`: "cut off",
		`{"choices":[{"message":{"content":"no json here"}}]}`:                  "not valid JSON",
		`{"choices":[]}`: "no choices",
	} {
		reply = body
		_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", body, err)
		}
	}
}

func TestListModels(t *testing.T) {
	const key = "sk-proj-listsecret"
	var auth string
	status, body := 200, `{"object":"list","data":[{"id":"gpt-b"},{"id":"gpt-a"},{"id":7},{"object":"model"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		auth = r.Header.Get("Authorization")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	defer srv.Close()
	p, err := New(ai.Config{BaseURL: srv.URL + "/v1/", APIKey: key})
	if err != nil {
		t.Fatal(err)
	}
	lister := p.(ai.ModelLister)
	ids, err := lister.ListModels(context.Background())
	if err != nil || strings.Join(ids, ",") != "gpt-b,gpt-a" || auth != "Bearer "+key {
		t.Errorf("ids %v, err %v, auth %q", ids, err, auth)
	}
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{405, ``, "does not list"},
		{200, `<html>hello</html>`, "not in the expected format"},
		{200, `{"models":[]}`, "not in the expected format"},
	} {
		status, body = c.status, c.body
		_, err := lister.ListModels(context.Background())
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%d %.40s: %v", c.status, c.body, err)
		}
	}
}

// The failures every lister reports the same way.
func TestListModelsFailures(t *testing.T) {
	aitest.CheckModelLister(t, aitest.ModelListService{
		Path: "/v1/models",
		Page: func(ids []string) string {
			models := make([]string, len(ids))
			for i, id := range ids {
				models[i] = `{"id":"` + id + `","object":"model"}`
			}
			return `{"object":"list","data":[` + strings.Join(models, ",") + `]}`
		},
		Key: "sk-proj-listsecret",
		New: func(t *testing.T, base string, client *http.Client) ai.ModelLister {
			p, err := New(ai.Config{BaseURL: base + "/v1", APIKey: "sk-proj-listsecret", HTTPClient: client})
			if err != nil {
				t.Fatal(err)
			}
			return p.(ai.ModelLister)
		},
		Unreachable: "could not reach the AI provider: ",
		Cancelled:   "the request was cancelled",
	})
}

// A cancelled generation says it was cancelled, not that the provider could
// not be reached.
func TestGenerateCancelled(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{"model":"m","choices":[{"finish_reason":"stop","message":{"content":"{\"ok\": true}"}}]}`)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{Model: "m", BaseURL: srv.URL, APIKey: "k"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := p.Generate(ctx, ai.GenerateRequest{Schema: ai.PingSchema()})
	var pe *ai.Error
	if !errors.As(err, &pe) || err.Error() != "the request was cancelled" || pe.Status != 0 || calls.Load() != 0 {
		t.Errorf("cancelled: %v after %d calls", err, calls.Load())
	}

	// Cancelled while the provider is answering.
	started, release := make(chan struct{}), make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		// The server does not notice the client leave before the body is
		// read, so the handler is released when the test ends.
		<-release
	}))
	defer slow.Close()
	defer close(release)
	p, _ = New(ai.Config{Model: "m", BaseURL: slow.URL, APIKey: "k"})
	ctx, cancel = context.WithCancel(context.Background())
	go func() { <-started; cancel() }()
	_, err = p.Generate(ctx, ai.GenerateRequest{Schema: ai.PingSchema()})
	if !errors.As(err, &pe) || err.Error() != "the request was cancelled" || pe.Status != 0 {
		t.Errorf("cancelled while waiting: %v", err)
	}
}

// prompt_tokens includes the cached part, which is reported apart; the
// reasoning part of the completion comes from its details; a server that
// reports no usage leaves every count nil.
func TestGenerateReportsTheTokenBreakdown(t *testing.T) {
	usage := `,"usage":{"prompt_tokens":100,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":30},"completion_tokens_details":{"reasoning_tokens":25}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"model":"m","choices":[{"finish_reason":"stop","message":{"content":"{\"ok\": true}"}}]`+usage+`}`)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{Model: "m", BaseURL: srv.URL})
	resp, err := p.Generate(context.Background(), ai.GenerateRequest{System: "S", User: "U", Schema: ai.PingSchema()})
	if err != nil || *resp.InputTokens != 70 || *resp.CacheReadTokens != 30 || *resp.OutputTokens != 40 ||
		*resp.ReasoningTokens != 25 || resp.CacheWriteTokens != nil {
		t.Errorf("usage: %+v %v", resp, err)
	}
	usage = ""
	resp, err = p.Generate(context.Background(), ai.GenerateRequest{System: "S", User: "U", Schema: ai.PingSchema()})
	if err != nil || resp.InputTokens != nil || resp.OutputTokens != nil || resp.ReasoningTokens != nil || resp.CacheReadTokens != nil {
		t.Errorf("no usage: %+v %v", resp, err)
	}
}

// failingTransport fails every request with an error that names the key, as
// a proxy might.
type failingTransport struct{ key string }

func (f failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("proxy refused " + f.key)
}

// A request that gets no response says why, without the key, and one that
// runs out of time says so.
func TestGenerateWithoutAResponse(t *testing.T) {
	const key = "sk-proj-transportsecret"
	gen := func(cfg ai.Config) error {
		t.Helper()
		p, err := New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		_, err = p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
		var pe *ai.Error
		if !errors.As(err, &pe) || pe.Status != 0 {
			t.Fatalf("got %T %v, want an *ai.Error without a status", err, err)
		}
		return err
	}

	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	if err := gen(ai.Config{Model: "m", BaseURL: closed.URL, APIKey: key}); !strings.HasPrefix(err.Error(), "could not reach the AI provider: ") ||
		!strings.Contains(err.Error(), "connection refused") {
		t.Errorf("unreachable: %v", err)
	}

	err := gen(ai.Config{Model: "m", BaseURL: "http://provider.invalid", APIKey: key,
		HTTPClient: &http.Client{Transport: failingTransport{key}}})
	if err.Error() != "could not reach the AI provider: proxy refused [redacted]" {
		t.Errorf("transport error: %v", err)
	}

	done := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-done:
		}
	}))
	defer slow.Close()
	defer close(done)
	start := time.Now()
	if err := gen(ai.Config{Model: "m", BaseURL: slow.URL, APIKey: key, Timeout: 200 * time.Millisecond}); err.Error() != "the AI provider did not respond in time" {
		t.Errorf("timeout: %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("Generate took %s with a 200ms timeout", d.Round(time.Millisecond))
	}
}

// A 404 points at the base URL and the model, and is not retried in JSON
// mode; a success whose body is not JSON is reported as such.
func TestNotFoundAndABodyThatIsNotJSON(t *testing.T) {
	var calls atomic.Int32
	status, body := 0, ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{Model: "gpt-x", BaseURL: srv.URL})
	for _, c := range []struct {
		status     int
		body, want string
		wantStatus int
	}{
		{404, `{"error":{"message":"The model gpt-x does not exist."}}`,
			`the provider returned 404 (check the base URL and model "gpt-x"): The model gpt-x does not exist.`, 404},
		{404, `404 page not found`, `the provider returned 404 (check the base URL and model "gpt-x")`, 404},
		{200, `<html>a proxy's sign-in page</html>`, "the provider's response is not valid JSON", 0},
	} {
		status, body = c.status, c.body
		calls.Store(0)
		_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
		var pe *ai.Error
		if !errors.As(err, &pe) || err.Error() != c.want || pe.Status != c.wantStatus || calls.Load() != 1 {
			t.Errorf("%d %.30s: %v (status %v) after %d calls", c.status, c.body, err, pe, calls.Load())
		}
	}
}
