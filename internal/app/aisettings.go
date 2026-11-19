package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// ProviderDefaults are what a provider kind uses when no model or base URL
// is set.
type ProviderDefaults struct {
	Model   *string
	BaseURL string
}

// AIKind describes a provider kind.
type AIKind struct {
	DefaultModel   *string `json:"defaultModel"`
	DefaultBaseURL string  `json:"defaultBaseUrl"`
	KeyRequired    bool    `json:"keyRequired"`
}

// AIProvider is a saved or environment AI provider. The API key itself is
// never included.
type AIProvider struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Kind       string        `json:"kind"`
	Model      *string       `json:"model"`
	BaseURL    *string       `json:"baseUrl"`
	APIKeySet  bool          `json:"apiKeySet"`
	APIKeyHint *string       `json:"apiKeyHint"`
	Effort     *string       `json:"effort"`
	Source     string        `json:"source"`
	IsDefault  bool          `json:"isDefault"`
	Ready      bool          `json:"ready"`
	Usage      ProviderUsage `json:"usage"`
	CreatedAt  *time.Time    `json:"createdAt"`
	UpdatedAt  *time.Time    `json:"updatedAt"`
}

// AISettings is the body of GET /settings/ai.
type AISettings struct {
	// Enabled is the saved on/off switch of the AI features, on until it is
	// saved. AI features are on when it is and the default provider is
	// ready.
	Enabled           bool    `json:"enabled"`
	DefaultProviderID *string `json:"defaultProviderId"`
	// TimeoutSeconds is the request timeout in effect: the saved one, else
	// DefaultTimeoutSeconds, the environment's.
	TimeoutSeconds        int               `json:"timeoutSeconds"`
	DefaultTimeoutSeconds int               `json:"defaultTimeoutSeconds"`
	Providers             []AIProvider      `json:"providers"`
	Kinds                 map[string]AIKind `json:"kinds"`
}

// AISettingsInput is the body of PUT /settings/ai.
type AISettingsInput struct {
	Enabled           domain.Opt[bool]   `json:"enabled"`
	DefaultProviderID domain.Opt[string] `json:"defaultProviderId"`
	TimeoutSeconds    domain.Opt[int]    `json:"timeoutSeconds"`
}

// AIProviderInput is the body of provider create and update requests.
type AIProviderInput struct {
	Name    domain.Opt[string] `json:"name"`
	Kind    domain.Opt[string] `json:"kind"`
	Model   domain.Opt[string] `json:"model"`
	BaseURL domain.Opt[string] `json:"baseUrl"`
	APIKey  domain.Opt[string] `json:"apiKey"`
	Effort  domain.Opt[string] `json:"effort"`
}

// Settings keys and fixed values.
const (
	// keyDefaultProvider holds the default provider's id once a default has
	// been saved; "" means explicitly none.
	keyDefaultProvider = "ai.default_provider"
	// keyEnabled holds the AI features switch, "true" or "false"; without it
	// the switch is on.
	keyEnabled = "ai.enabled"
	// keyTimeout holds the saved request timeout in whole seconds; without
	// it the environment's timeout applies.
	keyTimeout     = "ai.timeout_seconds"
	maxModelChars  = domain.MaxModelIDChars
	maxAPIKeyChars = domain.MaxAPIKeyChars
	// maxListedModels bounds the model list a connection test returns.
	maxListedModels = 500
	// testGenerationTimeout bounds the generation request of a connection
	// test, unless the request timeout is shorter.
	testGenerationTimeout = 90 * time.Second
	// modelListTimeout bounds the request of a model listing, unless the
	// request timeout is shorter.
	modelListTimeout = 30 * time.Second

	sourceSettings    = "settings"
	sourceEnvironment = "environment"
)

// envProviderIDs are the fixed ids of the environment providers, per kind.
var envProviderIDs = map[string]string{
	ai.ProviderAnthropic:        "env-anthropic",
	ai.ProviderGemini:           "env-gemini",
	ai.ProviderOpenAICompatible: "env-openai-compatible",
}

// kindNames name each kind for people.
var kindNames = map[string]string{
	ai.ProviderAnthropic:        "Anthropic",
	ai.ProviderGemini:           "Google Gemini",
	ai.ProviderOpenAICompatible: "OpenAI-compatible",
}

func knownKind(k string) bool { return slices.Contains(ai.ProviderIDs, k) }

func isEnvProviderID(id string) bool {
	for _, v := range envProviderIDs {
		if v == id {
			return true
		}
	}
	return false
}

// provider is the resolved configuration of one saved or environment
// provider.
type provider struct {
	id, name, kind, source string
	model, baseURL         string // configured values; "" means the kind's default
	apiKey                 string // the key usable with the effective base URL, "" for none
	effort                 string // one of ai.EffortLevels, "" for the model's default
	createdAt, updatedAt   *time.Time
}

