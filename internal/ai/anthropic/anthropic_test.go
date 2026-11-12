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

func TestGenerateStreamsStructuredOutput(t *testing.T) {
	var body map[string]any
	var headers http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"claude-opus-5-5","type":"model","display_name":"x","created_at":"2026-01-01T00:00:00Z","max_tokens":128000,"max_input_tokens":1000000}`)
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
	resp, err := p.Generate(context.Background(), ai.GenerateRequest{System: "SYS", User: "USER", Schema: schema})
	if err != nil {
		t.Fatal(err)
	}
	if string(resp.JSON) != `{"ok": true}` || resp.Model != "claude-opus-5-5" || resp.InputTokens != 12 {
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

func TestParamsForFirstPartyAPI(t *testing.T) {
	p, _ := New(ai.Config{APIKey: testKey})
	params := p.(*Provider).params(ai.GenerateRequest{System: "s", User: "u", Schema: ai.PingSchema(), Light: true}, 0)
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
	// Models without effort or fallback support get neither.
	old, _ := New(ai.Config{APIKey: testKey, Model: "claude-haiku-4-5"})
	b, _ = json.Marshal(old.(*Provider).params(ai.GenerateRequest{Schema: ai.PingSchema()}, 0))
	if strings.Contains(string(b), "effort") || strings.Contains(string(b), "fallbacks") {
		t.Errorf("older model params: %s", b)
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
				if _, err := p.Generate(context.Background(), ai.GenerateRequest{Schema: ai.PingSchema()}); err != nil {
					t.Fatal(err)
				}
				if body["max_tokens"] != tc.want {
					t.Errorf("max_tokens %v, want %v", body["max_tokens"], tc.want)
				}
			}
			if tc.want == 8192 && lookups.Load() != 1 {
				t.Errorf("the cap was looked up %d times", lookups.Load())
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
