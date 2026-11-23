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

	"codeatrophy/internal/domain"
)

// Provider ids.
const (
	ProviderAnthropic        = "anthropic"
	ProviderGemini           = "gemini"
	ProviderOpenAICompatible = "openai_compatible"
)

// ProviderIDs lists every supported provider id.
var ProviderIDs = []string{ProviderAnthropic, ProviderGemini, ProviderOpenAICompatible}

// Effort levels a provider can be set to. No level ("") leaves the model at
// its own default.
const (
	EffortLow    = "low"
	EffortMedium = "medium"
	EffortHigh   = "high"
)

// EffortLevels lists every effort level, lowest first.
var EffortLevels = []string{EffortLow, EffortMedium, EffortHigh}

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
	// Effort is the provider's effort level, one of EffortLevels, or "" to
	// send none. Each provider maps it to its own request parameter.
	Effort string
}

// GenerateResponse carries the model's JSON output. A provider that fails
// after the answer arrived (output that is not JSON, a cut-off answer)
// still fills in Text, Model and the counts it has.
type GenerateResponse struct {
	JSON  json.RawMessage
	Model string
	// Text is the model's answer as it arrived.
	Text string
	// Token counts as the service reported them, nil where it reported none.
	// InputTokens excludes tokens read from or written to a prompt cache,
	// which are counted separately; OutputTokens includes reasoning, of
	// which ReasoningTokens is the part the service says it spent on it.
	InputTokens      *int
	OutputTokens     *int
	ReasoningTokens  *int
	CacheReadTokens  *int
	CacheWriteTokens *int
}

// IntPtr returns a pointer to n.
func IntPtr(n int) *int { return &n }

// Provider is a model endpoint that can produce schema-conforming JSON.
type Provider interface {
	Name() string
	Model() string
	Generate(ctx context.Context, req GenerateRequest) (GenerateResponse, error)
}

// ModelLister is an optional capability of a Provider: listing the model ids
// the service offers. It needs no model to be configured. Implementations
// bound the call with ModelListTimeout and the response with
// MaxModelListBytes, and return at most MaxModelListEntries ids as the
// service sent them (in the form the provider's model setting takes);
// callers treat the ids as untrusted text.
type ModelLister interface {
	ListModels(ctx context.Context) ([]string, error)
}

// Bounds on listing models.
const (
	ModelListTimeout    = 15 * time.Second
	MaxModelListBytes   = 4 << 20
	MaxModelListEntries = 5000
)

// Config is what a provider needs to be constructed. Model may be empty for
// a provider that is only used to list models.
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

// Cancelled is the error of a request its caller cancelled, worded the same
// by every provider.
func Cancelled() *Error { return Errorf(0, "the request was cancelled") }

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
		s = domain.Truncate(s, 500) + "…"
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
