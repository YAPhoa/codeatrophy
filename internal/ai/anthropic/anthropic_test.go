package anthropic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/ai/aitest"
)

const testKey = "sk-ant-test-0000-secret"

// usage is the token counts a stream reports: those of message_start, and
// the cumulative ones of the final message_delta.
type usage struct{ start, end map[string]any }

// sse streams a message with text that stops for stopReason, reporting u, or
// 12 input and 7 output tokens when u is nil.
func sse(w http.ResponseWriter, text, stopReason string, u *usage) {
	if u == nil {
		u = &usage{start: map[string]any{"input_tokens": 12, "output_tokens": 1}, end: map[string]any{"output_tokens": 7}}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	ev := func(name string, v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
	}
	ev("message_start", map[string]any{"type": "message_start", "message": map[string]any{
		"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": []any{},
		"stop_reason": nil, "usage": u.start}})
	ev("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
	half := len(text) / 2
	for _, part := range []string{text[:half], text[half:]} {
		ev("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": part}})
	}
	ev("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	ev("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stopReason}, "usage": u.end})
	ev("message_stop", map[string]any{"type": "message_stop"})
}

// effortCapability is the part of a Models API answer that says the model
// accepts output_config.effort at the levels the provider uses.
const effortCapability = `"capabilities":{"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true}}}`

