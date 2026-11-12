// Package mcpserver is the MCP adapter: tool, prompt and resource
// definitions over the application services. It contains no business rules.
package mcpserver

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"codeathropy/internal/ai"
	"codeathropy/internal/app"
	"codeathropy/internal/domain"
)

// GuideURI is the resource holding the authoring guide.
const GuideURI = "codeathropy://authoring-guide"

// Options configure the MCP endpoint.
type Options struct {
	App    *app.App
	Logger *slog.Logger
	// Token, when non-empty, must be sent as a bearer token.
	Token string
	// OriginAllowed decides whether a request's Origin header is acceptable.
	OriginAllowed func(*http.Request) bool
}

// Handler returns the Streamable HTTP handler. A fresh server is built for
// each new session so that its instructions reflect the current default
// style preset.
func Handler(opts Options) http.Handler {
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	h := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		return NewServer(r.Context(), opts.App, log)
	}, &mcp.StreamableHTTPOptions{Logger: log})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if opts.OriginAllowed != nil && !opts.OriginAllowed(r) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		if opts.Token != "" {
			got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || subtle.ConstantTimeCompare([]byte(strings.TrimSpace(got)), []byte(opts.Token)) != 1 {
				w.Header().Set("WWW-Authenticate", `Bearer realm="codeathropy"`)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}

// NewServer builds an MCP server over the application.
func NewServer(ctx context.Context, a *app.App, log *slog.Logger) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "codeathropy", Version: a.Version()},
		&mcp.ServerOptions{Instructions: guide(ctx, a, nil), Logger: log})
	t := &tools{app: a}
	t.register(s)
	registerPrompts(s, a)
	s.AddResource(&mcp.Resource{
		URI: GuideURI, Name: "authoring-guide", Title: "Codeathropy authoring guide",
		Description: "Conventions for writing items and test cases, including the user's default style preset",
		MIMEType:    "text/markdown",
	}, func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{
			URI: GuideURI, MIMEType: "text/markdown", Text: guide(ctx, a, nil),
		}}}, nil
	})
	return s
}

// styleFor returns the given preset as a style, or the default preset when p
// is nil (or no style when there is no default).
func styleFor(ctx context.Context, a *app.App, p *domain.StylePreset) *ai.Style {
	if p == nil {
		def, err := a.DefaultStylePreset(ctx)
		if err == nil {
			p = def
		}
	}
	if p == nil {
		return nil
	}
	return &ai.Style{Name: p.Name, Instructions: p.Instructions}
}

// guide renders the standalone authoring guide with the default preset.
func guide(ctx context.Context, a *app.App, p *domain.StylePreset) string {
	return ai.AuthoringGuide(styleFor(ctx, a, p))
}

// result encodes v as both structured content and text.
func result(v any) *mcp.CallToolResult {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: strings.TrimSpace(buf.String())}},
		StructuredContent: json.RawMessage(bytes.TrimSpace(buf.Bytes())),
	}
}

// toolError reports a failure with the same code and message the HTTP API
// would return.
func toolError(err error) *mcp.CallToolResult {
	ae := app.AsError(err)
	body := map[string]any{"code": ae.Code, "message": ae.Message}
	if len(ae.Fields) > 0 {
		body["fields"] = ae.Fields
	}
	res := result(map[string]any{"error": body})
	res.IsError = true
	return res
}

func decodeArgs(raw json.RawMessage, v any) error {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		raw = []byte("{}")
	}
	if err := domain.DecodeJSON(raw, v); err != nil {
		var te *domain.TypeError
		if errors.As(err, &te) && te.Path != "" {
			return &app.Error{Code: app.CodeValidation, Message: te.Error(),
				Fields: map[string]any{te.Path: "must be " + te.Expected}}
		}
		return &app.Error{Code: app.CodeBadRequest, Message: "malformed arguments: " + err.Error()}
	}
	return nil
}
