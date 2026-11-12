package openaicompat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codeathropy/internal/ai"
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
	if string(resp.JSON) != `{"ok": true}` || resp.Model != "llama3" || resp.OutputTokens != 4 {
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
	if _, err := New(ai.Config{}); err == nil {
		t.Error("a model is required")
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