func (a *App) envFor(kind string) (model, baseURL, key string) {
	switch kind {
	case ai.ProviderAnthropic:
		return a.aiEnv.AnthropicModel, a.aiEnv.AnthropicBaseURL, a.aiEnv.AnthropicAPIKey
	case ai.ProviderGemini:
		return a.aiEnv.GeminiModel, a.aiEnv.GeminiBaseURL, a.aiEnv.GeminiAPIKey
	case ai.ProviderOpenAICompatible:
		return a.aiEnv.OpenAIModel, a.aiEnv.OpenAIBaseURL, a.aiEnv.OpenAIAPIKey
	}
	return "", "", ""
}

// formerEffort is the effort level the server asked a kind for before
// providers had one of their own: high for Anthropic, none for the others.
// Providers that cannot be set (environment ones) and providers carried
// over from older settings keep it.
func formerEffort(kind string) string {
	if kind == ai.ProviderAnthropic {
		return ai.EffortHigh
	}
	return ""
}

// envProviders returns one read-only provider per kind whose environment
// variables are set. Its key belongs to its own base URL, and its effort
// level is the kind's former one.
func (a *App) envProviders() []provider {
	var out []provider
	for _, kind := range ai.ProviderIDs {
		model, base, key := a.envFor(kind)
		if model == "" && base == "" && key == "" {
			continue
		}
		out = append(out, provider{id: envProviderIDs[kind], name: kindNames[kind] + " (environment)", kind: kind,
			source: sourceEnvironment, model: model, baseURL: base, apiKey: key, effort: formerEffort(kind)})
	}
	return out
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
func (a *App) effectiveBase(kind, baseURL string) string {
	if baseURL != "" {
		return baseURL
	}
	return a.defaultBaseURL(kind)
}

// keyContext binds a stored key to its provider kind and origin (AEAD
// additional data), so it never decrypts for any other.
func keyContext(kind, origin string) string { return kind + "\n" + origin }

// fromRecord resolves a saved provider. Its stored key is only used with
// the origin it was saved for.
func (a *App) fromRecord(r store.AIProvider) provider {
	created, updated := r.CreatedAt, r.UpdatedAt
	p := provider{id: r.ID, name: r.Name, kind: r.Kind, source: sourceSettings, model: r.Model, baseURL: r.BaseURL,
		effort: r.Effort, createdAt: &created, updatedAt: &updated}
	if r.APIKey == "" || r.APIKeyOrigin != originOf(a.effectiveBase(r.Kind, r.BaseURL)) {
		return p
	}
	plain, err := a.secrets.DecryptBound(r.APIKey, keyContext(r.Kind, r.APIKeyOrigin))
	if err != nil {
		a.log.Warn("a stored API key cannot be decrypted; it is ignored", "provider", r.ID)
		return p
	}
	p.apiKey = plain
	return p
}

// listProviders lists the saved providers by name, then the environment ones.
func (a *App) listProviders(tx store.Tx) ([]provider, error) {
	recs, err := tx.ListAIProviders()
	if err != nil {
		return nil, err
	}
	out := make([]provider, 0, len(recs)+2)
	for _, r := range recs {
		out = append(out, a.fromRecord(r))
	}
	return append(out, a.envProviders()...), nil
}

func findProvider(ps []provider, id string) *provider {
	for i := range ps {
		if ps[i].id == id {
			return &ps[i]
		}
	}
	return nil
}

// defaultProviderID returns the id of the default provider, or "" for none.
// Until a default has been saved, CODEATROPHY_AI_PROVIDER picks the
// environment provider of that kind. A saved default that names no
// existing provider (an environment provider whose variables were removed)
// counts as none.
func (a *App) defaultProviderID(tx store.Tx, ps []provider) (string, error) {
	id, ok, err := tx.GetSetting(keyDefaultProvider)
	if err != nil {
		return "", err
	}
	if !ok {
		id = envProviderIDs[a.aiEnv.Provider]
	}
	if findProvider(ps, id) == nil {
		return "", nil
	}
	return id, nil
}

// aiSwitchedOn reports whether the AI features switch is on: it is until it
// has been saved off.
func aiSwitchedOn(tx store.Tx) (bool, error) {
	v, ok, err := tx.GetSetting(keyEnabled)
	if err != nil || !ok {
		return true, err
	}
	return v != "false", nil
}

// firstReady returns the first ready provider in the order they are listed,
// or nil when none is.
func (a *App) firstReady(ps []provider) *provider {
	for i := range ps {
		if a.ready(ps[i]) {
			return &ps[i]
		}
	}
	return nil
}

func (a *App) defaultModel(kind string) string {
	if d, ok := a.defaults[kind]; ok && d.Model != nil {
		return *d.Model
	}
	return ""
}

func (a *App) defaultBaseURL(kind string) string { return a.defaults[kind].BaseURL }

// keyAlwaysRequired reports whether a kind needs an API key whatever its
// base URL: Anthropic and Gemini do.
func keyAlwaysRequired(kind string) bool {
	return kind == ai.ProviderAnthropic || kind == ai.ProviderGemini
}

// keyRequired reports whether a kind needs an API key with this base URL:
// always for the kinds of keyAlwaysRequired; for OpenAI-compatible
// endpoints only on the default (public OpenAI) endpoint, since local
// servers need none.
func (a *App) keyRequired(kind, baseURL string) bool {
	switch {
	case keyAlwaysRequired(kind):
		return true
	case kind == ai.ProviderOpenAICompatible:
		return originOf(a.effectiveBase(kind, baseURL)) == originOf(a.defaultBaseURL(kind))
	}
	return false
}

// missing lists what a provider still needs to be ready, counting the
// kind's defaults: a model, a base URL, and a key where one is required.
func (a *App) missing(p provider) []string {
	var out []string
	if p.model == "" && a.defaultModel(p.kind) == "" {
		out = append(out, "a model")
	}
	if a.effectiveBase(p.kind, p.baseURL) == "" {
		out = append(out, "a base URL")
	} else if p.apiKey == "" && a.keyRequired(p.kind, p.baseURL) {
		out = append(out, "an API key")
	}
	return out
}

func (a *App) ready(p provider) bool { return knownKind(p.kind) && len(a.missing(p)) == 0 }

// notReady is the reason a provider cannot be used yet.
func (a *App) notReady(p provider) string {
	return "the provider is not ready — it needs " + strings.Join(a.missing(p), " and ")
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

func (a *App) view(p provider, isDefault bool, usage map[string]store.AIUsage) AIProvider {
	u, ok := usage[p.id]
	return AIProvider{
		Usage: usageView(u, ok),
		ID:    p.id, Name: p.name, Kind: p.kind,
		Model:      strPtrOrNil(p.model),
		BaseURL:    strPtrOrNil(p.baseURL),
		APIKeySet:  p.apiKey != "",
		APIKeyHint: keyHint(p.apiKey),
		Effort:     strPtrOrNil(p.effort),
		Source:     p.source,
		IsDefault:  isDefault,
		Ready:      a.ready(p),
		CreatedAt:  p.createdAt,
		UpdatedAt:  p.updatedAt,
	}
}

// savedTimeout returns the saved request timeout in seconds, or 0 when none
// is saved. A stored value outside the limits counts as none.
func savedTimeout(tx store.Tx) (int, error) {
	v, ok, err := tx.GetSetting(keyTimeout)
	if err != nil || !ok {
		return 0, err
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < domain.MinAITimeoutSeconds || n > domain.MaxAITimeoutSeconds {
		return 0, nil
	}
	return n, nil
}

// requestTimeout is how long one request to a provider may take: the saved
// timeout, else the environment's as it is.
func (a *App) requestTimeout(tx store.Tx) (time.Duration, error) {
	n, err := savedTimeout(tx)
	if err != nil || n == 0 {
		return a.aiEnv.Timeout, err
	}
	return time.Duration(n) * time.Second, nil
}

func (a *App) aiSettings(tx store.Tx) (AISettings, error) {
	out := AISettings{Providers: []AIProvider{}, Kinds: map[string]AIKind{}}
	var err error
	if out.Enabled, err = aiSwitchedOn(tx); err != nil {
		return out, err
	}
	out.DefaultTimeoutSeconds = int(a.aiEnv.Timeout / time.Second)
	out.TimeoutSeconds = out.DefaultTimeoutSeconds
	if n, err := savedTimeout(tx); err != nil {
		return out, err
	} else if n != 0 {
		out.TimeoutSeconds = n
	}
	ps, err := a.listProviders(tx)
	if err != nil {
		return out, err
	}
	def, err := a.defaultProviderID(tx, ps)
	if err != nil {
		return out, err
	}
	usage, err := a.providerUsage(tx)
	if err != nil {
		return out, err
	}
	out.DefaultProviderID = strPtrOrNil(def)
	if p := findProvider(ps, def); p != nil {
		out.Providers = append(out.Providers, a.view(*p, true, usage))
	}
	for _, p := range ps {
		if p.id != def {
			out.Providers = append(out.Providers, a.view(p, false, usage))
		}
	}
	for _, kind := range ai.ProviderIDs {
		d := a.defaults[kind]
		out.Kinds[kind] = AIKind{DefaultModel: d.Model, DefaultBaseURL: d.BaseURL, KeyRequired: keyAlwaysRequired(kind)}
	}
	return out, nil
}

// GetAISettings returns the AI providers, the default and the request
// timeout.
func (a *App) GetAISettings(ctx context.Context) (AISettings, error) {
	var out AISettings
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		out, err = a.aiSettings(tx)
		return err
	})
	return out, err
}

// UpdateAISettings applies a merge update: enabled switches the AI features
// on or off, keeping the default provider; defaultProviderId chooses the
// default provider (null for none); timeoutSeconds sets the request timeout
// (null removes it, so the environment's applies). Switching on with no
// default makes the first ready provider the default. Nothing is saved
// unless all are valid.
func (a *App) UpdateAISettings(ctx context.Context, in AISettingsInput) (AISettings, error) {
	var out AISettings
	err := a.store.Write(ctx, func(tx store.Tx) error {
		ps, err := a.listProviders(tx)
		if err != nil {
			return err
		}
		fe := domain.FieldErrors{}
		id := optText(in.DefaultProviderID)
		if id != "" {
			if p := findProvider(ps, id); p == nil {
				fe.Add("defaultProviderId", "unknown provider")
			} else if !a.ready(*p) {
				fe.Add("defaultProviderId", a.notReady(*p))
			}
		}
		if t := in.TimeoutSeconds; t.HasValue() && (t.Val < domain.MinAITimeoutSeconds || t.Val > domain.MaxAITimeoutSeconds) {
			fe.Add("timeoutSeconds", fmt.Sprintf("must be between %d and %d", domain.MinAITimeoutSeconds, domain.MaxAITimeoutSeconds))
		}
		// The default once this update applies, and whether it is new.
		def, setDefault := id, in.DefaultProviderID.Set
		if !setDefault {
			if def, err = a.defaultProviderID(tx, ps); err != nil {
				return err
			}
		}
		switch e := in.Enabled; {
		case e.Set && e.Null:
			fe.Add("enabled", "cannot be null")
		case e.Val && def == "":
			if p := a.firstReady(ps); p == nil {
				fe.Add("enabled", "no AI provider is ready")
			} else {
				def, setDefault = p.id, true
			}
		}
		if err := errValidation(fe); err != nil {
			return err
		}
		if setDefault {
			if err := tx.SetSetting(keyDefaultProvider, def); err != nil {
				return err
			}
		}
		if in.Enabled.Set {
			if err := tx.SetSetting(keyEnabled, strconv.FormatBool(in.Enabled.Val)); err != nil {
				return err
			}
		}
		switch t := in.TimeoutSeconds; {
		case t.Set && t.Null:
			if err := tx.DeleteSetting(keyTimeout); err != nil {
				return err
			}
		case t.Set:
			if err := tx.SetSetting(keyTimeout, strconv.Itoa(t.Val)); err != nil {
				return err
			}
		}
		out, err = a.aiSettings(tx)
		return err
	})
	return out, err
}

func validModel(m string) bool {
	return utf8.RuneCountInString(m) <= maxModelChars && domain.IsSingleLine(m)
}

func validAPIKey(k string) bool {
	return utf8.RuneCountInString(k) <= maxAPIKeyChars && !strings.ContainsFunc(k, func(r rune) bool { return r <= ' ' || r == 0x7f })
}

// checkEffort validates the effort level of a provider input or a
// connection test: one of ai.EffortLevels, or null for the model's default.
func checkEffort(fe domain.FieldErrors, effort domain.Opt[string]) {
	if effort.HasValue() && !slices.Contains(ai.EffortLevels, effort.Val) {
		fe.Add("effort", "must be "+strings.Join(ai.EffortLevels, ", ")+" or null")
	}
}

// checkConnection validates the model, base URL and API key of a provider
// input or a connection test.
func checkConnection(fe domain.FieldErrors, model, baseURL, apiKey domain.Opt[string]) {
	if model.HasValue() && !validModel(strings.TrimSpace(model.Val)) {
		fe.Add("model", "is not a valid model id")
	}
	if v := strings.TrimSpace(baseURL.Val); baseURL.HasValue() && v != "" {
		if msg := domain.ValidateURL(v); msg != "" {
			fe.Add("baseUrl", msg)
		}
	}
	if apiKey.HasValue() && !validAPIKey(strings.TrimSpace(apiKey.Val)) {
		fe.Add("apiKey", "is not a valid API key")
	}
}

func checkProviderName(tx store.Tx, r *store.AIProvider) error {
	all, err := tx.ListAIProviders()
	if err != nil {
		return err
	}
	for _, o := range all {
		if o.ID != r.ID && strings.EqualFold(o.Name, r.Name) {
			return errField("name", "an AI provider with this name already exists")
		}
	}
	return nil
}

// setKey applies an apiKey input to a record whose base URL is final: null
// deletes the stored key, a non-empty string replaces it, bound to the
// origin of the effective base URL. Omitted (or empty), the stored key is
// kept unless the base URL moved to another origin, where it is deleted so
// it never follows.
func (a *App) setKey(r *store.AIProvider, key domain.Opt[string]) error {
	origin := originOf(a.effectiveBase(r.Kind, r.BaseURL))
	switch k := strings.TrimSpace(key.Val); {
	case key.Set && key.Null:
		r.APIKey, r.APIKeyOrigin = "", ""
	case key.Set && k != "":
		ct, err := a.secrets.EncryptBound(k, keyContext(r.Kind, origin))
		if err != nil {
			return err
		}
		r.APIKey, r.APIKeyOrigin = ct, origin
	case r.APIKey != "" && r.APIKeyOrigin != origin:
		r.APIKey, r.APIKeyOrigin = "", ""
	}
	return nil
}

// optText is the trimmed value of an optional text input; null and omitted
// are "".
func optText(o domain.Opt[string]) string { return strings.TrimSpace(o.Val) }

// providerView returns one provider as listed.
func (a *App) providerView(tx store.Tx, id string) (AIProvider, error) {
	ps, err := a.listProviders(tx)
	if err != nil {
		return AIProvider{}, err
	}
	def, err := a.defaultProviderID(tx, ps)
	if err != nil {
		return AIProvider{}, err
	}
	p := findProvider(ps, id)
	if p == nil {
		return AIProvider{}, errNotFound("AI provider")
	}
	usage, err := a.providerUsage(tx)
	if err != nil {
		return AIProvider{}, err
	}
	return a.view(*p, p.id == def, usage), nil
}

// errEnvProvider rejects changes to an environment provider, or reports a
// missing one.
func (a *App) errEnvProvider(id string) error {
	if findProvider(a.envProviders(), id) == nil {
		return errNotFound("AI provider")
	}
	return errConflict("environment providers are configured by the server's environment and cannot be changed here", nil)
}

// CreateAIProvider saves a new provider. It is not made the default. The
// limits are fixed: see domain.MaxAIProviders and friends.
func (a *App) CreateAIProvider(ctx context.Context, in AIProviderInput) (AIProvider, error) {
	now := a.clock()
	r := store.AIProvider{ID: newID(), CreatedAt: now, UpdatedAt: now}
	fe := domain.FieldErrors{}
	if !in.Name.HasValue() {
		fe.Add("name", "is required")
	} else if name, msg := domain.ValidateAIProviderName(in.Name.Val); msg != "" {
		fe.Add("name", msg)
	} else {
		r.Name = name
	}
	switch kind := optText(in.Kind); {
	case !in.Kind.HasValue() || kind == "":
		fe.Add("kind", "is required")
	case !knownKind(kind):
		fe.Add("kind", "unknown provider kind")
	default:
		r.Kind = kind
	}
	checkConnection(fe, in.Model, in.BaseURL, in.APIKey)
	checkEffort(fe, in.Effort)
	if err := errValidation(fe); err != nil {
		return AIProvider{}, err
	}
	r.Model, r.BaseURL, r.Effort = optText(in.Model), optText(in.BaseURL), in.Effort.Val
	var out AIProvider
	err := a.store.Write(ctx, func(tx store.Tx) error {
		all, err := tx.ListAIProviders()
		if err != nil {
			return err
		}
		if len(all) >= domain.MaxAIProviders {
			return errConflict(fmt.Sprintf("at most %d AI providers can be saved", domain.MaxAIProviders), nil)
		}
		if err := checkProviderName(tx, &r); err != nil {
			return err
		}
		if err := a.setKey(&r, in.APIKey); err != nil {
			return err
		}
		if err := tx.InsertAIProvider(&r); err != nil {
			return err
		}
		out, err = a.providerView(tx, r.ID)
		return err
	})
	return out, err
}

// UpdateAIProvider applies a merge update to a saved provider's name,
// model, base URL, key and effort level. The kind cannot change.
func (a *App) UpdateAIProvider(ctx context.Context, id string, in AIProviderInput) (AIProvider, error) {
	if isEnvProviderID(id) {
		return AIProvider{}, a.errEnvProvider(id)
	}
	var out AIProvider
	err := a.store.Write(ctx, func(tx store.Tx) error {
		r, err := tx.GetAIProvider(id)
		if err != nil {
			return notFoundAs(err, "AI provider")
		}
		fe := domain.FieldErrors{}
		if in.Name.Set {
			if name, msg := domain.ValidateAIProviderName(in.Name.Val); in.Name.Null {
				fe.Add("name", "cannot be null")
			} else if msg != "" {
				fe.Add("name", msg)
			} else {
				r.Name = name
			}
		}
		if in.Kind.Set && (in.Kind.Null || optText(in.Kind) != r.Kind) {
			fe.Add("kind", "cannot be changed after creation")
		}
		checkConnection(fe, in.Model, in.BaseURL, in.APIKey)
		checkEffort(fe, in.Effort)
		if err := errValidation(fe); err != nil {
			return err
		}
		if err := checkProviderName(tx, &r); err != nil {
			return err
		}
		if in.Model.Set {
			r.Model = optText(in.Model)
		}
		if in.BaseURL.Set {
			r.BaseURL = optText(in.BaseURL)
		}
		if in.Effort.Set {
			r.Effort = in.Effort.Val
		}
		if err := a.setKey(&r, in.APIKey); err != nil {
			return err
		}
		r.UpdatedAt = a.clock()
		if err := tx.UpdateAIProvider(&r); err != nil {
			return notFoundAs(err, "AI provider")
		}
		out, err = a.providerView(tx, r.ID)
		return err
	})
	return out, err
}

// DeleteAIProvider deletes a saved provider. Deleting the default leaves no
// default.
func (a *App) DeleteAIProvider(ctx context.Context, id string) error {
	if isEnvProviderID(id) {
		return a.errEnvProvider(id)
	}
	return a.store.Write(ctx, func(tx store.Tx) error {
		if err := tx.DeleteAIProvider(id); err != nil {
			return notFoundAs(err, "AI provider")
		}
		// Its counts go with it.
		if err := tx.DeleteAIUsage(id); err != nil {
			return err
		}
		def, ok, err := tx.GetSetting(keyDefaultProvider)
		if err != nil || !ok || def != id {
			return err
		}
		return tx.SetSetting(keyDefaultProvider, "")
	})
}

// modelOf is the model a provider uses: its own, else the kind's default.
func (a *App) modelOf(p provider) string {
	if p.model != "" {
		return p.model
	}
	return a.defaultModel(p.kind)
}

// providerConfig builds the configuration for constructing a provider for
// requests bounded by timeout.
func (a *App) providerConfig(p provider, timeout time.Duration) ai.Config {
	return ai.Config{Model: a.modelOf(p), BaseURL: p.baseURL, APIKey: p.apiKey, Timeout: timeout}
}

// activeAI constructs the provider for a request from the current settings,
// the request timeout included: the one providerID names, or the default
// when it is omitted or null. A named provider must exist and be ready
// (422 on providerId); a missing or unready default is 503, as is any
// request while the AI features are switched off. Naming a provider never
// changes the default.
func (a *App) activeAI(ctx context.Context, providerID domain.Opt[string]) (activeProvider, error) {
	named := providerID.HasValue()
	id := optText(providerID)
	var p *provider
	var timeout time.Duration
	on := true
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		if on, err = aiSwitchedOn(tx); err != nil || !on {
			return err
		}
		ps, err := a.listProviders(tx)
		if err != nil {
			return err
		}
		if !named {
			if id, err = a.defaultProviderID(tx, ps); err != nil {
				return err
			}
		}
		p = findProvider(ps, id)
		timeout, err = a.requestTimeout(tx)
		return err
	})
	if err != nil {
		return activeProvider{}, err
	}
	switch {
	case !on:
		return activeProvider{}, &Error{Code: CodeAIUnavailable, Message: "AI features are switched off"}
	case named && p == nil:
		return activeProvider{}, errField("providerId", "unknown provider")
	case named && !a.ready(*p):
		return activeProvider{}, errField("providerId", a.notReady(*p))
	case p == nil:
		return activeProvider{}, &Error{Code: CodeAIUnavailable, Message: "no default AI provider is chosen"}
	case !a.ready(*p):
		return activeProvider{}, &Error{Code: CodeAIUnavailable, Message: fmt.Sprintf("the default AI provider %q is not ready — it needs %s",
			p.name, strings.Join(a.missing(*p), " and "))}
	}
	factory, ok := a.providers[p.kind]
	if !ok {
		return activeProvider{}, &Error{Code: CodeAIUnavailable, Message: fmt.Sprintf("the AI provider %q is not available in this build", p.name)}
	}
	prov, err := factory(a.providerConfig(*p, timeout))
	if err != nil {
		return activeProvider{}, &Error{Code: CodeAIUnavailable, Message: ai.SafeMessage(err, p.apiKey)}
	}
	return activeProvider{Provider: prov, id: p.id, name: p.name, kind: p.kind, secret: p.apiKey, effort: p.effort}, nil
}

