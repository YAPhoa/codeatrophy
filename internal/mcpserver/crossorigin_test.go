package mcpserver_test

import (
	"net/http"
	"strings"
	"testing"
)

// With no token, a page on another port of this machine passes the origin
// check (it is a loopback origin), but cannot open a session: a request it
// may send without asking the browser first is not application/json, and
// the preflight for one that is gets no CORS headers.
func TestCrossOriginPageCannotUseTheEndpoint(t *testing.T) {
	f := newFixtureWith(t, "", true)
	const initialize = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"page","version":"1"}}}`
	req, _ := http.NewRequest("POST", f.endpoint, strings.NewReader(initialize))
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Origin", "http://localhost:8888")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType || resp.Header.Get("Mcp-Session-Id") != "" {
		t.Errorf("text/plain initialize: %d, session %q", resp.StatusCode, resp.Header.Get("Mcp-Session-Id"))
	}
	pre, _ := http.NewRequest("OPTIONS", f.endpoint, nil)
	pre.Header.Set("Origin", "http://localhost:8888")
	pre.Header.Set("Access-Control-Request-Method", "POST")
	pre.Header.Set("Access-Control-Request-Headers", "content-type")
	resp, err = http.DefaultClient.Do(pre)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode < 300 || resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
}
