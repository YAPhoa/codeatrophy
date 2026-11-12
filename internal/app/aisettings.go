package app

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// ProviderDefaults are what a provider uses when no model or base URL is set.
type ProviderDefaults struct {
	Model   *string `json:"model"`
	BaseURL string  `json:"baseUrl"`
}

// ProviderSettings are the effective settings of one provider. The API key
// itself is never included.
type ProviderSettings struct {
	Model         *string `json:"model"`
	BaseURL       *string `json:"baseUrl"`
	ModelSource   *string `json:"modelSource"`
	BaseURLSource *string `json:"baseUrlSource"`
	APIKeySet     bool    `json:"apiKeySet"`
	APIKeyHint    *string `json:"apiKeyHint"`
	APIKeySource  *string `json:"apiKeySource"`
	Ready         bool    `json:"ready"`
}

// AISettings is the body of GET /settings/ai.
type AISettings struct {
	ActiveProvider *string                     `json:"activeProvider"`
	Providers      map[string]ProviderSettings `json:"providers"`
	Defaults       map[string]ProviderDefaults `json:"defaults"`
}

// ProviderInput is a partial update of one provider's settings.
type ProviderInput struct {
	Model   domain.Opt[string] `json:"model"`
	BaseURL domain.Opt[string] `json:"baseUrl"`
	APIKey  domain.Opt[string] `json:"apiKey"`
}

// AISettingsInput is the body of PUT /settings/ai.
type AISettingsInput struct {
	ActiveProvider domain.Opt[string]       `json:"activeProvider"`
	Providers      map[string]ProviderInput `json:"providers"`
}

// Settings keys.
const (
	keyActiveProvider = "ai.active_provider"
	maxModelChars     = domain.MaxModelIDChars
	maxAPIKeyChars    = domain.MaxAPIKeyChars
)

func providerKey(provider, field string) string { return "ai." + provider + "." + field }

func knownProvider(p string) bool {
	for _, id := range ai.ProviderIDs {
		if id == p {
			return true
		}
	}
	return false
}

// resolvedProvider is the effective configuration of one provider.
type resolvedProvider struct {
	model, baseURL, apiKey     string // effective values ("" when none)
	modelSource, baseURLSource string // "settings", "environment" or ""
	keySource                  string
	decryptFailed              bool
}

func (a *App) envFor(provider string) (model, baseURL, key string) {
	switch provider {
	case ai.ProviderAnthropic:
		return a.aiEnv.AnthropicModel, a.aiEnv.AnthropicBaseURL, a.aiEnv.AnthropicAPIKey
	case ai.ProviderOpenAICompatible:
		return a.aiEnv.OpenAIModel, a.aiEnv.OpenAIBaseURL, a.aiEnv.OpenAIAPIKey
	}
	return "", "", ""
}

// originOf returns the scheme://host[:port] of a URL, lower-cased with the
// default port elided, or "" for an unparsable URL.
func originOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return ""
	}
	scheme, host := strings.ToLower(u.Scheme), strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return scheme + "://" + host
}

// effectiveBase is the base URL a provider will actually call.
func (a *App) effectiveBase(provider, baseURL string) string {
	if baseURL != "" {
		return baseURL
	}
	return a.defaultBaseURL(provider)
}

// keyContext binds a stored key to its provider and origin (AEAD
// additional data), so it never decrypts for any other.
func keyContext(provider, origin string) string { return provider + "\n" + origin }

// resolve returns a provider's effective settings. An API key is only ever
// used with the origin it belongs to: a saved key with the origin it was
// saved for, an environment key with the environment (or default) base URL.
func (a *App) resolve(tx store.Tx, provider string) (resolvedProvider, error) {
	var r resolvedProvider
	envModel, envBase, envKey := a.envFor(provider)
	if v, ok, err := tx.GetSetting(providerKey(provider, "model")); err != nil {
		return r, err
	} else if ok {
		r.model, r.modelSource = v, "settings"
	} else if envModel != "" {
		r.model, r.modelSource = envModel, "environment"
	}
	if v, ok, err := tx.GetSetting(providerKey(provider, "base_url")); err != nil {
		return r, err
	} else if ok {
		r.baseURL, r.baseURLSource = v, "settings"
	} else if envBase != "" {
		r.baseURL, r.baseURLSource = envBase, "environment"
	}
	origin := originOf(a.effectiveBase(provider, r.baseURL))
	stored, storedOrigin, err := a.storedKey(tx, provider)
	if err != nil {
		return r, err
	}
	if stored != "" && storedOrigin == origin {
		r.apiKey, r.keySource = stored, "settings"
	}
	if r.apiKey == "" && envKey != "" && originOf(a.effectiveBase(provider, envBase)) == origin {
		r.apiKey, r.keySource = envKey, "environment"
	}
	return r, nil
}

