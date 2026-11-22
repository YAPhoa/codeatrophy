package mcpserver_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/mcpserver"
	"codeatrophy/internal/store/teststore"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// A session is logged once, with the client's name and version and the
// account its token acts for.
func TestSessionStartIsLogged(t *testing.T) {
	ctx := context.Background()
	logs := &syncBuffer{}
	a := app.New(app.Options{Store: teststore.Open(t), HealthInterval: time.Hour,
		Logger: slog.New(slog.NewTextHandler(logs, nil))})
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Stop)
	u, err := a.CreateUser(ctx, "me@example.com", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(mcpserver.Handler(mcpserver.Options{App: a, RequireToken: true,
		CheckToken: func(_ context.Context, token string) (string, error) {
			if token == "cat_test" {
				return u.ID, nil
			}
			return "", errors.New("unknown token")
		}}))
	t.Cleanup(srv.Close)
	s, err := connectTo(ctx, srv.URL, "cat_test")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.ListTools(ctx, nil); err != nil {
		t.Fatal(err)
	}
	// The initialized notification is handled on its own goroutine.
	want := `msg="mcp session started" client=test version=1 account=me@example.com`
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(logs.String(), want) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := strings.Count(logs.String(), `msg="mcp session started"`); n != 1 || !strings.Contains(logs.String(), want) {
		t.Errorf("%d session logs in:\n%s", n, logs.String())
	}
	if strings.Contains(logs.String(), "cat_test") {
		t.Error("the token was logged")
	}
}
