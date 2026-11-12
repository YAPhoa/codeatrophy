// Package anthropic implements ai.Provider with the Anthropic API, using the
// official Go SDK and structured outputs.
package anthropic

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	sdk "github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
	"github.com/anthropics/anthropic-sdk-go/v2/shared/constant"

	"codeathropy/internal/ai"
)

// DefaultModel is used when no model is configured.
const DefaultModel = "claude-opus-5-5"

// DefaultBaseURL is the public API endpoint.
const DefaultBaseURL = "https://api.anthropic.com"

const (
	maxOutputTokens      = 64000
	maxLightOutputTokens = 4096
)

// Provider calls the Anthropic Messages API.
type Provider struct {
	client  sdk.Client
	model   string
	baseURL string
	apiKey  string
}

var _ ai.Provider = (*Provider)(nil)

// New is an ai.Factory for the Anthropic provider.
func New(cfg ai.Config) (ai.Provider, error) {
	if cfg.APIKey == "" {
		return nil, ai.Errorf(0, "no Anthropic API key is configured")
	}
	model := cfg.Model
	if model == "" {
		model = DefaultModel
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	opts := []option.RequestOption{
		option.WithAPIKey(cfg.APIKey),
		option.WithMaxRetries(2),
		option.WithRequestTimeout(timeout),
	}
	if cfg.BaseURL != "" {
		u, err := url.Parse(cfg.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, ai.Errorf(0, "the Anthropic base URL is not a valid http(s) URL")
		}
		opts = append(opts, option.WithBaseURL(cfg.BaseURL))
	} else {
		opts = append(opts, option.WithBaseURL(DefaultBaseURL))
	}
	if cfg.HTTPClient != nil {
		opts = append(opts, option.WithHTTPClient(cfg.HTTPClient))
	}
	return &Provider{client: sdk.NewClient(opts...), model: model, baseURL: cfg.BaseURL, apiKey: cfg.APIKey}, nil
}

// Name implements ai.Provider.
func (p *Provider) Name() string { return ai.ProviderAnthropic }

// Model implements ai.Provider.
func (p *Provider) Model() string { return p.model }

// effortModels are model id prefixes that accept output_config.effort.
var effortModels = []string{
	"claude-fable-", "claude-mythos-", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
	"claude-opus-4-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5",
}

// fallbackModels accept the server-side refusal fallback in its "default"
// form.
var fallbackModels = map[string]bool{
	"claude-fable-5-1": true, "claude-opus-5-5": true, "claude-opus-5": true, "claude-sonnet-5-5": true,
}

func hasPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// params builds the Messages API request.
func (p *Provider) params(req ai.GenerateRequest) sdk.BetaMessageNewParams {
	maxTokens := maxOutputTokens
	if req.Light {
		maxTokens = maxLightOutputTokens
	}
	if req.MaxOutputTokens > 0 {
		maxTokens = req.MaxOutputTokens
	}
	params := sdk.BetaMessageNewParams{
		Model:     sdk.Model(p.model),
		MaxTokens: int64(maxTokens),
		System:    []sdk.BetaTextBlockParam{{Text: req.System}},
		Messages:  []sdk.BetaMessageParam{sdk.NewBetaUserMessage(sdk.NewBetaTextBlock(req.User))},
		OutputConfig: sdk.BetaOutputConfigParam{
			Format: sdk.BetaJSONOutputFormatParam{Schema: req.Schema},
		},
	}
	if hasPrefix(p.model, effortModels) {
		// Thinking is left at the model's default (adaptive where supported);
		// effort controls depth. Claude Opus 5.5 defaults to medium, so the
		// level is always set explicitly.
		params.OutputConfig.Effort = sdk.BetaOutputConfigEffortHigh
		if req.Light {
			params.OutputConfig.Effort = sdk.BetaOutputConfigEffortLow
		}
	}
	// Server-side refusal fallback: only on the first-party API, where it is
	// available, and only for models that accept it.
	if fallbackModels[p.model] && (p.baseURL == "" || strings.TrimRight(p.baseURL, "/") == DefaultBaseURL) {
		params.Fallbacks = sdk.BetaFallbacksParamUnion{OfDefault: constant.ValueOf[constant.Default]()}
		params.Betas = []sdk.AnthropicBeta{sdk.AnthropicBetaServerSideFallback2026_07_01}
	}

	return params
}

// Generate implements ai.Provider. The request is streamed so that long
// outputs do not run into HTTP timeouts.
func (p *Provider) Generate(ctx context.Context, req ai.GenerateRequest) (ai.GenerateResponse, error) {
	params := p.params(req)
	stream := p.client.Beta.Messages.NewStreaming(ctx, params)
	msg := sdk.BetaMessage{}
	for stream.Next() {
		if err := msg.Accumulate(stream.Current()); err != nil {
			return ai.GenerateResponse{}, ai.Errorf(0, "the Anthropic response stream could not be read")
		}
	}
	if err := stream.Err(); err != nil {
		return ai.GenerateResponse{}, p.mapError(err)
	}
	switch msg.StopReason {
	case sdk.BetaStopReasonRefusal:
		reason := "the model declined to produce this content"
		if c := string(msg.StopDetails.Category); c != "" {
			reason += " (" + c + ")"
		}
		return ai.GenerateResponse{}, ai.Errorf(0, reason)
	case sdk.BetaStopReasonMaxTokens:
		return ai.GenerateResponse{}, ai.Errorf(0, "the model's output was cut off at the token limit")
	}
	var text strings.Builder
	for _, block := range msg.Content {
		if tb, ok := block.AsAny().(sdk.BetaTextBlock); ok {
			text.WriteString(tb.Text)
		}
	}
	raw, err := ai.ExtractJSON(text.String())
	if err != nil {
		return ai.GenerateResponse{}, err
	}
	model := string(msg.Model)
	if model == "" {
		model = p.model
	}
	return ai.GenerateResponse{
		JSON:         raw,
		Model:        model,
		InputTokens:  int(msg.Usage.InputTokens),
		OutputTokens: int(msg.Usage.OutputTokens),
	}, nil
}

// mapError converts SDK errors into safe provider errors.
func (p *Provider) mapError(err error) error {
	var apierr *sdk.Error
	if errors.As(err, &apierr) {
		detail := strings.TrimSpace(apierr.Message)
		var msg string
		switch apierr.StatusCode {
		case http.StatusUnauthorized:
			msg = "the Anthropic API rejected the API key"
		case http.StatusForbidden:
			msg = "the API key is not permitted to use this model or feature"
		case http.StatusNotFound:
			msg = fmt.Sprintf("model %q was not found", p.model)
		case http.StatusTooManyRequests:
			msg = "the Anthropic API rate limit was reached; try again later"
		case 529:
			msg = "the Anthropic API is overloaded; try again later"
		default:
			msg = fmt.Sprintf("the Anthropic API returned HTTP %d", apierr.StatusCode)
		}
		if detail != "" && apierr.StatusCode != http.StatusUnauthorized {
			msg += ": " + detail
		}
		return ai.Errorf(apierr.StatusCode, ai.Redact(msg, p.apiKey))
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ai.Errorf(0, "the Anthropic API did not respond in time")
	}
	if errors.Is(err, context.Canceled) {
		return ai.Errorf(0, "the request was cancelled")
	}
	return ai.Errorf(0, ai.Redact("could not reach the Anthropic API: "+rootCause(err), p.apiKey))
}

func rootCause(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}