func TestGenerateStreamsStructuredOutput(t *testing.T) {
	var body map[string]any
	var headers http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"claude-opus-5-5","type":"model","display_name":"x","created_at":"2026-01-01T00:00:00Z","max_tokens":128000,"max_input_tokens":1000000,`+effortCapability+`}`)
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/v1/messages") {
			http.NotFound(w, r)
			return
		}
		headers = r.Header.Clone()
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &body)
		sse(w, `{"ok": true}`, "end_turn", nil)
	}))
	defer srv.Close()
	p, err := New(ai.Config{APIKey: testKey, BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if p.Model() != DefaultModel {
		t.Errorf("default model %q", p.Model())
	}
	schema := ai.PingSchema()
	resp, err := p.Generate(context.Background(), ai.GenerateRequest{System: "SYS", User: "USER", Schema: schema, Effort: ai.EffortHigh})
	if err != nil {
		t.Fatal(err)
	}
	if string(resp.JSON) != `{"ok": true}` || resp.Model != "claude-opus-5-5" ||
		resp.InputTokens == nil || *resp.InputTokens != 12 || resp.OutputTokens == nil || *resp.OutputTokens != 7 {
		t.Errorf("response: %+v", resp)
	}
	if headers.Get("Authorization") != "Bearer "+testKey && headers.Get("X-Api-Key") != testKey {
		t.Errorf("API key header missing: %v", headers)
	}
	if body["model"] != DefaultModel || body["stream"] != true || body["max_tokens"] != float64(64000) {
		t.Errorf("body: %v", body)
	}
	oc := body["output_config"].(map[string]any)
	if oc["effort"] != "high" || oc["format"].(map[string]any)["type"] != "json_schema" {
		t.Errorf("output_config: %v", oc)
	}
	if _, ok := body["thinking"]; ok {
		t.Error("thinking is left at the model default")
	}
	if _, ok := body["temperature"]; ok {
		t.Error("sampling parameters must not be sent")
	}
	sys := body["system"].([]any)[0].(map[string]any)
	msgs := body["messages"].([]any)
	if sys["text"] != "SYS" || !strings.Contains(fmt.Sprint(msgs), "USER") {
		t.Errorf("system/messages: %v %v", sys, msgs)
	}
	// Through a custom base URL (a proxy) no fallback beta is requested.
	if _, ok := body["fallbacks"]; ok || strings.Contains(headers.Get("Anthropic-Beta"), "fallback") {
		t.Error("fallbacks are only requested on the first-party API")
	}
}

func TestParamsFollowTheModelFacts(t *testing.T) {
	p, _ := New(ai.Config{APIKey: testKey})
	if !p.(*Provider).firstParty {
		t.Error("the default endpoint is the first-party API")
	}
	able := modelFacts{maxTokens: 128000, effortHigh: true, effortMedium: true, effortLow: true}
	params := p.(*Provider).params(ai.GenerateRequest{System: "s", User: "u", Schema: ai.PingSchema(), Light: true,
		Effort: ai.EffortHigh}, able, true)
	b, _ := json.Marshal(params)
	var m map[string]any
	json.Unmarshal(b, &m)
	if m["fallbacks"] != "default" {
		t.Errorf("fallbacks: %v", m["fallbacks"])
	}
	if len(params.Betas) != 1 || params.Betas[0] != "server-side-fallback-2026-07-01" {
		t.Errorf("betas: %v", params.Betas)
	}
	if m["max_tokens"] != float64(4096) || m["output_config"].(map[string]any)["effort"] != "low" {
		t.Errorf("light request: %v", m)
	}
	// A model that reports no effort support, asked without the fallback,
	// gets neither — whatever it is called.
	b, _ = json.Marshal(p.(*Provider).params(ai.GenerateRequest{Schema: ai.PingSchema()}, modelFacts{maxTokens: 64000}, false))
	if strings.Contains(string(b), "effort") || strings.Contains(string(b), "fallbacks") {
		t.Errorf("params without effort or fallback: %s", b)
	}
	// Only the level the request needs has to be supported.
	b, _ = json.Marshal(p.(*Provider).params(ai.GenerateRequest{Schema: ai.PingSchema(), Light: true}, modelFacts{effortHigh: true}, false))
	if strings.Contains(string(b), "effort") {
		t.Errorf("a light request must not fall back to another level: %s", b)
	}
	// Any other request asks for the provider's level where the model takes
	// it, and for none without one.
	for _, tc := range []struct {
		effort string
		facts  modelFacts
		want   any
	}{
		{"", able, nil},
		{ai.EffortLow, able, "low"},
		{ai.EffortMedium, able, "medium"},
		{ai.EffortHigh, able, "high"},
		{ai.EffortMedium, modelFacts{effortLow: true, effortHigh: true}, nil},
	} {
		b, _ := json.Marshal(p.(*Provider).params(ai.GenerateRequest{Schema: ai.PingSchema(), Effort: tc.effort}, tc.facts, false))
		var m map[string]any
		json.Unmarshal(b, &m)
		if got := m["output_config"].(map[string]any)["effort"]; got != tc.want {
			t.Errorf("effort %q with %+v: sent %v, want %v", tc.effort, tc.facts, got, tc.want)
		}
	}
}

// Which models take the server-side fallback is not published, so it is
// offered on the first-party API and dropped for a model that rejects it.
func TestFallbackIsLearnedFromTheAPI(t *testing.T) {
	var withFallback, without atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"some-model","type":"model","display_name":"x","created_at":"2026-01-01T00:00:00Z","max_tokens":64000,"max_input_tokens":200000}`)
			return
		}
		b, _ := io.ReadAll(r.Body)
		if strings.Contains(string(b), `"fallbacks"`) {
			withFallback.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(400)
			fmt.Fprint(w, `{"type":"error","error":{"type":"invalid_request_error","message":"not accepted for this model"}}`)
			return
		}
		without.Add(1)
		sse(w, `{"ok": true}`, "end_turn", nil)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL, Model: "some-model"})
	p.(*Provider).firstParty = true
	for range 2 {
		if _, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()}); err != nil {
			t.Fatal(err)
		}
	}
	if withFallback.Load() != 1 || without.Load() != 2 {
		t.Errorf("requests with the fallback: %d, without: %d; want 1 and 2", withFallback.Load(), without.Load())
	}
}

