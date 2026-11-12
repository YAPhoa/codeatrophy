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

var _ ai.Provider = (*Provider)(nil)

// New is an ai.Factory for OpenAI-compatible endpoints.
func New(cfg ai.Config) (ai.Provider, error) {
	if cfg.Model == "" {
		return nil, ai.Errorf(0, "no model is configured for the OpenAI-compatible provider")
	}
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
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Generate implements ai.Provider. It asks for strict JSON-schema output and
// falls back to plain JSON mode, with the schema in the system prompt, for
// servers that do not support schemas.
func (p *Provider) Generate(ctx context.Context, req ai.GenerateRequest) (ai.GenerateResponse, error) {
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
	if len(resp.Choices) == 0 {
		return ai.GenerateResponse{}, ai.Errorf(0, "the provider returned no choices")
	}
	ch := resp.Choices[0]
	if ch.Message.Refusal != nil && *ch.Message.Refusal != "" {
		return ai.GenerateResponse{}, ai.Errorf(0, ai.Redact("the model declined: "+*ch.Message.Refusal, p.apiKey))
	}
	if ch.FinishReason == "length" {
		return ai.GenerateResponse{}, ai.Errorf(0, "the model's output was cut off at the token limit")
	}
	if ch.Message.Content == nil {
		return ai.GenerateResponse{}, ai.Errorf(0, "the provider returned an empty response")
	}
	raw, err := ai.ExtractJSON(*ch.Message.Content)
	if err != nil {
		return ai.GenerateResponse{}, err
	}
	model := resp.Model
	if model == "" {
		model = p.model
	}
	return ai.GenerateResponse{JSON: raw, Model: model, InputTokens: resp.Usage.PromptTokens, OutputTokens: resp.Usage.CompletionTokens}, nil
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
		if errors.Is(err, context.DeadlineExceeded) {
			return out, 0, ai.Errorf(0, "the AI provider did not respond in time")
		}
		cause := err.Error()
		var ue *url.Error
		if errors.As(err, &ue) {
			cause = ue.Err.Error()
		}
		return out, 0, ai.Errorf(0, ai.Redact("could not reach the AI provider: "+cause, p.apiKey))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return out, resp.StatusCode, ai.Errorf(0, "could not read the provider's response")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		detail := ""
		var e chatResponse
		if json.Unmarshal(data, &e) == nil && e.Error != nil {
			detail = e.Error.Message
		}
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
