// Package openaicompat implements ai.Provider against any endpoint that
// speaks the OpenAI chat-completions API (OpenAI, OpenRouter, Ollama,
// LM Studio, vLLM, ...), using plain net/http.
package openaicompat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"codeatrophy/internal/ai"
)

// DefaultBaseURL is the OpenAI API endpoint.
const DefaultBaseURL = "https://api.openai.com/v1"

// Provider calls a chat-completions endpoint.
type Provider struct {
	client  *http.Client
	baseURL string
	model   string
	apiKey  string
	timeout time.Duration
}

var (
	_ ai.Provider    = (*Provider)(nil)
	_ ai.ModelLister = (*Provider)(nil)
)

// New is an ai.Factory for OpenAI-compatible endpoints. A provider without
// a model can list models but not generate.
func New(cfg ai.Config) (ai.Provider, error) {
	base := cfg.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, ai.Errorf(0, "the OpenAI-compatible base URL is not a valid http(s) URL")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	return &Provider{client: client, baseURL: strings.TrimRight(base, "/"), model: cfg.Model, apiKey: cfg.APIKey, timeout: timeout}, nil
}

// Name implements ai.Provider.
func (p *Provider) Name() string { return ai.ProviderOpenAICompatible }

// Model implements ai.Provider.
func (p *Provider) Model() string { return p.model }

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model          string         `json:"model"`
	Messages       []message      `json:"messages"`
	ResponseFormat map[string]any `json:"response_format,omitempty"`
	MaxTokens      int            `json:"max_tokens,omitempty"`
	// ReasoningEffort is the provider's effort level, left out for none.
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
}

// errorDetail returns the service's own message from an error response,
// or "" when there is none. Some services (Google's endpoint among them)
// send the usual error object inside an array.
func errorDetail(data []byte) string {
	var e chatResponse
	if json.Unmarshal(data, &e) == nil && e.Error != nil {
		return e.Error.Message
	}
	var list []chatResponse
	if json.Unmarshal(data, &list) == nil {
		for _, e := range list {
			if e.Error != nil && e.Error.Message != "" {
				return e.Error.Message
			}
		}
	}
	return ""
}