// AIInfo describes the default provider for the meta endpoint.
type AIInfo struct {
	Enabled      bool    `json:"enabled"`
	ProviderID   *string `json:"providerId"`
	ProviderName *string `json:"providerName"`
	Kind         *string `json:"kind"`
	Model        *string `json:"model"`
}

// AIInfo returns whether AI features are available, and with which
// provider: they are when they are switched on and the default provider is
// ready.
func (a *App) AIInfo(ctx context.Context) (AIInfo, error) {
	out := AIInfo{}
	err := a.store.Read(ctx, func(tx store.Tx) error {
		if on, err := aiSwitchedOn(tx); err != nil || !on {
			return err
		}
		ps, err := a.listProviders(tx)
		if err != nil {
			return err
		}
		def, err := a.defaultProviderID(tx, ps)
		if err != nil {
			return err
		}
		p := findProvider(ps, def)
		if p == nil || !a.ready(*p) {
			return nil
		}
		if _, ok := a.providers[p.kind]; ok {
			model := a.modelOf(*p)
			out = AIInfo{Enabled: true, ProviderID: &p.id, ProviderName: &p.name, Kind: &p.kind, Model: &model}
		}
		return nil
	})
	return out, err
}

// AITestInput is the body of POST /settings/ai/test.
type AITestInput struct {
	ProviderID domain.Opt[string] `json:"providerId"`
	Kind       domain.Opt[string] `json:"kind"`
	Model      domain.Opt[string] `json:"model"`
	BaseURL    domain.Opt[string] `json:"baseUrl"`
	APIKey     domain.Opt[string] `json:"apiKey"`
	Effort     domain.Opt[string] `json:"effort"`
}

