// Package ai defines the provider interface used by the AI features, and the
// prompts and JSON schemas those features send. Provider implementations
// live in sub-packages.
package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Provider ids.
const (
	ProviderAnthropic        = "anthropic"
	ProviderOpenAICompatible = "openai_compatible"
)

// ProviderIDs lists every supported provider id.
var ProviderIDs = []string{ProviderAnthropic, ProviderOpenAICompatible}

// GenerateRequest asks a model for JSON conforming to Schema.
type GenerateRequest struct {
	System string
	User   string
	// Schema is a JSON Schema object. Every object in it has
	// additionalProperties: false and lists all its properties as required.
	Schema     map[string]any
	SchemaName string
	// MaxOutputTokens bounds the response; zero means the provider default.
	MaxOutputTokens int
	// Light marks a small request (such as a connection test) for which the
	// provider should spend minimal effort.
	Light bool
}

// GenerateResponse carries the model's JSON output.
type GenerateResponse struct {
	JSON         json.RawMessage
	Model        string
	InputTokens  int
	OutputTokens int
}

// Provider is a model endpoint that can produce schema-conforming JSON.
type Provider interface {
	Name() string
	Model() string
	Generate(ctx context.Context, req GenerateRequest) (GenerateResponse, error)
}

// Config is what a provider needs to be constructed.
type Config struct {
	Model   string
	BaseURL string
	APIKey  string
	// Timeout bounds one Generate call.
	Timeout    time.Duration
	HTTPClient *http.Client
}

// Factory constructs a provider from its configuration.
type Factory func(cfg Config) (Provider, error)

// Error is a provider failure with a message that is safe to show to users:
// it never contains credentials.
type Error struct {
	Message string
	// Status is the upstream HTTP status, if any.
	Status int
}

func (e *Error) Error() string { return e.Message }

// Errorf builds a safe provider error.
func Errorf(status int, msg string) *Error { return &Error{Message: msg, Status: status} }

// SafeMessage returns a user-presentable description of err, with every
// occurrence of the given secrets removed.
func SafeMessage(err error, secrets ...string) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	var pe *Error
	if errors.As(err, &pe) {
		msg = pe.Message
	}
	if errors.Is(err, context.DeadlineExceeded) {
		msg = "the AI provider did not respond in time"
	}
	return Redact(msg, secrets...)
}

// Redact removes secrets from s.
func Redact(s string, secrets ...string) string {
	for _, sec := range secrets {
		if len(sec) >= 4 {
			s = strings.ReplaceAll(s, sec, "[redacted]")
		}
	}
	if len(s) > 500 {
		s = s[:500] + "…"
	}
	return s
}

// ExtractJSON returns the JSON object in a model's text output, tolerating
// surrounding prose or Markdown code fences.
func ExtractJSON(text string) (json.RawMessage, error) {
	t := strings.TrimSpace(text)
	if strings.HasPrefix(t, "```") {
		if i := strings.IndexByte(t, '\n'); i >= 0 {
			t = t[i+1:]
		}
		t = strings.TrimSuffix(strings.TrimSpace(t), "```")
		t = strings.TrimSpace(t)
	}
	if json.Valid([]byte(t)) {
		return json.RawMessage(t), nil
	}
	start, end := strings.IndexByte(t, '{'), strings.LastIndexByte(t, '}')
	if start >= 0 && end > start && json.Valid([]byte(t[start:end+1])) {
		return json.RawMessage(t[start : end+1]), nil
	}
	return nil, Errorf(0, "the AI provider returned output that is not valid JSON")
}