type chatResponse struct {
	Model   string `json:"model"`
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Content *string `json:"content"`
			Refusal *string `json:"refusal"`
		} `json:"message"`
	} `json:"choices"`
	// Usage is absent on some servers, and the details on most.
	Usage *struct {
		PromptTokens        *int `json:"prompt_tokens"`
		CompletionTokens    *int `json:"completion_tokens"`
		PromptTokensDetails *struct {
			CachedTokens *int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		CompletionTokensDetails *struct {
			ReasoningTokens *int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Generate implements ai.Provider. It asks for strict JSON-schema output and
// falls back to plain JSON mode, with the schema in the system prompt, for
// servers that do not support schemas.
func (p *Provider) Generate(ctx context.Context, req ai.GenerateRequest) (ai.GenerateResponse, error) {
	if p.model == "" {
		return ai.GenerateResponse{}, ai.Errorf(0, "no model is configured for the OpenAI-compatible provider")
	}
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	name := req.SchemaName
	if name == "" {
		name = "response"
	}
	body := chatRequest{
		Model: p.model,
		Messages: []message{
			{Role: "system", Content: req.System},
			{Role: "user", Content: req.User},
		},
		ResponseFormat: map[string]any{
			"type":        "json_schema",
			"json_schema": map[string]any{"name": name, "schema": req.Schema, "strict": true},
		},
		MaxTokens: req.MaxOutputTokens,
		// Sent on a light request too, so that a server that does not take
		// the level fails its connection test.
		ReasoningEffort: req.Effort,
	}
	resp, status, err := p.call(ctx, body)
	if err != nil && status == http.StatusBadRequest {
		schema, _ := json.Marshal(req.Schema)
		body.Messages[0].Content = req.System + "\n\nThe JSON object must conform to this JSON Schema:\n" + string(schema)
		body.ResponseFormat = map[string]any{"type": "json_object"}
		resp, _, err = p.call(ctx, body)
	}
	if err != nil {
		return ai.GenerateResponse{}, err
	}
	out := ai.GenerateResponse{Model: resp.Model}
	if out.Model == "" {
		out.Model = p.model
	}
	// prompt_tokens includes the cached part; the contract counts cache
	// reads in addition to the input, so they are taken out of it. The API
	// does not report cache writes.
	if u := resp.Usage; u != nil {
		out.InputTokens, out.OutputTokens = u.PromptTokens, u.CompletionTokens
		if d := u.PromptTokensDetails; d != nil && d.CachedTokens != nil {
			out.CacheReadTokens = d.CachedTokens
			if u.PromptTokens != nil {
				out.InputTokens = ai.IntPtr(max(0, *u.PromptTokens-*d.CachedTokens))
			}
		}
		if d := u.CompletionTokensDetails; d != nil {
			out.ReasoningTokens = d.ReasoningTokens
		}
	}
	if len(resp.Choices) == 0 {
		return out, ai.Errorf(0, "the provider returned no choices")
	}
	ch := resp.Choices[0]
	if ch.Message.Content != nil {
		out.Text = *ch.Message.Content
	}
	if ch.Message.Refusal != nil && *ch.Message.Refusal != "" {
		return out, ai.Errorf(0, ai.Redact("the model declined: "+*ch.Message.Refusal, p.apiKey))
	}
	if ch.FinishReason == "length" {
		return out, ai.Errorf(0, "the model's output was cut off at the token limit")
	}
	if ch.Message.Content == nil {
		return out, ai.Errorf(0, "the provider returned an empty response")
	}
	raw, err := ai.ExtractJSON(out.Text)
	if err != nil {
		return out, err
	}
	out.JSON = raw
	return out, nil
}

func (p *Provider) call(ctx context.Context, body chatRequest) (chatResponse, int, error) {
	var out chatResponse
	b, err := json.Marshal(body)
	if err != nil {
		return out, 0, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return out, 0, ai.Errorf(0, "invalid provider URL")
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	if p.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+p.apiKey)
	}
	resp, err := p.client.Do(httpReq)
	if err != nil {
		return out, 0, p.transportError(err, "the AI provider did not respond in time")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return out, resp.StatusCode, errCancelled()
		}
		return out, resp.StatusCode, ai.Errorf(0, "could not read the provider's response")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		detail := errorDetail(data)
		var msg string
		switch resp.StatusCode {
		case http.StatusUnauthorized:
			msg = "the provider rejected the API key"
			detail = ""
		case http.StatusNotFound:
			msg = fmt.Sprintf("the provider returned 404 (check the base URL and model %q)", p.model)
		case http.StatusTooManyRequests:
			msg = "the provider's rate limit was reached; try again later"
		default:
			msg = fmt.Sprintf("the provider returned HTTP %d", resp.StatusCode)
		}
		if detail != "" {
			msg += ": " + detail
		}
		return out, resp.StatusCode, ai.Errorf(resp.StatusCode, ai.Redact(msg, p.apiKey))
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, resp.StatusCode, ai.Errorf(0, "the provider's response is not valid JSON")
	}
	return out, resp.StatusCode, nil
}

// transportError describes a request that got no response: late (in the
// words given), cancelled, or one that could not reach the provider.
func (p *Provider) transportError(err error, late string) error {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return ai.Errorf(0, late)
	case errors.Is(err, context.Canceled):
		return errCancelled()
	}
	cause := err.Error()
	var ue *url.Error
	if errors.As(err, &ue) {
		cause = ue.Err.Error()
	}
	return ai.Errorf(0, ai.Redact("could not reach the AI provider: "+cause, p.apiKey))
}

// errCancelled is the error for a request its caller cancelled, worded as
// the other providers word it.
func errCancelled() error { return ai.Errorf(0, "the request was cancelled") }

// ListModels implements ai.ModelLister with GET {baseURL}/models, which
// answers {"data": [{"id": ...}, ...]}. Servers that do not implement it
// (404, or another body) are reported as an error.
func (p *Provider) ListModels(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, ai.ModelListTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, p.baseURL+"/models", nil)
	if err != nil {
		return nil, ai.Errorf(0, "invalid provider URL")
	}
	httpReq.Header.Set("Accept", "application/json")
	if p.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+p.apiKey)
	}
	resp, err := p.client.Do(httpReq)
	if err != nil {
		return nil, p.transportError(err, "the AI provider did not list its models in time")
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, ai.Errorf(resp.StatusCode, "the provider rejected the API key")
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed:
		return nil, ai.Errorf(resp.StatusCode, "the provider does not list its models")
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return nil, ai.Errorf(resp.StatusCode, fmt.Sprintf("the provider returned HTTP %d for its model list", resp.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, ai.MaxModelListBytes+1))
	if err != nil {
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			return nil, ai.Errorf(0, "the AI provider did not list its models in time")
		case errors.Is(err, context.Canceled):
			return nil, errCancelled()
		}
		return nil, ai.Errorf(0, "could not read the provider's model list")
	}
	if len(data) > ai.MaxModelListBytes {
		return nil, ai.Errorf(0, "the provider's model list is too large")
	}
	var list struct {
		Data []struct {
			ID any `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &list); err != nil || list.Data == nil {
		return nil, ai.Errorf(0, "the provider's model list is not in the expected format")
	}
	ids := make([]string, 0, min(len(list.Data), ai.MaxModelListEntries))
	for _, m := range list.Data {
		if id, ok := m.ID.(string); ok && len(ids) < ai.MaxModelListEntries {
			ids = append(ids, id)
		}
	}
	return ids, nil
}