// AITestResult reports a connection test.
type AITestResult struct {
	OK          bool     `json:"ok"`
	Model       *string  `json:"model"`
	LatencyMs   *int     `json:"latencyMs"`
	Error       *string  `json:"error"`
	Models      []string `json:"models"`
	ModelsError *string  `json:"modelsError"`
}

// cleanModelIDs makes a service's model list safe to show: ids that are
// not a single line of 1 to maxModelChars characters without surrounding
// whitespace are dropped, as is anything containing the key; the rest are
// de-duplicated, sorted and capped.
func cleanModelIDs(ids []string, secret string) []string {
	out := []string{}
	for _, id := range ids {
		if id == "" || id != strings.TrimSpace(id) || !utf8.ValidString(id) || !validModel(id) ||
			(len(secret) >= 4 && strings.Contains(id, secret)) {
			continue
		}
		out = append(out, id)
	}
	slices.Sort(out)
	out = slices.Compact(out)
	if len(out) > maxListedModels {
		out = out[:maxListedModels]
	}
	return out
}

// connection is a provider configuration resolved for a connection test or
// a model listing. Nothing about it is saved.
type connection struct {
	id      string // the saved or environment provider named, "" for a kind
	p       provider
	timeout time.Duration // the request timeout
}

// safe makes msg safe to return: the key in use is redacted from it.
func (c connection) safe(msg string) *string {
	m := ai.Redact(msg, c.p.apiKey)
	return &m
}

