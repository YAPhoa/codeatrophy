package main

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"codeatrophy/internal/app"
	"codeatrophy/internal/httpapi"
	"codeatrophy/internal/mcpserver"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store/teststore"
)

// Shutting down with an MCP client connected, whose stream stays open for
// as long as its session, takes no longer than the requests in progress:
// the server ends the sessions instead of waiting out the timeout (and
// being killed before it closes the database).
func TestShutdownWithOpenMCPSession(t *testing.T) {
	ctx := context.Background()
	box, _ := secrets.NewBox(bytes.Repeat([]byte{1}, 32))
	a := app.New(app.Options{Store: teststore.Open(t), Secrets: box})
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()
	log := slog.New(slog.DiscardHandler)
	ep := mcpserver.Handler(mcpserver.Options{App: a})
	streams := make(chan struct{}, 4)
	srv := newHTTPServer("127.0.0.1:0", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			streams <- struct{}{}
		}
		ep.ServeHTTP(w, r)
	}), ep, log)
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	s, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(cctx,
		&mcp.StreamableClientTransport{Endpoint: "http://" + ln.Addr().String(), MaxRetries: -1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	select {
	case <-streams:
	case <-time.After(10 * time.Second):
		t.Fatal("the client opened no stream")
	}

	start := time.Now()
	if !shutdown(srv, 5*time.Second, log) {
		t.Fatalf("shutdown timed out after %v with an MCP session open", time.Since(start).Round(time.Millisecond))
	}
}

// The start-up warning about the first account is for a server that
// listens beyond loopback while sign-in is on and no account exists.
func TestSetupExposed(t *testing.T) {
	open := app.AuthStatus{Enabled: true, SetupRequired: true}
	for _, tc := range []struct {
		addr string
		st   app.AuthStatus
		want bool
	}{
		{"127.0.0.1:8484", open, false},
		{"[::1]:8484", open, false},
		{"localhost:8484", open, false},
		{":8484", open, true},
		{"0.0.0.0:8484", open, true},
		{"[::]:8484", open, true},
		{"192.168.1.20:8484", open, true},
		{":8484", app.AuthStatus{}, false},              // sign-in off
		{":8484", app.AuthStatus{Enabled: true}, false}, // an account exists
	} {
		if got := setupExposed(tc.addr, tc.st); got != tc.want {
			t.Errorf("setupExposed(%q, %+v) = %v, want %v", tc.addr, tc.st, got, tc.want)
		}
	}
}

// The healthcheck reads CODEATROPHY_ADDR as the server does, spaces around
// it ignored, and asks the server for its health under a loopback name.
func TestHealthcheck(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != httpapi.Prefix+"/health" || !strings.HasPrefix(r.Host, "localhost:") {
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")
	for _, v := range []string{addr, " " + addr + " \n"} {
		t.Setenv("CODEATROPHY_ADDR", v)
		if err := healthcheck(); err != nil {
			t.Errorf("CODEATROPHY_ADDR=%q: %v", v, err)
		}
	}
}