// storedKey returns the saved key and the origin it is bound to.
func (a *App) storedKey(tx store.Tx, provider string) (key, origin string, err error) {
	ct, ok, err := tx.GetSetting(providerKey(provider, "api_key"))
	if err != nil || !ok {
		return "", "", err
	}
	origin, _, err = tx.GetSetting(providerKey(provider, "api_key_origin"))
	if err != nil {
		return "", "", err
	}
	plain, derr := a.secrets.DecryptBound(ct, keyContext(provider, origin))
	if derr != nil {
		a.log.Warn("a stored API key cannot be decrypted; it is ignored", "provider", provider)
		return "", "", nil
	}
	return plain, origin, nil
}

func (a *App) saveKey(tx store.Tx, provider, key, origin string) error {
	ct, err := a.secrets.EncryptBound(key, keyContext(provider, origin))
	if err != nil {
		return err
	}
	if err := tx.SetSetting(providerKey(provider, "api_key"), ct); err != nil {
		return err
	}
	return tx.SetSetting(providerKey(provider, "api_key_origin"), origin)
}

func (a *App) deleteKey(tx store.Tx, provider string) error {
	if err := tx.DeleteSetting(providerKey(provider, "api_key")); err != nil {
		return err
	}
	return tx.DeleteSetting(providerKey(provider, "api_key_origin"))
}

func (a *App) defaultModel(provider string) string {
	if d, ok := a.defaults[provider]; ok && d.Model != nil {
		return *d.Model
	}
	return ""
}

func (a *App) defaultBaseURL(provider string) string { return a.defaults[provider].BaseURL }

// ready reports whether the provider has everything it needs, counting
// defaults: a model, plus an API key for Anthropic or a base URL for
// OpenAI-compatible endpoints (whose key is optional).
func (a *App) ready(provider string, r resolvedProvider) bool {
	model, base := r.model, r.baseURL
	if model == "" {
		model = a.defaultModel(provider)
	}
	if base == "" {
		base = a.defaultBaseURL(provider)
	}
	if model == "" {
		return false
	}
	switch provider {
	case ai.ProviderAnthropic:
		return r.apiKey != ""
	case ai.ProviderOpenAICompatible:
		// A key is optional for local servers, but the default (public
		// OpenAI) endpoint needs one.
		if base == "" {
			return false
		}
		return r.apiKey != "" || originOf(base) != originOf(a.defaultBaseURL(provider))
	}
	return false
}

func (a *App) activeProvider(tx store.Tx) (string, error) {
	v, ok, err := tx.GetSetting(keyActiveProvider)
	if err != nil {
		return "", err
	}
	if ok {
		return v, nil // "" means explicitly turned off
	}
	return a.aiEnv.Provider, nil
}

func keyHint(k string) *string {
	if k == "" {
		return nil
	}
	r := []rune(k)
	if len(r) > 4 {
		r = r[len(r)-4:]
	}
	h := "…" + string(r)
	return &h
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (a *App) aiSettings(tx store.Tx) (AISettings, error) {
	out := AISettings{Providers: map[string]ProviderSettings{}, Defaults: map[string]ProviderDefaults{}}
	active, err := a.activeProvider(tx)
	if err != nil {
		return out, err
	}
	out.ActiveProvider = strPtrOrNil(active)
	for _, p := range ai.ProviderIDs {
		r, err := a.resolve(tx, p)
		if err != nil {
			return out, err
		}
		ps := ProviderSettings{
			Model:         strPtrOrNil(r.model),
			BaseURL:       strPtrOrNil(r.baseURL),
			ModelSource:   strPtrOrNil(r.modelSource),
			BaseURLSource: strPtrOrNil(r.baseURLSource),
			APIKeySet:     r.apiKey != "",
			APIKeyHint:    keyHint(r.apiKey),
			Ready:         a.ready(p, r),
		}
		if r.keySource != "" {
			src := r.keySource
			ps.APIKeySource = &src
		}
		out.Providers[p] = ps
		d := a.defaults[p]
		out.Defaults[p] = ProviderDefaults{Model: d.Model, BaseURL: d.BaseURL}
	}
	return out, nil
}

// GetAISettings returns the effective AI settings.
func (a *App) GetAISettings(ctx context.Context) (AISettings, error) {
	var out AISettings
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		out, err = a.aiSettings(tx)
		return err
	})
	return out, err
}