// resolveConnection validates in and resolves the configuration it names:
// a saved or environment provider with the overrides applied on top, or an
// unsaved configuration of a kind.
func (a *App) resolveConnection(ctx context.Context, in AITestInput) (connection, error) {
	id, kind := optText(in.ProviderID), optText(in.Kind)
	fe := domain.FieldErrors{}
	switch {
	case (id == "") == (kind == ""):
		fe.Add("providerId", "give exactly one of providerId and kind")
	case kind != "" && !knownKind(kind):
		fe.Add("kind", "unknown provider kind")
	}
	checkConnection(fe, in.Model, in.BaseURL, in.APIKey)
	checkEffort(fe, in.Effort)
	if err := errValidation(fe); err != nil {
		return connection{}, err
	}
	c := connection{id: id, p: provider{kind: kind}}
	var found *provider
	if err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		if c.timeout, err = a.requestTimeout(tx); err != nil || id == "" {
			return err
		}
		ps, err := a.listProviders(tx)
		found = findProvider(ps, id)
		return err
	}); err != nil {
		return connection{}, err
	}
	if id != "" {
		if found == nil {
			return connection{}, errField("providerId", "unknown provider")
		}
		c.p = *found
	}
	if v := optText(in.Model); v != "" {
		c.p.model = v
	}
	if v := optText(in.BaseURL); v != "" {
		if originOf(v) != originOf(a.effectiveBase(c.p.kind, c.p.baseURL)) {
			// A saved or environment key is never sent to another origin;
			// only a key given in this request may be.
			c.p.apiKey = ""
		}
		c.p.baseURL = v
	}
	if v := optText(in.APIKey); v != "" {
		c.p.apiKey = v
	}
	// Unlike the others, an effort given as null is an override too: the
	// model's default.
	if in.Effort.Set {
		c.p.effort = in.Effort.Val
	}
	return c, nil
}