// A request that is invalid for another reason still reports its own error,
// and the model is not written off.
func TestBadRequestIsNotBlamedOnTheFallback(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") {
			w.WriteHeader(404)
			return
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		fmt.Fprint(w, `{"type":"error","error":{"type":"invalid_request_error","message":"schema is too large"}}`)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL, Model: "some-model"})
	p.(*Provider).firstParty = true
	_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
	if err == nil || !strings.Contains(err.Error(), "schema is too large") {
		t.Errorf("error: %v", err)
	}
	if _, refused := noFallback.Load(p.(*Provider).key()); refused || calls.Load() != 2 {
		t.Errorf("refused=%v after %d calls", refused, calls.Load())
	}
}

func TestStopReasons(t *testing.T) {
	var stop string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sse(w, `{"ok": true}`, stop, nil)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL})
	gen := func() error {
		_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
		return err
	}
	stop = "refusal"
	if err := gen(); err == nil || !strings.Contains(err.Error(), "declined") {
		t.Errorf("refusal: %v", err)
	}
	stop = "max_tokens"
	if err := gen(); err == nil || !strings.Contains(err.Error(), "cut off") {
		t.Errorf("max_tokens: %v", err)
	}
	if _, err := New(ai.Config{}); err == nil {
		t.Error("a key is required")
	}
}

// Each error status is described in words of its own, with the service's
// message but never the key. Rate limits, server errors and overload are
// retried twice before they are reported; other statuses are not retried.
func TestErrorStatuses(t *testing.T) {
	var status, attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") {
			w.WriteHeader(404)
			return
		}
		attempts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		// A retry is sent at once, so that the test does not wait out the
		// SDK's backoff.
		w.Header().Set("Retry-After-Ms", "0")
		w.WriteHeader(int(status.Load()))
		fmt.Fprintf(w, `{"type":"error","error":{"type":"x","message":"denied for %s"}}`, testKey)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL, Model: "some-model"})
	for _, c := range []struct {
		status, attempts int32
		want             string
	}{
		{400, 1, "the Anthropic API returned HTTP 400: denied for [redacted]"},
		{401, 1, "the Anthropic API rejected the API key"},
		{403, 1, "the API key is not permitted to use this model or feature: denied for [redacted]"},
		{404, 1, `model "some-model" was not found: denied for [redacted]`},
		{429, 3, "the Anthropic API rate limit was reached; try again later: denied for [redacted]"},
		{500, 3, "the Anthropic API returned HTTP 500: denied for [redacted]"},
		{529, 3, "the Anthropic API is overloaded; try again later: denied for [redacted]"},
	} {
		status.Store(c.status)
		attempts.Store(0)
		_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
		var pe *ai.Error
		if !asError(err, &pe) || err.Error() != c.want || pe.Status != int(c.status) {
			t.Errorf("%d: %T %v", c.status, err, err)
		}
		if attempts.Load() != c.attempts {
			t.Errorf("%d: %d attempts, want %d", c.status, attempts.Load(), c.attempts)
		}
	}
}

// A rate limit that clears is retried into an answer.
func TestRateLimitIsRetried(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") {
			w.WriteHeader(404)
			return
		}
		if attempts.Add(1) == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After-Ms", "0")
			w.WriteHeader(429)
			fmt.Fprint(w, `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`)
			return
		}
		sse(w, `{"ok": true}`, "end_turn", nil)
	}))
	defer srv.Close()
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL})
	resp, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
	if err != nil || string(resp.JSON) != `{"ok": true}` || attempts.Load() != 2 {
		t.Errorf("after %d attempts: %s %v", attempts.Load(), resp.JSON, err)
	}
}

// failingTransport fails every request with an error that names the key, as
// a proxy might, and counts the requests to the Messages API.
type failingTransport struct{ messages atomic.Int32 }

func (f *failingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if strings.HasSuffix(r.URL.Path, "/messages") {
		f.messages.Add(1)
	}
	return nil, errors.New("proxy refused " + testKey)
}

