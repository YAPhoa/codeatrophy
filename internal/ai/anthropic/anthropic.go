// Package anthropic implements ai.Provider with the Anthropic API, using the
// official Go SDK and structured outputs.
package anthropic

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	sdk "github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
	"github.com/anthropics/anthropic-sdk-go/v2/shared/constant"

	"codeatrophy/internal/ai"
)

// DefaultModel is used when no model is configured.
const DefaultModel = "claude-opus-5-5"

// DefaultBaseURL is the public API endpoint.
const DefaultBaseURL = "https://api.anthropic.com"

const (
	// maxOutputTokens is the budget for a generation, lowered to the model's
	// own output cap when the Models API reports a smaller one.
	maxOutputTokens      = 64000
	maxLightOutputTokens = 4096
	// fallbackOutputTokens is used when the cap cannot be looked up (for
	// example through a proxy without the Models API); every model the API
	// currently serves accepts it.
	fallbackOutputTokens = 32000
)

// modelFacts is what a request depends on about the configured model. It is
// read from the Models API, so a new model works without a change here.
type modelFacts struct {
	maxTokens  int  // output cap; fallbackOutputTokens when unknown
	effortHigh bool // output_config.effort accepts "high"
	effortLow  bool // output_config.effort accepts "low"
}

type cachedFacts struct {
	facts   modelFacts
	expires time.Time
}

const (
	// factsTTL is how long an answer from the Models API is trusted.
	factsTTL = 24 * time.Hour
	// factsRetry is how long a failed lookup is remembered, so that a proxy
	// without the Models API is not asked again on every generation.
	factsRetry = 5 * time.Minute
)

var (
	// factsCache holds modelFacts per base URL and model id.
	factsCache sync.Map // key "baseURL\x00model" -> cachedFacts
	// noFallback records models that refused the server-side fallback.
	noFallback sync.Map // key "baseURL\x00model" -> struct{}
)

// Provider calls the Anthropic Messages API.
type Provider struct {
	timeout time.Duration
	client  sdk.Client
	model   string
	baseURL string
	apiKey  string
	// firstParty is whether requests go to Anthropic's own endpoint, the only
	// place the server-side refusal fallback exists.
	firstParty bool
}

var (
	_ ai.Provider    = (*Provider)(nil)
	_ ai.ModelLister = (*Provider)(nil)
)

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
	return &Provider{client: sdk.NewClient(opts...), model: model, baseURL: cfg.BaseURL, apiKey: cfg.APIKey,
		timeout: timeout, firstParty: cfg.BaseURL == "" || strings.TrimRight(cfg.BaseURL, "/") == DefaultBaseURL}, nil
}

// Name implements ai.Provider.
func (p *Provider) Name() string { return ai.ProviderAnthropic }

// Model implements ai.Provider.
func (p *Provider) Model() string { return p.model }

