package anthropic

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/ai"
)

const testKey = "sk-ant-test-0000-secret"

func sse(w http.ResponseWriter, text, stopReason string) {
	w.Header().Set("Content-Type", "text/event-stream")
	ev := func(name string, v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
	}
	ev("message_start", map[string]any{"type": "message_start", "message": map[string]any{
		"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": []any{},
		"stop_reason": nil, "usage": map[string]any{"input_tokens": 12, "output_tokens": 1}}})
	ev("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
	half := len(text) / 2
	for _, part := range []string{text[:half], text[half:]} {
		ev("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": part}})
	}
	ev("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	ev("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stopReason}, "usage": map[string]any{"output_tokens": 7}})
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
		sse(w, `{"ok": true}`, "end_turn")
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
		sse(w, `{"ok": true}`, "end_turn")
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

func TestStopReasonsAndErrors(t *testing.T) {
	var status int
	var stop string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if status != 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			fmt.Fprintf(w, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key %s"}}`, testKey)
			return
		}
		sse(w, `{"ok": true}`, stop)
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
	for _, s := range []int{401, 404, 429, 400} {
		status = s
		err := gen()
		if err == nil {
			t.Fatalf("%d: expected an error", s)
		}
		if strings.Contains(err.Error(), testKey) {
			t.Errorf("%d: the key leaked: %v", s, err)
		}
		var pe *ai.Error
		if !asError(err, &pe) || pe.Status != s {
			t.Errorf("%d: %T %v", s, err, err)
		}
	}
	if _, err := New(ai.Config{}); err == nil {
		t.Error("a key is required")
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
				sse(w, `{"ok": true}`, "end_turn")
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
	p, _ := New(ai.Config{APIKey: testKey, BaseURL: srv.URL, Timeout: 400 * time.Millisecond})
	start := time.Now()
	_, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()})
	if err == nil {
		t.Fatal("expected a timeout")
	}
	if d := time.Since(start); d > 1200*time.Millisecond {
		t.Errorf("Generate took %s with a 400ms timeout (%d attempts)", d.Round(time.Millisecond), attempts.Load())
	}
}

func TestListModels(t *testing.T) {
	var status int
	var huge bool
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
		if status != 0 {
			w.WriteHeader(status)
			fmt.Fprintf(w, `{"type":"error","error":{"type":"x","message":"bad key %s"}}`, testKey)
			return
		}
		queries = append(queries, r.URL.RawQuery)
		model := func(id string) string {
			return `{"id":"` + id + `","type":"model","display_name":"x","created_at":"2026-01-01T00:00:00Z"}`
		}
		switch {
		case huge:
			fmt.Fprintf(w, `{"data":[%s],"has_more":false}`, model(strings.Repeat("x", ai.MaxModelListBytes)))
		case r.URL.Query().Get("after_id") == "":
			fmt.Fprintf(w, `{"data":[%s,%s],"has_more":true,"first_id":"claude-b","last_id":"claude-a"}`, model("claude-b"), model("claude-a"))
		default:
			fmt.Fprintf(w, `{"data":[%s],"has_more":false,"first_id":"claude-c","last_id":"claude-c"}`, model("claude-c"))
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
	for s, want := range map[int]string{401: "rejected the API key", 404: "does not list", 500: "HTTP 500"} {
		status = s
		_, err := lister.ListModels(context.Background())
		if err == nil || !strings.Contains(err.Error(), want) || strings.Contains(err.Error(), testKey) {
			t.Errorf("%d: %v", s, err)
		}
	}
	status, huge = 0, true
	if _, err := lister.ListModels(context.Background()); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("too large: %v", err)
	}
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
		w.Header().Set("Content-Type", "text/event-stream")
		ev := func(name string, v any) {
			b, _ := json.Marshal(v)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
		}
		ev("message_start", map[string]any{"type": "message_start", "message": map[string]any{
			"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": []any{},
			"stop_reason": nil, "usage": map[string]any{"input_tokens": 20, "output_tokens": 1,
				"cache_read_input_tokens": 300, "cache_creation_input_tokens": 40}}})
		ev("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
		ev("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": `{"ok": true}`}})
		ev("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		ev("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"},
			"usage": map[string]any{"output_tokens": 90, "output_tokens_details": map[string]any{"thinking_tokens": 60}}})
		ev("message_stop", map[string]any{"type": "message_stop"})
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