// A request that gets no response says why, without the key, after the
// SDK's retries; a cancelled one says it was cancelled, without trying.
// A base URL must be an absolute http(s) URL, as the other providers'.
func TestBaseURL(t *testing.T) {
	for _, bad := range []string{"ftp://x", "not a url", "https://", "https://" + strings.Repeat("a", 2048)} {
		if _, err := New(ai.Config{APIKey: testKey, BaseURL: bad}); err == nil ||
			!strings.Contains(err.Error(), "Anthropic base URL") {
			t.Errorf("%.20s: %v", bad, err)
		}
	}
	if _, err := New(ai.Config{APIKey: testKey, BaseURL: "http://localhost:8080"}); err != nil {
		t.Error(err)
	}
}

func TestGenerateWithoutAResponse(t *testing.T) {
	tr := &failingTransport{}
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: "http://anthropic.invalid", HTTPClient: &http.Client{Transport: tr}})
	_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
	var pe *ai.Error
	if !asError(err, &pe) || err.Error() != "could not reach the Anthropic API: proxy refused [redacted]" || pe.Status != 0 {
		t.Errorf("unreachable: %v", err)
	}
	if tr.messages.Load() != 3 {
		t.Errorf("%d attempts, want 3", tr.messages.Load())
	}

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer srv.Close()
	p, _ = New(ai.Config{APIKey: testKey, BaseURL: srv.URL})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = p.Generate(ctx, ai.GenerateRequest{Schema: ai.PingSchema()})
	if !asError(err, &pe) || err.Error() != "the request was cancelled" || pe.Status != 0 || calls.Load() != 0 {
		t.Errorf("cancelled: %v after %d calls", err, calls.Load())
	}
}

func asError(err error, target **ai.Error) bool {
	pe, ok := err.(*ai.Error)
	if ok {
		*target = pe
	}
	return ok
}

// max_tokens never exceeds the configured model's own output cap, looked up
// once through the Models API; without the lookup a value every current
// model accepts is used.
func TestMaxTokensFitsTheModel(t *testing.T) {
	for _, tc := range []struct {
		name   string
		models func(w http.ResponseWriter)
		want   float64
	}{
		{"small cap", func(w http.ResponseWriter) {
			fmt.Fprint(w, `{"id":"old","type":"model","display_name":"x","created_at":"2024-01-01T00:00:00Z","max_tokens":8192,"max_input_tokens":200000}`)
		}, 8192},
		{"no models API", func(w http.ResponseWriter) { w.WriteHeader(404) }, fallbackOutputTokens},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var lookups atomic.Int32
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/v1/models/") {
					lookups.Add(1)
					w.Header().Set("Content-Type", "application/json")
					tc.models(w)
					return
				}
				b, _ := io.ReadAll(r.Body)
				json.Unmarshal(b, &body)
				sse(w, `{"ok": true}`, "end_turn", nil)
			}))
			defer srv.Close()
			p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL, Model: "old"})
			for range 2 {
				if _, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema(), Effort: ai.EffortHigh}); err != nil {
					t.Fatal(err)
				}
				if body["max_tokens"] != tc.want {
					t.Errorf("max_tokens %v, want %v", body["max_tokens"], tc.want)
				}
			}
			if lookups.Load() != 1 {
				t.Errorf("the model was looked up %d times", lookups.Load())
			}
			if oc, _ := body["output_config"].(map[string]any); oc["effort"] != nil {
				t.Errorf("effort %v sent to a model that does not report it", oc["effort"])
			}
		})
	}
}

// One timeout bounds the whole call, retries included.
func TestTimeoutBoundsRetries(t *testing.T) {
	var attempts atomic.Int32
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") {
			w.WriteHeader(404)
			return
		}
		attempts.Add(1)
		select {
		case <-r.Context().Done():
		case <-done:
		}
	}))
	defer srv.Close()
	defer close(done)
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL, Timeout: 300 * time.Millisecond})
	start := time.Now()
	_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
	var pe *ai.Error
	if !asError(err, &pe) || err.Error() != "the Anthropic API did not respond in time" || pe.Status != 0 {
		t.Errorf("error: %v", err)
	}
	// The server holds every attempt until the client gives up, so a
	// per-attempt timeout would retry, and no deadline would never return.
	if d := time.Since(start); d > 5*time.Second || attempts.Load() > 1 {
		t.Errorf("Generate took %s with a 300ms timeout (%d attempts)", d.Round(time.Millisecond), attempts.Load())
	}
}