// params builds the Messages API request for a model with the given facts.
// fallback asks for the server-side refusal fallback.
func (p *Provider) params(req ai.GenerateRequest, facts modelFacts, fallback bool) sdk.BetaMessageNewParams {
	maxTokens := maxOutputTokens
	if req.Light {
		maxTokens = maxLightOutputTokens
	}
	if req.MaxOutputTokens > 0 {
		maxTokens = req.MaxOutputTokens
	}
	if facts.maxTokens > 0 && maxTokens > facts.maxTokens {
		maxTokens = facts.maxTokens
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
	// Thinking is left at the model's default (adaptive where supported);
	// effort controls depth. The default level differs between models, so it
	// is set explicitly wherever the model accepts it.
	switch {
	case req.Light && facts.effortLow:
		params.OutputConfig.Effort = sdk.BetaOutputConfigEffortLow
	case !req.Light && facts.effortHigh:
		params.OutputConfig.Effort = sdk.BetaOutputConfigEffortHigh
	}
	if fallback {
		params.Fallbacks = sdk.BetaFallbacksParamUnion{OfDefault: constant.ValueOf[constant.Default]()}
		params.Betas = []sdk.AnthropicBeta{sdk.AnthropicBetaServerSideFallback2026_07_01}
	}

	return params
}

// Generate implements ai.Provider. The request is streamed so that long
// outputs do not run into HTTP timeouts.
func (p *Provider) Generate(ctx context.Context, req ai.GenerateRequest) (ai.GenerateResponse, error) {
	// One deadline bounds the whole call: the SDK's request timeout applies
	// per attempt and retries would otherwise multiply it.
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	facts := p.facts(ctx)
	_, refused := noFallback.Load(p.key())
	fallback := p.firstParty && !refused
	msg, err := p.stream(ctx, p.params(req, facts, fallback))
	if fallback && isBadRequest(err) {
		// Nothing reports which models take the server-side fallback, so it
		// is offered, and a request rejected as invalid is tried once more
		// without it. If that works the model is remembered as not taking it.
		if plain, perr := p.stream(ctx, p.params(req, facts, false)); perr == nil {
			noFallback.Store(p.key(), struct{}{})
			msg, err = plain, nil
		}
	}
	if err != nil {
		return ai.GenerateResponse{}, p.mapError(err)
	}
	out := answer(msg, p.model)
	switch msg.StopReason {
	case sdk.BetaStopReasonRefusal:
		reason := "the model declined to produce this content"
		if c := string(msg.StopDetails.Category); c != "" {
			reason += " (" + c + ")"
		}
		return out, ai.Errorf(0, reason)
	case sdk.BetaStopReasonMaxTokens:
		return out, ai.Errorf(0, "the model's output was cut off at the token limit")
	}
	raw, err := ai.ExtractJSON(out.Text)
	if err != nil {
		return out, err
	}
	out.JSON = raw
	return out, nil
}

// answer is what a finished message says: its text, model and token
// counts. The counts are the cumulative figures of the final message_delta.
// The API reports input tokens without the cache's, cache reads and writes,
// and output tokens including thinking, with the thinking part in
// output_tokens_details where the model reports it. A request retried
// without the fallback reports the call that answered (the rejected one
// carries no counts).
func answer(msg sdk.BetaMessage, model string) ai.GenerateResponse {
	var text strings.Builder
	for _, block := range msg.Content {
		if tb, ok := block.AsAny().(sdk.BetaTextBlock); ok {
			text.WriteString(tb.Text)
		}
	}
	if m := string(msg.Model); m != "" {
		model = m
	}
	out := ai.GenerateResponse{Model: model, Text: text.String()}
	u := msg.Usage
	count := func(valid bool, n int64) *int {
		if !valid {
			return nil
		}
		return ai.IntPtr(int(n))
	}
	out.InputTokens = count(u.JSON.InputTokens.Valid(), u.InputTokens)
	out.OutputTokens = count(u.JSON.OutputTokens.Valid(), u.OutputTokens)
	out.CacheReadTokens = count(u.JSON.CacheReadInputTokens.Valid(), u.CacheReadInputTokens)
	out.CacheWriteTokens = count(u.JSON.CacheCreationInputTokens.Valid(), u.CacheCreationInputTokens)
	out.ReasoningTokens = count(u.OutputTokensDetails.JSON.ThinkingTokens.Valid(),
		u.OutputTokensDetails.ThinkingTokens)
	return out
}

// errUnreadableStream is reported when the response stream cannot be decoded.
var errUnreadableStream = errors.New("the Anthropic response stream could not be read")

// stream sends one request and collects the streamed message.
func (p *Provider) stream(ctx context.Context, params sdk.BetaMessageNewParams) (sdk.BetaMessage, error) {
	stream := p.client.Beta.Messages.NewStreaming(ctx, params)
	msg := sdk.BetaMessage{}
	for stream.Next() {
		if err := msg.Accumulate(stream.Current()); err != nil {
			return msg, errUnreadableStream
		}
	}
	return msg, stream.Err()
}

// isBadRequest reports whether the API rejected the request itself.
func isBadRequest(err error) bool {
	var apierr *sdk.Error
	return errors.As(err, &apierr) && apierr.StatusCode == http.StatusBadRequest
}

// mapError converts SDK errors into safe provider errors.
func (p *Provider) mapError(err error) error {
	if errors.Is(err, errUnreadableStream) {
		return ai.Errorf(0, errUnreadableStream.Error())
	}
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

func (p *Provider) key() string { return p.baseURL + "\x00" + p.model }

// facts returns what the Models API says about the configured model, cached.
// When it cannot be asked (a proxy without the Models API, say) the request
// is limited to what every model accepts: a conservative output cap and no
// effort level.
func (p *Provider) facts(ctx context.Context) modelFacts {
	if v, ok := factsCache.Load(p.key()); ok {
		if c := v.(cachedFacts); time.Now().Before(c.expires) {
			return c.facts
		}
	}
	lookup, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	info, err := p.client.Models.Get(lookup, p.model, sdk.ModelGetParams{}, option.WithMaxRetries(0))
	if err != nil || info.MaxTokens <= 0 {
		unknown := modelFacts{maxTokens: fallbackOutputTokens}
		if ctx.Err() == nil {
			factsCache.Store(p.key(), cachedFacts{facts: unknown, expires: time.Now().Add(factsRetry)})
		}
		return unknown
	}
	effort := info.Capabilities.Effort
	facts := modelFacts{
		maxTokens:  int(info.MaxTokens),
		effortHigh: effort.Supported && effort.High.Supported,
		effortLow:  effort.Supported && effort.Low.Supported,
	}
	factsCache.Store(p.key(), cachedFacts{facts: facts, expires: time.Now().Add(factsTTL)})
	return facts
}

// maxModelListPages bounds how many pages of the Models API are read.
const maxModelListPages = 5

// errListTooLarge is reported by capBody when a response exceeds its bound.
var errListTooLarge = errors.New("the model list is too large")

// ListModels implements ai.ModelLister with the Models API.
func (p *Provider) ListModels(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, ai.ModelListTimeout)
	defer cancel()
	var ids []string
	page, err := p.client.Models.List(ctx, sdk.ModelListParams{Limit: sdk.Int(1000)},
		option.WithMaxRetries(1), option.WithMiddleware(capBody(ai.MaxModelListBytes)))
	for n := 1; err == nil && page != nil; n++ {
		for _, m := range page.Data {
			if len(ids) < ai.MaxModelListEntries {
				ids = append(ids, m.ID)
			}
		}
		if n >= maxModelListPages || len(ids) >= ai.MaxModelListEntries {
			break
		}
		page, err = page.GetNextPage()
	}
	if err != nil {
		return nil, p.mapListError(err)
	}
	return ids, nil
}

// mapListError converts an error from the Models API into a safe provider
// error.
func (p *Provider) mapListError(err error) error {
	var apierr *sdk.Error
	switch {
	case errors.Is(err, errListTooLarge):
		return ai.Errorf(0, "the Anthropic API's model list is too large")
	case errors.As(err, &apierr):
		switch apierr.StatusCode {
		case http.StatusUnauthorized:
			return ai.Errorf(apierr.StatusCode, "the Anthropic API rejected the API key")
		case http.StatusNotFound:
			return ai.Errorf(apierr.StatusCode, "the service does not list its models")
		}
		return ai.Errorf(apierr.StatusCode, fmt.Sprintf("the Anthropic API returned HTTP %d for its model list", apierr.StatusCode))
	case errors.Is(err, context.DeadlineExceeded):
		return ai.Errorf(0, "the Anthropic API did not list its models in time")
	case errors.Is(err, context.Canceled):
		return ai.Errorf(0, "the request was cancelled")
	}
	return ai.Errorf(0, ai.Redact("could not list the Anthropic API's models: "+rootCause(err), p.apiKey))
}

// capBody is SDK middleware that fails reading a response body beyond n
// bytes instead of buffering it.
func capBody(n int64) option.Middleware {
	return func(req *http.Request, next option.MiddlewareNext) (*http.Response, error) {
		resp, err := next(req)
		if err == nil && resp != nil && resp.Body != nil {
			resp.Body = &cappedBody{rc: resp.Body, left: n}
		}
		return resp, err
	}
}

type cappedBody struct {
	rc   io.ReadCloser
	left int64
}

func (b *cappedBody) Read(p []byte) (int, error) {
	if b.left <= 0 {
		// One more byte tells a body of exactly n bytes from a longer one.
		var one [1]byte
		k, err := b.rc.Read(one[:])
		if k > 0 {
			return 0, errListTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > b.left {
		p = p[:b.left]
	}
	k, err := b.rc.Read(p)
	b.left -= int64(k)
	return k, err
}

func (b *cappedBody) Close() error { return b.rc.Close() }