// UpdateAISettings applies a merge update to the AI settings.
func (a *App) UpdateAISettings(ctx context.Context, in AISettingsInput) (AISettings, error) {
	fe := domain.FieldErrors{}
	for p, pi := range in.Providers {
		prefix := "providers." + p + "."
		if !knownProvider(p) {
			fe.Add("providers."+p, "unknown provider")
			continue
		}
		if pi.Model.HasValue() {
			m := strings.TrimSpace(pi.Model.Val)
			if utf8.RuneCountInString(m) > maxModelChars || domain.HasDisallowedControl(m) || strings.ContainsAny(m, "\n\t") {
				fe.Add(prefix+"model", "is not a valid model id")
			}
		}
		if pi.BaseURL.HasValue() && strings.TrimSpace(pi.BaseURL.Val) != "" {
			if msg := domain.ValidateURL(strings.TrimSpace(pi.BaseURL.Val)); msg != "" {
				fe.Add(prefix+"baseUrl", msg)
			}
		}
		if pi.APIKey.HasValue() {
			k := strings.TrimSpace(pi.APIKey.Val)
			if utf8.RuneCountInString(k) > maxAPIKeyChars || strings.ContainsFunc(k, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
				fe.Add(prefix+"apiKey", "is not a valid API key")
			}
		}
	}
	if in.ActiveProvider.HasValue() && in.ActiveProvider.Val != "" && !knownProvider(in.ActiveProvider.Val) {
		fe.Add("activeProvider", "unknown provider")
	}
	if err := errValidation(fe); err != nil {
		return AISettings{}, err
	}
	var out AISettings
	err := a.store.Write(ctx, func(tx store.Tx) error {
		for p, pi := range in.Providers {
			_, storedOrigin, err := a.storedKey(tx, p)
			if err != nil {
				return err
			}
			set := func(field string, o domain.Opt[string]) error {
				if !o.Set {
					return nil
				}
				v := strings.TrimSpace(o.Val)
				if o.Null || v == "" {
					return tx.DeleteSetting(providerKey(p, field))
				}
				return tx.SetSetting(providerKey(p, field), v)
			}
			if err := set("model", pi.Model); err != nil {
				return err
			}
			if err := set("base_url", pi.BaseURL); err != nil {
				return err
			}
			after, err := a.resolve(tx, p)
			if err != nil {
				return err
			}
			origin := originOf(a.effectiveBase(p, after.baseURL))
			switch key := strings.TrimSpace(pi.APIKey.Val); {
			case pi.APIKey.Set && pi.APIKey.Null:
				if err := a.deleteKey(tx, p); err != nil {
					return err
				}
			case pi.APIKey.Set && key != "":
				// A new key belongs to the base URL it is saved with.
				if err := a.saveKey(tx, p, key, origin); err != nil {
					return err
				}
			default:
				// Omitted (or empty) key: a stored key never follows the
				// base URL to another origin.
				if storedOrigin != "" && storedOrigin != origin {
					if err := a.deleteKey(tx, p); err != nil {
						return err
					}
				}
			}
		}
		if in.ActiveProvider.Set {
			if err := tx.SetSetting(keyActiveProvider, in.ActiveProvider.Val); err != nil {
				return err
			}
		}
		var err error
		out, err = a.aiSettings(tx)
		if err != nil {
			return err
		}
		if in.ActiveProvider.HasValue() && in.ActiveProvider.Val != "" && !out.Providers[in.ActiveProvider.Val].Ready {
			return errField("activeProvider", "the provider is not ready — it needs a model"+
				map[string]string{ai.ProviderAnthropic: " and an API key", ai.ProviderOpenAICompatible: " and a base URL"}[in.ActiveProvider.Val])
		}
		return nil
	})
	return out, err
}

// providerConfig builds the configuration for constructing a provider.
func (a *App) providerConfig(provider string, r resolvedProvider) ai.Config {
	model := r.model
	if model == "" {
		model = a.defaultModel(provider)
	}
	return ai.Config{Model: model, BaseURL: r.baseURL, APIKey: r.apiKey, Timeout: a.aiEnv.Timeout}
}

// activeAI resolves the provider to use for a request from the current
// settings.
func (a *App) activeAI(ctx context.Context) (ai.Provider, string, error) {
	var (
		provider string
		r        resolvedProvider
	)
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		if provider, err = a.activeProvider(tx); err != nil || provider == "" {
			return err
		}
		r, err = a.resolve(tx, provider)
		return err
	})
	if err != nil {
		return nil, "", err
	}
	if provider == "" || !a.ready(provider, r) {
		return nil, "", &Error{Code: CodeAIUnavailable, Message: "no AI provider is configured"}
	}
	factory, ok := a.providers[provider]
	if !ok {
		return nil, "", &Error{Code: CodeAIUnavailable, Message: "the configured AI provider is not available in this build"}
	}
	p, err := factory(a.providerConfig(provider, r))
	if err != nil {
		return nil, "", &Error{Code: CodeAIUnavailable, Message: ai.SafeMessage(err, r.apiKey)}
	}
	return p, r.apiKey, nil
}