// open builds the provider for c, or returns why no request can be made
// with it: a required key is missing, or the provider cannot be built.
func (a *App) open(c connection) (ai.Config, ai.Provider, string) {
	cfg := a.providerConfig(c.p, c.timeout)
	if c.p.apiKey == "" && a.keyRequired(c.p.kind, c.p.baseURL) {
		return cfg, nil, "no API key is configured for this base URL"
	}
	factory, ok := a.providers[c.p.kind]
	if !ok {
		return cfg, nil, "this provider is not available in this build"
	}
	prov, err := factory(cfg)
	if err != nil {
		return cfg, nil, ai.SafeMessage(err, c.p.apiKey)
	}
	return cfg, prov, ""
}

// listModels asks prov for the service's models, cleaned for showing, or
// returns why they could not be listed.
func listModels(ctx context.Context, prov ai.Provider, secret string) ([]string, string) {
	lister, ok := prov.(ai.ModelLister)
	if !ok {
		return nil, "this provider cannot list its models"
	}
	ids, err := lister.ListModels(ctx)
	if err != nil {
		return nil, ai.SafeMessage(err, secret)
	}
	return cleanModelIDs(ids, secret), ""
}

// shorterOf returns limit, or timeout when it is set and shorter.
func shorterOf(limit, timeout time.Duration) time.Duration {
	if timeout > 0 && timeout < limit {
		return timeout
	}
	return limit
}

