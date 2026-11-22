package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"codeatrophy/internal/app"
	"codeatrophy/internal/store/teststore"
)

// syncBuffer is a log destination safe for the server's goroutines.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// A panic in a tool, a prompt or anything else served over MCP is an
// internal error of that request: it is logged, and the server goes on
// serving. The SDK runs each request on a goroutine of its own, so an
// unrecovered panic would end the process (and this test binary).
// Internal errors that tools return are logged too.
func TestPanicsAreRecovered(t *testing.T) {
	ctx := context.Background()
	a := app.New(app.Options{Store: teststore.Open(t)})
	var logs syncBuffer
	opts := Options{App: a, Logger: slog.New(slog.NewTextHandler(&logs, nil))}
	s := NewServer(opts)
	tl := &tools{app: a, log: opts.Logger}
	tl.add(s, "test_panic", "Panic", "Panics", object(props{}), readOnly,
		func(context.Context, json.RawMessage) (any, error) { panic("tool boom") })
	tl.add(s, "test_internal", "Internal", "Fails", object(props{}), readOnly,
		func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("disk on fire") })
	s.AddPrompt(&mcp.Prompt{Name: "test_panic"}, func(context.Context, *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		panic("prompt boom")
	})

	st, ct := mcp.NewInMemoryTransports()
	ss, err := s.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "test_panic"})
	if err != nil {
		t.Fatalf("tool panic: %v", err)
	}
	if text := res.Content[0].(*mcp.TextContent).Text; !res.IsError || !strings.Contains(text, `"code":"internal"`) ||
		strings.Contains(text, "boom") {
		t.Errorf("tool panic result: %v %s", res.IsError, text)
	}

	if _, err := cs.GetPrompt(ctx, &mcp.GetPromptParams{Name: "test_panic"}); err == nil ||
		!strings.Contains(err.Error(), "internal server error") || strings.Contains(err.Error(), "boom") {
		t.Errorf("prompt panic: %v", err)
	}

	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "test_internal"})
	if err != nil || !res.IsError {
		t.Fatalf("internal error: %v %v", res, err)
	}

	// The session still works.
	if _, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "get_overview"}); err != nil {
		t.Errorf("after the panics: %v", err)
	}

	got := logs.String()
	for _, want := range []string{"panic in an MCP tool", "tool boom", "tool=test_panic",
		"panic serving an MCP request", "prompt boom", "method=prompts/get",
		"MCP tool failed", "disk on fire", "tool=test_internal"} {
		if !strings.Contains(got, want) {
			t.Errorf("log lacks %q:\n%s", want, got)
		}
	}
}
