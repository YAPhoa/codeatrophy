// Package gemini implements ai.Provider for the Google Gemini API. It
// generates through Google's OpenAI-compatible endpoint, and lists models
// with the native Models API, which says what each model can do, so that
// only models that generate text are offered.
package gemini

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/ai/openaicompat"
	"codeatrophy/internal/domain"
)

// DefaultBaseURL is the Gemini API endpoint. Generation goes to its
// OpenAI-compatible endpoint under /openai.
const DefaultBaseURL = "https://generativelanguage.googleapis.com/v1beta"

const (
	// maxModelListPages bounds how many pages of the Models API are read.
	maxModelListPages = 5
	// modelListPageSize is the largest page the Models API serves.
	modelListPageSize = 1000
	// textGeneration is the generation method of models that produce text.
	textGeneration = "generateContent"
)

// Provider calls the Gemini API.
type Provider struct {
	client  *http.Client
	baseURL string
	model   string
	apiKey  string
	// gen sends generation requests to the OpenAI-compatible endpoint.
	gen ai.Provider
}

var (
	_ ai.Provider    = (*Provider)(nil)
	_ ai.ModelLister = (*Provider)(nil)
)

// New is an ai.Factory for the Gemini API. A provider without a model can
// list models but not generate.
func New(cfg ai.Config) (ai.Provider, error) {
	base := cfg.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	if domain.ValidateURL(base) != "" {
		return nil, ai.Errorf(0, "the Gemini base URL is not a valid http(s) URL")
	}
	base = strings.TrimRight(base, "/")
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	gen, err := openaicompat.New(ai.Config{Model: cfg.Model, BaseURL: base + "/openai", APIKey: cfg.APIKey,
		Timeout: cfg.Timeout, HTTPClient: client})
	if err != nil {
		return nil, err
	}
	return &Provider{client: client, baseURL: base, model: cfg.Model, apiKey: cfg.APIKey, gen: gen}, nil
}

// Name implements ai.Provider.
func (p *Provider) Name() string { return ai.ProviderGemini }

// Model implements ai.Provider.
func (p *Provider) Model() string { return p.model }

// Generate implements ai.Provider through the OpenAI-compatible endpoint.
func (p *Provider) Generate(ctx context.Context, req ai.GenerateRequest) (ai.GenerateResponse, error) {
	if p.model == "" {
		return ai.GenerateResponse{}, ai.Errorf(0, "no model is configured for the Gemini provider")
	}
	return p.gen.Generate(ctx, req)
}

// modelPage is one page of GET {baseURL}/models. Entries are decoded one by
// one, so that one of an unexpected shape is skipped rather than failing
// the list.
type modelPage struct {
	Models        []json.RawMessage `json:"models"`
	NextPageToken any               `json:"nextPageToken"`
}

type modelEntry struct {
	Name                       any `json:"name"`
	SupportedGenerationMethods any `json:"supportedGenerationMethods"`
}

// ListModels implements ai.ModelLister with the native Models API. It keeps
// the models that support generateContent, and gives their ids without the
// "models/" prefix, as the OpenAI-compatible endpoint takes them. The
// bounds on time and size cover all pages together.
func (p *Provider) ListModels(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, ai.ModelListTimeout)
	defer cancel()
	var ids []string
	budget := int64(ai.MaxModelListBytes)
	token := ""
	for n := 1; ; n++ {
		page, err := p.listPage(ctx, token, &budget)
		if err != nil {
			return nil, ai.Errorf(statusOf(err), ai.Redact(err.Error(), p.apiKey))
		}
		for _, raw := range page.Models {
			if id, ok := textModel(raw); ok && len(ids) < ai.MaxModelListEntries {
				ids = append(ids, id)
			}
		}
		next, _ := page.NextPageToken.(string)
		if next == "" || n >= maxModelListPages || len(ids) >= ai.MaxModelListEntries {
			break
		}
		token = next
	}
	return ids, nil
}

// textModel returns the id of a model entry that generates text.
func textModel(raw json.RawMessage) (string, bool) {
	var m modelEntry
	if json.Unmarshal(raw, &m) != nil {
		return "", false
	}
	name, ok := m.Name.(string)
	methods, ok2 := m.SupportedGenerationMethods.([]any)
	if !ok || !ok2 || !slices.Contains(methods, any(textGeneration)) {
		return "", false
	}
	id := strings.TrimPrefix(name, "models/")
	return id, id != ""
}

// listPage fetches one page, reading at most *budget bytes and charging
// them to it.
func (p *Provider) listPage(ctx context.Context, token string, budget *int64) (modelPage, error) {
	var page modelPage
	q := url.Values{"pageSize": {fmt.Sprint(modelListPageSize)}}
	if token != "" {
		q.Set("pageToken", token)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, p.baseURL+"/models?"+q.Encode(), nil)
	if err != nil {
		return page, ai.Errorf(0, "invalid provider URL")
	}
	httpReq.Header.Set("Accept", "application/json")
	if p.apiKey != "" {
		// A header rather than the ?key= parameter, so that the key never
		// appears in a URL.
		httpReq.Header.Set("x-goog-api-key", p.apiKey)
	}
	resp, err := p.client.Do(httpReq)
	if err != nil {
		return page, transportError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return page, statusError(resp)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, *budget+1))
	if err != nil {
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			return page, ai.Errorf(0, "the Gemini API did not list its models in time")
		case errors.Is(err, context.Canceled):
			return page, ai.Cancelled()
		}
		return page, ai.Errorf(0, "could not read the Gemini API's model list")
	}
	if int64(len(data)) > *budget {
		return page, ai.Errorf(0, "the Gemini API's model list is too large")
	}
	*budget -= int64(len(data))
	// Empty lists are left out of the JSON, so an object without models is
	// an empty page; anything but an object is not a model list.
	var obj map[string]json.RawMessage
	if json.Unmarshal(data, &obj) != nil || obj == nil || json.Unmarshal(data, &page) != nil {
		return page, ai.Errorf(0, "the Gemini API's model list is not in the expected format")
	}
	return page, nil
}

// transportError describes a request that got no response.
func transportError(err error) error {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return ai.Errorf(0, "the Gemini API did not list its models in time")
	case errors.Is(err, context.Canceled):
		return ai.Cancelled()
	}
	return ai.Errorf(0, "could not reach the Gemini API: "+ai.TransportCause(err))
}

// statusError describes a response that is not a success. Google answers an
// invalid key with 400 and the reason API_KEY_INVALID, so that is a rejected
// key as well.
func statusError(resp *http.Response) error {
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ai.Errorf(resp.StatusCode, "the Gemini API rejected the API key")
	case http.StatusNotFound, http.StatusMethodNotAllowed:
		return ai.Errorf(resp.StatusCode, "the Gemini API does not list its models at this base URL")
	case http.StatusBadRequest:
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		var body struct {
			Error struct {
				Details []struct {
					Reason string `json:"reason"`
				} `json:"details"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &body) == nil {
			for _, d := range body.Error.Details {
				if d.Reason == "API_KEY_INVALID" {
					return ai.Errorf(resp.StatusCode, "the Gemini API rejected the API key")
				}
			}
		}
	}
	return ai.Errorf(resp.StatusCode, fmt.Sprintf("the Gemini API returned HTTP %d for its model list", resp.StatusCode))
}

// statusOf is the upstream status of a listing error, 0 for none.
func statusOf(err error) int {
	var pe *ai.Error
	if errors.As(err, &pe) {
		return pe.Status
	}
	return 0
}