// TestAIProvider checks a provider configuration: it lists the service's
// models and, when a model is configured, makes one minimal generation
// request. Overrides apply on top of a saved or environment provider, or
// describe an unsaved configuration of a kind. Nothing is saved.
func (a *App) TestAIProvider(ctx context.Context, in AITestInput) (AITestResult, error) {
	c, err := a.resolveConnection(ctx, in)
	if err != nil {
		return AITestResult{}, err
	}
	p, safe := c.p, c.safe
	res := AITestResult{}
	cfg, prov, problem := a.open(c)
	if problem != "" {
		res.Error = safe(problem)
		return res, nil
	}

	// 1. The model list.
	if res.Models, problem = listModels(ctx, prov, p.apiKey); problem != "" {
		res.ModelsError = safe(problem)
	}
	if cfg.Model == "" {
		// Nothing to generate with: the list shows whether the base URL
		// and key work.
		res.OK = res.Models != nil
		if !res.OK {
			res.Error = res.ModelsError
		}
		return res, nil
	}

	// 2. One minimal generation with the configured model.
	res.Model = &cfg.Model
	ctx, cancel := context.WithTimeout(ctx, shorterOf(testGenerationTimeout, c.timeout))
	defer cancel()
	// Counted in the provider's usage when one was named; a configuration
	// that is not saved has no counts.
	ap := activeProvider{Provider: prov, id: c.id, name: p.name, kind: p.kind, secret: p.apiKey, effort: p.effort}
	u, err := a.generate(ctx, "test", ap, nil, ai.GenerateRequest{
		System:     "You are answering an automated connectivity check.",
		User:       `Reply with the JSON object {"ok": true}.`,
		Schema:     ai.PingSchema(),
		SchemaName: "ping",
		Light:      true,
	}, nil)
	res.LatencyMs = &u.DurationMs
	if err != nil {
		res.Error = safe(AsError(err).Message)
		return res, nil
	}
	if u.Model != "" && validModel(u.Model) {
		m := ai.Redact(u.Model, p.apiKey)
		res.Model = &m
	}
	res.OK = true
	return res, nil
}