func TestListModels(t *testing.T) {
	var queries []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("X-Api-Key") != testKey && r.Header.Get("Authorization") != "Bearer "+testKey {
			t.Errorf("API key header missing: %v", r.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		queries = append(queries, r.URL.RawQuery)
		if r.URL.Query().Get("after_id") == "" {
			fmt.Fprintf(w, `{"data":[%s,%s],"has_more":true,"first_id":"claude-b","last_id":"claude-a"}`, modelEntry("claude-b"), modelEntry("claude-a"))
		} else {
			fmt.Fprintf(w, `{"data":[%s],"has_more":false,"first_id":"claude-c","last_id":"claude-c"}`, modelEntry("claude-c"))
		}
	}))
	defer srv.Close()
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL})
	lister := p.(ai.ModelLister)
	ids, err := lister.ListModels(context.Background())
	if err != nil || strings.Join(ids, ",") != "claude-b,claude-a,claude-c" {
		t.Fatalf("ids %v, err %v", ids, err)
	}
	if len(queries) != 2 || !strings.Contains(queries[0], "limit=1000") || !strings.Contains(queries[1], "after_id=claude-a") {
		t.Errorf("queries: %v", queries)
	}
}

func modelEntry(id string) string {
	return `{"id":"` + id + `","type":"model","display_name":"x","created_at":"2026-01-01T00:00:00Z"}`
}

// The failures every lister reports the same way.
func TestListModelsFailures(t *testing.T) {
	aitest.CheckModelLister(t, aitest.ModelListService{
		Path: "/v1/models",
		Page: func(ids []string) string {
			models := make([]string, len(ids))
			for i, id := range ids {
				models[i] = modelEntry(id)
			}
			return `{"data":[` + strings.Join(models, ",") + `],"has_more":false}`
		},
		// A 500 is retried once; at once, so that the test does not wait.
		ErrorHeader: http.Header{"Retry-After-Ms": {"0"}},
		Key:         testKey,
		New: func(t *testing.T, base string, client *http.Client) ai.ModelLister {
			p, err := New(ai.Config{APIKey: testKey, BaseURL: base, HTTPClient: client})
			if err != nil {
				t.Fatal(err)
			}
			return p.(ai.ModelLister)
		},
		Unreachable: "could not list the Anthropic API's models: ",
		Cancelled:   "the request was cancelled",
	})
}

// The usage the API reports: input without the cache's, cache reads and
// writes apart, output including thinking with the thinking part in
// output_tokens_details.
func TestGenerateReportsTheTokenBreakdown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/messages") {
			http.NotFound(w, r)
			return
		}
		sse(w, `{"ok": true}`, "end_turn", &usage{
			start: map[string]any{"input_tokens": 20, "output_tokens": 1, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 40},
			end:   map[string]any{"output_tokens": 90, "output_tokens_details": map[string]any{"thinking_tokens": 60}},
		})
	}))
	defer srv.Close()
	p, err := New(ai.Config{APIKey: testKey, BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := p.Generate(context.Background(), ai.GenerateRequest{System: "S", User: "U", Schema: ai.PingSchema()})
	if err != nil {
		t.Fatal(err)
	}
	if *resp.InputTokens != 20 || *resp.OutputTokens != 90 || *resp.ReasoningTokens != 60 || *resp.CacheReadTokens != 300 ||
		*resp.CacheWriteTokens != 40 || resp.Text != `{"ok": true}` {
		t.Errorf("usage: in %v out %v reasoning %v read %v write %v", *resp.InputTokens, *resp.OutputTokens,
			resp.ReasoningTokens, *resp.CacheReadTokens, *resp.CacheWriteTokens)
	}
}