// AIInfo describes the active provider for the meta endpoint.
type AIInfo struct {
	Enabled  bool    `json:"enabled"`
	Provider *string `json:"provider"`
	Model    *string `json:"model"`
}

// AIInfo returns whether AI features are available.
func (a *App) AIInfo(ctx context.Context) (AIInfo, error) {
	out := AIInfo{}
	err := a.store.Read(ctx, func(tx store.Tx) error {
		provider, err := a.activeProvider(tx)
		if err != nil || provider == "" || !knownProvider(provider) {
			return err
		}
		r, err := a.resolve(tx, provider)
		if err != nil {
			return err
		}
		if _, ok := a.providers[provider]; ok && a.ready(provider, r) {
			cfg := a.providerConfig(provider, r)
			out = AIInfo{Enabled: true, Provider: &provider, Model: &cfg.Model}
		}
		return nil
	})
	return out, err
}

// AITestInput is the body of POST /settings/ai/test.
type AITestInput struct {
	Provider string             `json:"provider"`
	Model    domain.Opt[string] `json:"model"`
	BaseURL  domain.Opt[string] `json:"baseUrl"`
	APIKey   domain.Opt[string] `json:"apiKey"`
}

// AITestResult reports a connection test.
type AITestResult struct {
	OK        bool    `json:"ok"`
	Model     *string `json:"model"`
	LatencyMs *int    `json:"latencyMs"`
	Error     *string `json:"error"`
}

// TestAIProvider makes one minimal request with the given overrides on top
// of the saved settings. Nothing is saved.
func (a *App) TestAIProvider(ctx context.Context, in AITestInput) (AITestResult, error) {
	if !knownProvider(in.Provider) {
		return AITestResult{}, errField("provider", "unknown provider")
	}
	if in.BaseURL.HasValue() && strings.TrimSpace(in.BaseURL.Val) != "" {
		if msg := domain.ValidateURL(strings.TrimSpace(in.BaseURL.Val)); msg != "" {
			return AITestResult{}, errField("baseUrl", msg)
		}
	}
	var r resolvedProvider
	if err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		r, err = a.resolve(tx, in.Provider)
		return err
	}); err != nil {
		return AITestResult{}, err
	}
	if v := strings.TrimSpace(in.Model.Val); in.Model.HasValue() && v != "" {
		r.model, r.modelSource = v, "request"
	}
	if v := strings.TrimSpace(in.BaseURL.Val); in.BaseURL.HasValue() && v != "" {
		if originOf(v) != originOf(a.effectiveBase(in.Provider, r.baseURL)) {
			// A saved or environment key is never sent to another origin;
			// only a key given in this request may be.
			r.apiKey, r.keySource = "", ""
		}
		r.baseURL, r.baseURLSource = v, "request"
	}
	if v := strings.TrimSpace(in.APIKey.Val); in.APIKey.HasValue() && v != "" {
		r.apiKey = v
	}
	cfg := a.providerConfig(in.Provider, r)
	res := AITestResult{Model: strPtrOrNil(cfg.Model)}
	fail := func(msg string) (AITestResult, error) {
		m := ai.Redact(msg, r.apiKey)
		res.Error = &m
		return res, nil
	}
	if !a.ready(in.Provider, r) {
		if cfg.Model == "" {
			return fail("no model is configured")
		}
		return fail("no API key is configured for this base URL")
	}
	factory, ok := a.providers[in.Provider]
	if !ok {
		return fail("this provider is not available in this build")
	}
	p, err := factory(cfg)
	if err != nil {
		return fail(ai.SafeMessage(err, r.apiKey))
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	start := time.Now()
	resp, err := p.Generate(ctx, ai.GenerateRequest{
		System:     "You are answering an automated connectivity check.",
		User:       `Reply with the JSON object {"ok": true}.`,
		Schema:     ai.PingSchema(),
		SchemaName: "ping",
		Light:      true,
	})
	ms := int(time.Since(start).Milliseconds())
	res.LatencyMs = &ms
	if err != nil {
		return fail(ai.SafeMessage(err, r.apiKey))
	}
	if resp.Model != "" {
		res.Model = &resp.Model
	}
	res.OK = true
	return res, nil
}

// errUpstream wraps a provider failure.
func errUpstream(err error, secret string) error {
	var ae *Error
	if errors.As(err, &ae) {
		return ae
	}
	return &Error{Code: CodeUpstream, Message: ai.SafeMessage(err, secret)}
}