// AIModelsInput is the body of POST /settings/ai/models. A model in it is
// ignored.
type AIModelsInput struct {
	ProviderID domain.Opt[string] `json:"providerId"`
	Kind       domain.Opt[string] `json:"kind"`
	BaseURL    domain.Opt[string] `json:"baseUrl"`
	APIKey     domain.Opt[string] `json:"apiKey"`
}

// AIModelsResult reports a model listing: Models is nil when the list could
// not be fetched, and Error then says why.
type AIModelsResult struct {
	Models []string `json:"models"`
	Error  *string  `json:"error"`
}

// ListAIModels lists the models a provider configuration offers, named as
// for TestAIProvider, without a generation request: nothing is saved,
// counted or logged.
func (a *App) ListAIModels(ctx context.Context, in AIModelsInput) (AIModelsResult, error) {
	c, err := a.resolveConnection(ctx, AITestInput{ProviderID: in.ProviderID, Kind: in.Kind, BaseURL: in.BaseURL, APIKey: in.APIKey})
	if err != nil {
		return AIModelsResult{}, err
	}
	_, prov, problem := a.open(c)
	if problem != "" {
		return AIModelsResult{Error: c.safe(problem)}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, shorterOf(modelListTimeout, c.timeout))
	defer cancel()
	res := AIModelsResult{}
	if res.Models, problem = listModels(ctx, prov, c.p.apiKey); problem != "" {
		res.Error = c.safe(problem)
	}
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
