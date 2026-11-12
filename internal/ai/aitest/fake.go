// Package aitest provides a fake AI provider for tests.
package aitest

import (
	"context"
	"encoding/json"
	"sync"

	"codeathropy/internal/ai"
)

// Provider is a scriptable ai.Provider that records every request.
type Provider struct {
	NameValue  string
	ModelValue string
	// Respond returns the JSON output for a request; it may inspect the
	// request. When nil, Responses are returned in order.
	Respond   func(req ai.GenerateRequest) (any, error)
	Responses []any

	mu       sync.Mutex
	requests []ai.GenerateRequest
	configs  []ai.Config
}

var _ ai.Provider = (*Provider)(nil)

// Factory returns an ai.Factory that hands out p and records the config.
func (p *Provider) Factory() ai.Factory {
	return func(cfg ai.Config) (ai.Provider, error) {
		p.mu.Lock()
		p.configs = append(p.configs, cfg)
		p.mu.Unlock()
		return p, nil
	}
}

// Name implements ai.Provider.
func (p *Provider) Name() string {
	if p.NameValue == "" {
		return "fake"
	}
	return p.NameValue
}

// Model implements ai.Provider.
func (p *Provider) Model() string {
	if p.ModelValue == "" {
		return "fake-model"
	}
	return p.ModelValue
}

// Generate implements ai.Provider.
func (p *Provider) Generate(_ context.Context, req ai.GenerateRequest) (ai.GenerateResponse, error) {
	p.mu.Lock()
	p.requests = append(p.requests, req)
	n := len(p.requests)
	p.mu.Unlock()
	var out any
	var err error
	switch {
	case p.Respond != nil:
		out, err = p.Respond(req)
	case n <= len(p.Responses):
		out = p.Responses[n-1]
	default:
		out = map[string]any{"ok": true}
	}
	if err != nil {
		return ai.GenerateResponse{}, err
	}
	b, err := json.Marshal(out)
	if err != nil {
		return ai.GenerateResponse{}, err
	}
	return ai.GenerateResponse{JSON: b, Model: p.Model()}, nil
}

// Requests returns the recorded requests.
func (p *Provider) Requests() []ai.GenerateRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]ai.GenerateRequest(nil), p.requests...)
}

// Last returns the most recent request.
func (p *Provider) Last() ai.GenerateRequest {
	r := p.Requests()
	if len(r) == 0 {
		return ai.GenerateRequest{}
	}
	return r[len(r)-1]
}

// Configs returns the configurations the factory was called with.
func (p *Provider) Configs() []ai.Config {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]ai.Config(nil), p.configs...)
}
