package app_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store"
)

func (e *env) patchProvider(t *testing.T, id, js string) (app.AIProvider, error) {
	t.Helper()
	return e.app.UpdateAIProvider(e.ctx, id, decodeInto[app.AIProviderInput](t, js))
}

func (e *env) testProvider(t *testing.T, js string) app.AITestResult {
	t.Helper()
	return must(e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, js)))
}

func (e *env) lastConfig() ai.Config {
	cs := e.ai.Configs()
	if len(cs) == 0 {
		return ai.Config{}
	}
	return cs[len(cs)-1]
}

func providerByID(st app.AISettings, id string) *app.AIProvider {
	for i := range st.Providers {
		if st.Providers[i].ID == id {
			return &st.Providers[i]
		}
	}
	return nil
}

func TestAIProviderKeysAreWriteOnly(t *testing.T) {
	e := newEnv(t)
	st := must(e.app.GetAISettings(e.ctx))
	if st.DefaultProviderID != nil || len(st.Providers) != 0 || len(st.Kinds) != 2 {
		t.Fatalf("initial: %+v", st)
	}
	if k := st.Kinds["anthropic"]; *k.DefaultModel != "default-model" || k.DefaultBaseURL != "https://api.anthropic.com" || !k.KeyRequired {
		t.Errorf("anthropic kind: %+v", k)
	}
	if k := st.Kinds["openai_compatible"]; k.DefaultModel != nil || k.DefaultBaseURL != "https://api.openai.com/v1" || k.KeyRequired {
		t.Errorf("openai_compatible kind: %+v", k)
	}

	const key = "sk-ant-api03-supersecret-x7Qa"
	p := e.addProvider(t, `{"name":"  Personal key  ","kind":"anthropic","apiKey":"`+key+`"}`)
	b, _ := json.Marshal(p)
	if strings.Contains(string(b), "supersecret") {
		t.Fatalf("the key is echoed: %s", b)
	}
	if p.Name != "Personal key" || !p.APIKeySet || *p.APIKeyHint != "…x7Qa" || p.Source != "settings" || !p.Ready ||
		p.IsDefault || p.Model != nil || p.BaseURL != nil || p.CreatedAt == nil || p.UpdatedAt == nil {
		t.Errorf("created: %+v", p)
	}
	// A new provider is not the default.
	if st := must(e.app.GetAISettings(e.ctx)); st.DefaultProviderID != nil {
		t.Errorf("a new provider became the default: %+v", st)
	}
	// The key is encrypted at rest.
	_ = e.db.Read(e.ctx, func(tx store.Tx) error {
		rs, _ := tx.ListAIProviders()
		if len(rs) != 1 || rs[0].APIKey == "" || strings.Contains(rs[0].APIKey, "supersecret") {
			t.Errorf("stored value is not encrypted: %+v", rs)
		}
		return nil
	})
	st = e.setDefault(t, p.ID)
	if b, _ := json.Marshal(st); strings.Contains(string(b), "supersecret") || *st.DefaultProviderID != p.ID || !st.Providers[0].IsDefault {
		t.Errorf("after choosing the default: %s", b)
	}
	// The provider receives the key and the kind's default model.
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`)))
	if cfg := e.lastConfig(); cfg.APIKey != key || cfg.Model != "default-model" {
		t.Errorf("provider config: %+v", cfg)
	}
	meta := must(e.app.Meta(e.ctx))
	if m := meta.AI; !m.Enabled || *m.ProviderID != p.ID || *m.ProviderName != "Personal key" || *m.Kind != "anthropic" ||
		*m.Model != "default-model" {
		t.Errorf("meta ai: %+v", m)
	}
	// Omitted apiKey keeps it; model null clears the saved model.
	if p = must(e.patchProvider(t, p.ID, `{"model":"claude-x"}`)); !p.APIKeySet || *p.Model != "claude-x" || !p.IsDefault {
		t.Errorf("model update: %+v", p)
	}
	if *must(e.app.Meta(e.ctx)).AI.Model != "claude-x" {
		t.Error("meta reports the model in effect")
	}
	if p = must(e.patchProvider(t, p.ID, `{"model":null}`)); p.Model != nil {
		t.Error("model null should clear it")
	}
	// Turning AI off keeps every provider.
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"defaultProviderId":null}`)))
	if st.DefaultProviderID != nil || len(st.Providers) != 1 || st.Providers[0].IsDefault {
		t.Errorf("defaultProviderId null should turn AI off: %+v", st)
	}
	if m := must(e.app.Meta(e.ctx)).AI; m.Enabled || m.ProviderID != nil || m.ProviderName != nil || m.Kind != nil || m.Model != nil {
		t.Errorf("meta ai when off: %+v", m)
	}
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	wantCode(t, err, app.CodeAIUnavailable)
	// Deleting the key.
	if p = must(e.patchProvider(t, p.ID, `{"apiKey":null}`)); p.APIKeySet || p.APIKeyHint != nil || p.Ready {
		t.Errorf("after delete: %+v", p)
	}
	for _, js := range []string{
		`{"baseUrl":"not a url"}`,
		`{"apiKey":"has spaces in it"}`,
		`{"apiKey":"` + strings.Repeat("k", domain.MaxAPIKeyChars+1) + `"}`,
		`{"model":"two\nlines"}`,
		`{"model":"` + strings.Repeat("m", domain.MaxModelIDChars+1) + `"}`,
	} {
		_, err := e.patchProvider(t, p.ID, js)
		wantCode(t, err, app.CodeValidation)
	}
}

func TestAIProviderNamesKindsAndLimits(t *testing.T) {
	e := newEnv(t)
	create := func(js string) (app.AIProvider, error) {
		return e.app.CreateAIProvider(e.ctx, decodeInto[app.AIProviderInput](t, js))
	}
	a := must(create(`{"name":"Work","kind":"anthropic"}`))
	if a.Ready || a.APIKeySet {
		t.Errorf("a provider need not be ready to be saved: %+v", a)
	}
	for _, js := range []string{
		`{"kind":"anthropic"}`,
		`{"name":"","kind":"anthropic"}`,
		`{"name":"x"}`,
		`{"name":"x","kind":"gemini"}`,
		`{"name":"WORK","kind":"openai_compatible"}`,
		`{"name":"two\nlines","kind":"anthropic"}`,
		`{"name":"` + strings.Repeat("名", domain.MaxAIProviderNameChars+1) + `","kind":"anthropic"}`,
	} {
		_, err := create(js)
		wantCode(t, err, app.CodeValidation)
	}
	must(create(`{"name":"` + strings.Repeat("名", domain.MaxAIProviderNameChars) + `","kind":"anthropic"}`))
	b := must(create(`{"name":"Local","kind":"openai_compatible","baseUrl":"http://localhost:11434/v1","model":"llama3"}`))
	if !b.Ready || b.APIKeySet {
		t.Errorf("a local server needs no key: %+v", b)
	}
	// Renaming onto another provider's name is rejected; keeping one's own
	// name in another case is fine.
	_, err := e.patchProvider(t, b.ID, `{"name":"work"}`)
	wantCode(t, err, app.CodeValidation)
	if b = must(e.patchProvider(t, b.ID, `{"name":"LOCAL"}`)); b.Name != "LOCAL" {
		t.Errorf("rename: %+v", b)
	}
	_, err = e.patchProvider(t, b.ID, `{"name":null}`)
	wantCode(t, err, app.CodeValidation)
	// The kind is fixed.
	_, err = e.patchProvider(t, b.ID, `{"kind":"anthropic"}`)
	wantCode(t, err, app.CodeValidation)
	_, err = e.patchProvider(t, b.ID, `{"kind":null}`)
	wantCode(t, err, app.CodeValidation)
	if b = must(e.patchProvider(t, b.ID, `{"kind":"openai_compatible","model":"qwen"}`)); b.Kind != "openai_compatible" || *b.Model != "qwen" {
		t.Errorf("same kind: %+v", b)
	}
	// Listed by name.
	var names []string
	for _, p := range must(e.app.GetAISettings(e.ctx)).Providers {
		names = append(names, p.Name)
	}
	if len(names) != 3 || names[0] != "LOCAL" || names[1] != "Work" {
		t.Errorf("order: %v", names)
	}
	// Unknown ids.
	_, err = e.patchProvider(t, "nope", `{"model":"x"}`)
	wantCode(t, err, app.CodeNotFound)
	wantCode(t, e.app.DeleteAIProvider(e.ctx, "nope"), app.CodeNotFound)
	// At most 20 providers; the 21st is a conflict.
	for i := len(names); i < domain.MaxAIProviders; i++ {
		must(create(fmt.Sprintf(`{"name":"provider %d","kind":"anthropic"}`, i)))
	}
	_, err = create(`{"name":"twenty-first","kind":"anthropic"}`)
	wantCode(t, err, app.CodeConflict)
	if err := e.app.DeleteAIProvider(e.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	must(create(`{"name":"twenty-first","kind":"anthropic"}`))
}

func TestDefaultAIProvider(t *testing.T) {
	e := newEnv(t)
	put := func(js string) (app.AISettings, error) {
		return e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, js))
	}
	_, err := put(`{"defaultProviderId":"nope"}`)
	wantField(t, err, "defaultProviderId")
	notReady := e.addProvider(t, `{"name":"No key","kind":"anthropic"}`)
	_, err = put(`{"defaultProviderId":"` + notReady.ID + `"}`)
	if ae := wantCode(t, err, app.CodeValidation); ae.Fields["defaultProviderId"] != "the provider is not ready — it needs an API key" {
		t.Errorf("fields: %v", ae.Fields)
	}
	openai := e.addProvider(t, `{"name":"OpenAI","kind":"openai_compatible"}`)
	_, err = put(`{"defaultProviderId":"` + openai.ID + `"}`)
	if ae := wantCode(t, err, app.CodeValidation); ae.Fields["defaultProviderId"] != "the provider is not ready — it needs a model and an API key" {
		t.Errorf("fields: %v", ae.Fields)
	}
	ready := e.addProvider(t, `{"name":"Zed","kind":"anthropic","apiKey":"sk-ant-zed-1111"}`)
	st := e.setDefault(t, ready.ID)
	if st.Providers[0].ID != ready.ID || !st.Providers[0].IsDefault || st.Providers[1].IsDefault {
		t.Errorf("the default is listed first: %+v", st.Providers)
	}
	// The default survives a restart.
	same := newEnv(t, func(o *app.Options) { o.Store = e.db })
	if st := must(same.app.GetAISettings(same.ctx)); st.DefaultProviderID == nil || *st.DefaultProviderID != ready.ID {
		t.Errorf("after a restart: %+v", st.DefaultProviderID)
	}
	// A default that stops being ready stays selected, with AI off.
	must(e.patchProvider(t, ready.ID, `{"apiKey":null}`))
	if st := must(e.app.GetAISettings(e.ctx)); st.DefaultProviderID == nil || *st.DefaultProviderID != ready.ID || st.Providers[0].Ready {
		t.Errorf("a default that is not ready: %+v", st)
	}
	if must(e.app.Meta(e.ctx)).AI.Enabled {
		t.Error("AI is off while the default is not ready")
	}
	_, err = e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	wantCode(t, err, app.CodeAIUnavailable)
	// Deleting the default leaves none, also after a restart.
	must(e.patchProvider(t, ready.ID, `{"apiKey":"sk-ant-zed-2222"}`))
	if err := e.app.DeleteAIProvider(e.ctx, ready.ID); err != nil {
		t.Fatal(err)
	}
	if st := must(e.app.GetAISettings(e.ctx)); st.DefaultProviderID != nil || len(st.Providers) != 2 {
		t.Errorf("after deleting the default: %+v", st)
	}
	again := newEnv(t, func(o *app.Options) { o.Store = e.db })
	if st := must(again.app.GetAISettings(again.ctx)); st.DefaultProviderID != nil {
		t.Errorf("after deleting the default and a restart: %+v", st.DefaultProviderID)
	}
}

func TestEnvironmentProviders(t *testing.T) {
	e := newEnv(t, withAIEnv(app.AIEnv{Provider: "openai_compatible", OpenAIModel: "llama3", OpenAIBaseURL: "http://ollama:11434/v1",
		AnthropicAPIKey: "env-key-abcd"}))
	st := must(e.app.GetAISettings(e.ctx))
	if st.DefaultProviderID == nil || *st.DefaultProviderID != "env-openai-compatible" || len(st.Providers) != 2 {
		t.Fatalf("environment providers: %+v", st)
	}
	oc, an := st.Providers[0], st.Providers[1]
	if oc.ID != "env-openai-compatible" || oc.Name != "OpenAI-compatible (environment)" || oc.Source != "environment" ||
		!oc.Ready || !oc.IsDefault || oc.APIKeySet || *oc.Model != "llama3" || *oc.BaseURL != "http://ollama:11434/v1" ||
		oc.CreatedAt != nil || oc.UpdatedAt != nil {
		t.Errorf("env openai: %+v", oc)
	}
	if an.ID != "env-anthropic" || an.Name != "Anthropic (environment)" || !an.Ready || !an.APIKeySet ||
		*an.APIKeyHint != "…abcd" || an.Model != nil || an.BaseURL != nil {
		t.Errorf("env anthropic: %+v", an)
	}
	if b, _ := json.Marshal(st); strings.Contains(string(b), "env-key-abcd") {
		t.Fatalf("the environment key is echoed: %s", b)
	}
	// The environment does not fill in a saved provider.
	saved := e.addProvider(t, `{"name":"Mine","kind":"anthropic"}`)
	if saved.APIKeySet || saved.Ready {
		t.Errorf("a saved provider stands on its own values: %+v", saved)
	}
	// Order: default first, then saved by name, then environment.
	st = must(e.app.GetAISettings(e.ctx))
	if st.Providers[0].ID != "env-openai-compatible" || st.Providers[1].ID != saved.ID || st.Providers[2].ID != "env-anthropic" {
		t.Errorf("order: %+v", st.Providers)
	}
	// Environment providers are read-only.
	for _, id := range []string{"env-anthropic", "env-openai-compatible"} {
		_, err := e.patchProvider(t, id, `{"model":"x"}`)
		wantCode(t, err, app.CodeConflict)
		wantCode(t, e.app.DeleteAIProvider(e.ctx, id), app.CodeConflict)
	}
	// The environment's provider is used with its own key.
	e.setDefault(t, "env-anthropic")
	e.ai.Responses = []any{draftJSON()}
	must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`)))
	if cfg := e.lastConfig(); cfg.APIKey != "env-key-abcd" || cfg.Model != "default-model" || cfg.BaseURL != "" {
		t.Errorf("env provider config: %+v", cfg)
	}
	// Turning AI off is remembered over CODEATROPHY_AI_PROVIDER.
	must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"defaultProviderId":null}`)))
	same := newEnv(t, func(o *app.Options) {
		o.Store = e.db
		o.AIEnv = app.AIEnv{Provider: "openai_compatible", OpenAIModel: "llama3", OpenAIBaseURL: "http://ollama:11434/v1"}
	})
	if st := must(same.app.GetAISettings(same.ctx)); st.DefaultProviderID != nil {
		t.Error("explicit off should override CODEATROPHY_AI_PROVIDER")
	}
	// A kind without environment variables has no environment provider.
	e2 := newEnv(t, withAIEnv(app.AIEnv{Provider: "anthropic"}))
	if st := must(e2.app.GetAISettings(e2.ctx)); st.DefaultProviderID != nil || len(st.Providers) != 0 {
		t.Errorf("no environment variables: %+v", st)
	}
	_, err := e2.patchProvider(t, "env-anthropic", `{"model":"x"}`)
	wantCode(t, err, app.CodeNotFound)
	// ready counts defaults: openai_compatible's base URL defaults to the
	// OpenAI endpoint, which needs a key as well as a model.
	e3 := newEnv(t, withAIEnv(app.AIEnv{OpenAIModel: "gpt-x"}))
	if oc := must(e3.app.GetAISettings(e3.ctx)).Providers[0]; oc.Ready || oc.BaseURL != nil {
		t.Errorf("the default OpenAI endpoint without a key is not ready: %+v", oc)
	}
	e4 := newEnv(t, withAIEnv(app.AIEnv{OpenAIModel: "gpt-x", OpenAIAPIKey: "sk-env-1234"}))
	if oc := must(e4.app.GetAISettings(e4.ctx)).Providers[0]; !oc.Ready {
		t.Errorf("defaults with an environment key: %+v", oc)
	}
}

// A key is only ever sent to the origin it was stored for, separately for
// each provider.
func TestAPIKeyIsBoundToItsOrigin(t *testing.T) {
	e := newEnv(t)
	a := e.addProvider(t, `{"name":"A","kind":"anthropic","apiKey":"sk-ant-saved-1111"}`)
	b := e.addProvider(t, `{"name":"B","kind":"anthropic","apiKey":"sk-ant-other-9999"}`)
	patch := func(js string) app.AIProvider { return must(e.patchProvider(t, a.ID, js)) }
	// Moving the base URL to another origin without a new key deletes it,
	// and only this provider's.
	if p := patch(`{"baseUrl":"https://proxy.example/v1"}`); p.APIKeySet || p.Ready {
		t.Errorf("key kept across an origin change: %+v", p)
	}
	if p := providerByID(must(e.app.GetAISettings(e.ctx)), b.ID); !p.APIKeySet {
		t.Errorf("another provider's key was touched: %+v", p)
	}
	// ...for good: moving back does not bring it back.
	if p := patch(`{"baseUrl":null}`); p.APIKeySet {
		t.Errorf("the key was only hidden: %+v", p)
	}
	// A key saved with a base URL is bound to that origin; a path change on
	// the same origin keeps it.
	patch(`{"baseUrl":"https://proxy.example/v1","apiKey":"sk-ant-proxy-2222"}`)
	if p := patch(`{"baseUrl":"https://proxy.example/other"}`); !p.APIKeySet || *p.APIKeyHint != "…2222" {
		t.Errorf("same origin, new path: %+v", p)
	}
	e.setDefault(t, a.ID)
	e.ai.Responses = []any{draftJSON()}
	must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`)))
	if cfg := e.lastConfig(); cfg.APIKey != "sk-ant-proxy-2222" || cfg.BaseURL != "https://proxy.example/other" {
		t.Errorf("draft config: key %q base %q", cfg.APIKey, cfg.BaseURL)
	}
	// A key stored for one origin does not decrypt for another, even if
	// the database is edited to point it there.
	_ = e.db.Write(e.ctx, func(tx store.Tx) error {
		r, _ := tx.GetAIProvider(a.ID)
		r.APIKeyOrigin, r.BaseURL = "https://attacker.example", "https://attacker.example"
		return tx.UpdateAIProvider(&r)
	})
	if p := providerByID(must(e.app.GetAISettings(e.ctx)), a.ID); p.APIKeySet {
		t.Errorf("an edited origin made the key usable: %+v", p)
	}
}

func TestAIConnectionTest(t *testing.T) {
	e := newEnv(t)
	const key = "sk-ant-trial-9876"
	n, lists, reqs := len(e.ai.Configs()), e.ai.ListCalls(), len(e.ai.Requests())
	// A missing required key short-circuits with no request made.
	for _, js := range []string{`{"kind":"anthropic"}`, `{"kind":"openai_compatible","model":"gpt-x"}`} {
		res := e.testProvider(t, js)
		if res.OK || res.Error == nil || res.Models != nil || res.Model != nil || res.LatencyMs != nil {
			t.Errorf("%s without a key: %+v", js, res)
		}
	}
	if len(e.ai.Configs()) != n || e.ai.ListCalls() != lists || len(e.ai.Requests()) != reqs {
		t.Error("a request was made without a required key")
	}

	// List and generation.
	e.ai.ListModelsFunc = func() ([]string, error) {
		return []string{"claude-b", "claude-a", "claude-b", "two\nlines", "", " padded ", strings.Repeat("m", domain.MaxModelIDChars+1),
			strings.Repeat("m", domain.MaxModelIDChars), "echo-" + key}, nil
	}
	res := e.testProvider(t, `{"kind":"anthropic","apiKey":"`+key+`","model":"claude-t"}`)
	if !res.OK || res.LatencyMs == nil || res.Error != nil || res.Model == nil || res.ModelsError != nil {
		t.Errorf("test with overrides: %+v", res)
	}
	if strings.Join(res.Models, ",") != "claude-a,claude-b,"+strings.Repeat("m", domain.MaxModelIDChars) {
		t.Errorf("models: %q", res.Models)
	}
	if cfg := e.lastConfig(); cfg.APIKey != key || cfg.Model != "claude-t" || !e.ai.Last().Light {
		t.Errorf("override config: %+v", cfg)
	}
	// Nothing is saved.
	if st := must(e.app.GetAISettings(e.ctx)); len(st.Providers) != 0 {
		t.Error("the test must not save anything")
	}

	// At most 500 ids.
	e.ai.ListModelsFunc = func() ([]string, error) {
		var ids []string
		for i := range 700 {
			ids = append(ids, fmt.Sprintf("model-%03d", i))
		}
		return ids, nil
	}
	if res := e.testProvider(t, `{"kind":"anthropic","apiKey":"`+key+`"}`); len(res.Models) != 500 || res.Models[0] != "model-000" {
		t.Errorf("capped list: %d", len(res.Models))
	}

	// List only: an OpenAI-compatible server without a model.
	e.ai.ListModelsFunc = func() ([]string, error) { return []string{"llama3", "qwen"}, nil }
	reqs = len(e.ai.Requests())
	res = e.testProvider(t, `{"kind":"openai_compatible","baseUrl":"http://localhost:11434/v1"}`)
	if !res.OK || res.Model != nil || res.LatencyMs != nil || res.Error != nil || strings.Join(res.Models, ",") != "llama3,qwen" {
		t.Errorf("list only: %+v", res)
	}
	if len(e.ai.Requests()) != reqs {
		t.Error("no generation request is made without a model")
	}
	// An empty list still shows the connection works.
	e.ai.ListModelsFunc = func() ([]string, error) { return nil, nil }
	if res := e.testProvider(t, `{"kind":"openai_compatible","baseUrl":"http://localhost:11434/v1"}`); !res.OK || res.Models == nil {
		t.Errorf("empty list: %+v", res)
	}

	// The list fails while the generation succeeds.
	e.ai.ListModelsFunc = func() ([]string, error) { return nil, ai.Errorf(404, "the provider does not list its models: "+key) }
	res = e.testProvider(t, `{"kind":"anthropic","apiKey":"`+key+`"}`)
	if !res.OK || res.Error != nil || res.Models != nil || res.ModelsError == nil || strings.Contains(*res.ModelsError, key) {
		t.Errorf("list failing, generation fine: %+v", res)
	}
	// Without a model the failed list is the result.
	res = e.testProvider(t, `{"kind":"openai_compatible","baseUrl":"http://localhost:11434/v1","apiKey":"`+key+`"}`)
	if res.OK || res.Error == nil || res.Models != nil || *res.Error != *res.ModelsError || strings.Contains(*res.Error, key) {
		t.Errorf("list failing without a model: %+v", res)
	}
	e.ai.ListModelsFunc = nil

	// A failing generation is reported without the key.
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return nil, fmt.Errorf("upstream said: invalid x-api-key %s", key)
	}
	res = e.testProvider(t, `{"kind":"anthropic","apiKey":"`+key+`"}`)
	if b, _ := json.Marshal(res); res.OK || res.Error == nil || strings.Contains(string(b), key) || res.Model == nil ||
		*res.Model != "default-model" {
		t.Errorf("failure must be reported without the key: %s", b)
	}
	e.ai.Respond = nil

	// A saved provider is tested with its own values.
	p := e.addProvider(t, `{"name":"Saved","kind":"anthropic","model":"claude-saved","apiKey":"sk-ant-saved-5555"}`)
	if res := e.testProvider(t, `{"providerId":"`+p.ID+`"}`); !res.OK {
		t.Errorf("saved provider: %+v", res)
	}
	if cfg := e.lastConfig(); cfg.APIKey != "sk-ant-saved-5555" || cfg.Model != "claude-saved" {
		t.Errorf("saved config: %+v", cfg)
	}

	for _, js := range []string{
		`{}`,
		`{"providerId":"` + p.ID + `","kind":"anthropic"}`,
		`{"providerId":"nope"}`,
		`{"kind":"gemini"}`,
		`{"kind":"anthropic","baseUrl":"not a url"}`,
		`{"kind":"anthropic","model":"two\nlines"}`,
	} {
		_, err := e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, js))
		wantCode(t, err, app.CodeValidation)
	}
}

// A connection test against another origin uses only a key from the same
// request, for saved and environment providers alike.
func TestConnectionTestDoesNotSendStoredKeysElsewhere(t *testing.T) {
	e := newEnv(t, withAIEnv(app.AIEnv{AnthropicAPIKey: "sk-ant-env-4444"}))
	p := e.addProvider(t, `{"name":"Saved","kind":"anthropic","apiKey":"sk-ant-saved-5555"}`)
	for _, id := range []string{p.ID, "env-anthropic"} {
		n, lists := len(e.ai.Configs()), e.ai.ListCalls()
		res := e.testProvider(t, `{"providerId":"`+id+`","baseUrl":"https://attacker.example"}`)
		if res.OK || res.Models != nil || len(e.ai.Configs()) != n || e.ai.ListCalls() != lists {
			t.Errorf("%s: a request was made to the override without a key: %+v", id, res)
		}
		must(e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t,
			`{"providerId":"`+id+`","baseUrl":"https://attacker.example","apiKey":"sk-own-6666"}`)))
		for _, cfg := range e.ai.Configs()[n:] {
			if cfg.APIKey != "sk-own-6666" {
				t.Errorf("%s: a stored key was sent to the override: %q", id, cfg.APIKey)
			}
		}
	}
	// The same origin as the stored key still uses it.
	e.testProvider(t, `{"providerId":"`+p.ID+`","baseUrl":"https://api.anthropic.com/"}`)
	if cfg := e.lastConfig(); cfg.APIKey != "sk-ant-saved-5555" {
		t.Errorf("same-origin override: %q", cfg.APIKey)
	}
	e.testProvider(t, `{"providerId":"env-anthropic"}`)
	if cfg := e.lastConfig(); cfg.APIKey != "sk-ant-env-4444" {
		t.Errorf("environment provider: %q", cfg.APIKey)
	}
}

// A rejected update leaves the provider as it was, including a key that the
// update's origin change would otherwise have deleted.
func TestRejectedAIProviderUpdateChangesNothing(t *testing.T) {
	e := newEnv(t)
	p := e.addProvider(t, `{"name":"First","kind":"openai_compatible","model":"stub-model",
		"baseUrl":"http://first.example.test:9999/v1","apiKey":"sk-first-1234"}`)
	e.setDefault(t, p.ID)
	before := must(e.app.GetAISettings(e.ctx))
	_, err := e.patchProvider(t, p.ID, `{"baseUrl":"http://second.example.test:9999/v1","model":"two\nlines"}`)
	wantField(t, err, "model")
	other := e.addProvider(t, `{"name":"Other","kind":"anthropic"}`)
	_, err = e.patchProvider(t, p.ID, `{"baseUrl":"http://second.example.test:9999/v1","name":"other"}`)
	wantField(t, err, "name")
	if err := e.app.DeleteAIProvider(e.ctx, other.ID); err != nil {
		t.Fatal(err)
	}
	after := must(e.app.GetAISettings(e.ctx))
	b, _ := json.Marshal(before)
	a, _ := json.Marshal(after)
	if string(a) != string(b) {
		t.Errorf("a rejected update changed the settings:\n before %s\n after  %s", b, a)
	}
}

// testBound runs a connection test on e and fails unless its generation
// request was given want.
func testBound(t *testing.T, e *env, js string, want time.Duration) {
	t.Helper()
	start := time.Now()
	if res := e.testProvider(t, js); !res.OK {
		t.Fatalf("connection test: %+v", res)
	}
	end := time.Now()
	if dl := e.ai.LastDeadline(); dl.Before(start.Add(want)) || dl.After(end.Add(want)) {
		t.Errorf("the test's generation request was given %v, want %v", dl.Sub(start), want)
	}
}

// The request timeout is the saved one, else the environment's as it is,
// and it reaches every provider built for a request.
func TestAIRequestTimeout(t *testing.T) {
	const envTimeout = 7*time.Minute + 500*time.Millisecond
	e := newEnv(t, withAIEnv(app.AIEnv{Timeout: envTimeout}))
	put := func(js string) (app.AISettings, error) {
		return e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, js))
	}
	draft := func() ai.Config {
		t.Helper()
		e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
		defer func() { e.ai.Respond = nil }()
		must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`)))
		return e.lastConfig()
	}

	// Nothing saved: the environment's value, in whole seconds and unclamped.
	st := must(e.app.GetAISettings(e.ctx))
	if st.TimeoutSeconds != 420 || st.DefaultTimeoutSeconds != 420 {
		t.Errorf("initial timeout: %d, default %d", st.TimeoutSeconds, st.DefaultTimeoutSeconds)
	}
	p := e.addProvider(t, `{"name":"Mine","kind":"anthropic","apiKey":"sk-ant-mine-1234"}`)
	e.setDefault(t, p.ID)
	if cfg := draft(); cfg.Timeout != envTimeout {
		t.Errorf("unsaved timeout reaches the provider as %v", cfg.Timeout)
	}
	testBound(t, e, `{"providerId":"`+p.ID+`"}`, 90*time.Second)

	// Saving the timeout alone keeps the default provider.
	st = must(put(`{"timeoutSeconds":120}`))
	if st.TimeoutSeconds != 120 || st.DefaultTimeoutSeconds != 420 || st.DefaultProviderID == nil || *st.DefaultProviderID != p.ID {
		t.Errorf("after saving: %+v", st)
	}
	if st := must(e.app.GetAISettings(e.ctx)); st.TimeoutSeconds != 120 {
		t.Errorf("read back: %d", st.TimeoutSeconds)
	}
	if cfg := draft(); cfg.Timeout != 120*time.Second {
		t.Errorf("saved timeout reaches the provider as %v", cfg.Timeout)
	}
	testBound(t, e, `{"kind":"anthropic","apiKey":"sk-ant-other-5678"}`, 90*time.Second)
	if cfg := e.lastConfig(); cfg.Timeout != 120*time.Second {
		t.Errorf("connection test provider timeout: %v", cfg.Timeout)
	}

	// Choosing the default alone keeps the timeout.
	if st := must(put(`{"defaultProviderId":null}`)); st.TimeoutSeconds != 120 || st.DefaultProviderID != nil {
		t.Errorf("after turning AI off: %+v", st)
	}
	e.setDefault(t, p.ID)
	if st := must(put(`{}`)); st.TimeoutSeconds != 120 || st.DefaultProviderID == nil {
		t.Errorf("an empty update changed something: %+v", st)
	}

	// Out of range, alone or with a valid default: nothing is saved.
	for _, js := range []string{`{"timeoutSeconds":9}`, `{"timeoutSeconds":301}`, `{"timeoutSeconds":0}`,
		`{"timeoutSeconds":-30}`, `{"defaultProviderId":null,"timeoutSeconds":1000}`} {
		_, err := put(js)
		wantField(t, err, "timeoutSeconds")
	}
	// A valid timeout with an invalid default is not saved either.
	_, err := put(`{"defaultProviderId":"nope","timeoutSeconds":30}`)
	wantField(t, err, "defaultProviderId")
	if st := must(e.app.GetAISettings(e.ctx)); st.TimeoutSeconds != 120 || st.DefaultProviderID == nil || *st.DefaultProviderID != p.ID {
		t.Errorf("a rejected update changed the settings: %+v", st)
	}

	// The limits are inclusive; a shorter timeout bounds the test too.
	if st := must(put(`{"timeoutSeconds":300}`)); st.TimeoutSeconds != 300 {
		t.Errorf("upper limit: %d", st.TimeoutSeconds)
	}
	if st := must(put(`{"timeoutSeconds":10}`)); st.TimeoutSeconds != 10 {
		t.Errorf("lower limit: %d", st.TimeoutSeconds)
	}
	testBound(t, e, `{"providerId":"`+p.ID+`"}`, 10*time.Second)

	// The saved value survives a restart, under another environment.
	same := newEnv(t, func(o *app.Options) {
		o.Store = e.db
		o.AIEnv = app.AIEnv{Timeout: time.Minute}
	})
	if st := must(same.app.GetAISettings(same.ctx)); st.TimeoutSeconds != 10 || st.DefaultTimeoutSeconds != 60 {
		t.Errorf("after a restart: %d, default %d", st.TimeoutSeconds, st.DefaultTimeoutSeconds)
	}

	// null removes it: the environment's value applies again.
	st = must(put(`{"timeoutSeconds":null}`))
	if st.TimeoutSeconds != 420 || st.DefaultTimeoutSeconds != 420 || st.DefaultProviderID == nil {
		t.Errorf("after null: %+v", st)
	}
	if cfg := draft(); cfg.Timeout != envTimeout {
		t.Errorf("after null the provider gets %v", cfg.Timeout)
	}
	_ = e.db.Read(e.ctx, func(tx store.Tx) error {
		if _, ok, _ := tx.GetSetting("ai.timeout_seconds"); ok {
			t.Error("null should remove the saved value")
		}
		return nil
	})

	// An environment timeout shorter than 90 seconds bounds the test; none
	// at all leaves the 90 seconds.
	short := newEnv(t, withAIEnv(app.AIEnv{Timeout: 30 * time.Second}))
	testBound(t, short, `{"kind":"anthropic","apiKey":"sk-ant-short-1234"}`, 30*time.Second)
	none := newEnv(t)
	if st := must(none.app.GetAISettings(none.ctx)); st.TimeoutSeconds != 0 || st.DefaultTimeoutSeconds != 0 {
		t.Errorf("no environment timeout: %+v", st)
	}
	testBound(t, none, `{"kind":"anthropic","apiKey":"sk-ant-none-1234"}`, 90*time.Second)
	if cfg := none.lastConfig(); cfg.Timeout != 0 {
		t.Errorf("without an environment timeout the provider keeps its own: %v", cfg.Timeout)
	}
}

// A draft, variant or test case generation can name the provider it uses;
// without one it uses the default. Naming one never changes the default,
// and its usage is counted and logged under that provider.
func TestRequestsCanNameAProvider(t *testing.T) {
	e := newEnv(t, withAIEnv(app.AIEnv{AnthropicAPIKey: "sk-ant-env-7777"}))
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	ops := []string{"draft", "variant", "testcases"}
	run := func(op, extra string) (app.Usage, error) {
		t.Helper()
		switch op {
		case "draft":
			e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
			r, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"`+extra+`}`))
			return r.Usage, err
		case "variant":
			e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
			r, err := e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{"mode":"similar"`+extra+`}`))
			return r.Usage, err
		default:
			e.ai.Respond = func(ai.GenerateRequest) (any, error) {
				return map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "sum"},
					"cases": []map[string]any{{"name": "n", "rationale": "r", "stdin": "7 7", "predictedStdout": "14"}}}, nil
			}
			r, err := e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1`+extra+`}`))
			return r.Usage, err
		}
	}
	// usedBy checks that a request went to the provider with this key and
	// was logged under id.
	usedBy := func(what string, u app.Usage, id, key string) {
		t.Helper()
		if cfg := e.lastConfig(); cfg.APIKey != key {
			t.Errorf("%s: sent with key %q, want %q", what, cfg.APIKey, key)
		}
		if u.LogID == nil {
			t.Fatalf("%s: not logged", what)
		}
		if d := must(e.app.GetAILogEntry(e.ctx, *u.LogID)); d.ProviderID != id {
			t.Errorf("%s: logged under %s, want %s", what, d.ProviderID, id)
		}
	}
	named := func(id string) string { return `,"providerId":"` + id + `"` }
	work := e.addProvider(t, `{"name":"Work","kind":"anthropic","apiKey":"sk-ant-work-1111"}`)
	home := e.addProvider(t, `{"name":"Home","kind":"anthropic","model":"claude-home","apiKey":"sk-ant-home-2222"}`)
	noKey := e.addProvider(t, `{"name":"No key","kind":"anthropic"}`)

	// With no default, omitting the provider is 503; naming one works.
	for _, op := range ops {
		for _, extra := range []string{"", `,"providerId":null`} {
			_, err := run(op, extra)
			wantCode(t, err, app.CodeAIUnavailable)
		}
		u := must(run(op, named(home.ID)))
		usedBy(op+" with no default", u, home.ID, "sk-ant-home-2222")
		if cfg := e.lastConfig(); cfg.Model != "claude-home" {
			t.Errorf("%s: the provider's own model is used, got %q", op, cfg.Model)
		}
	}
	if st := must(e.app.GetAISettings(e.ctx)); st.DefaultProviderID != nil {
		t.Errorf("naming a provider chose a default: %v", *st.DefaultProviderID)
	}

	// With a default: omitted or null uses it; a named saved or environment
	// provider is used instead, and the default stays.
	e.setDefault(t, work.ID)
	for _, op := range ops {
		for _, extra := range []string{"", `,"providerId":null`} {
			usedBy(op+" with the default", must(run(op, extra)), work.ID, "sk-ant-work-1111")
		}
		usedBy(op+" naming another", must(run(op, named(home.ID))), home.ID, "sk-ant-home-2222")
		usedBy(op+" naming the environment's", must(run(op, named("  env-anthropic "))), "env-anthropic", "sk-ant-env-7777")
	}
	// A revision uses the provider it names.
	u := must(run("draft", `,"instruction":"make it harder","previousDraft":{"title":"Old"}`+named(home.ID)))
	usedBy("a revision", u, home.ID, "sk-ant-home-2222")
	if st := must(e.app.GetAISettings(e.ctx)); st.DefaultProviderID == nil || *st.DefaultProviderID != work.ID {
		t.Errorf("naming a provider changed the default: %+v", st.DefaultProviderID)
	}
	for id, want := range map[string]int64{work.ID: 6, home.ID: 7, "env-anthropic": 3, noKey.ID: 0} {
		if n := e.usageOf(t, id).AllTime.Requests; n != want {
			t.Errorf("provider %s counted %d requests, want %d", id, n, want)
		}
	}

	// An unknown, unready or blank provider is rejected before any request.
	configs, reqs := len(e.ai.Configs()), len(e.ai.Requests())
	for _, op := range ops {
		for extra, msg := range map[string]string{
			named("nope"):   "unknown provider",
			named(""):       "unknown provider",
			named(noKey.ID): "the provider is not ready — it needs an API key",
		} {
			_, err := run(op, extra)
			if ae := wantCode(t, err, app.CodeValidation); ae.Fields["providerId"] != msg {
				t.Errorf("%s %s: fields %v", op, extra, ae.Fields)
			}
		}
	}
	if len(e.ai.Configs()) != configs || len(e.ai.Requests()) != reqs {
		t.Error("a rejected provider was asked")
	}
}

// Saved providers survive a restart on the same database. A key that can no
// longer be decrypted (for example after the secret key file was lost) is
// reported as not set; model and base URL are kept.
func TestAIProvidersSurviveRestart(t *testing.T) {
	e := newEnv(t)
	p := e.addProvider(t, `{"name":"First","kind":"openai_compatible","model":"stub-model",
		"baseUrl":"http://first.example.test:9999/v1","apiKey":"sk-first-1234"}`)
	e.setDefault(t, p.ID)
	before := must(e.app.GetAISettings(e.ctx))
	same := newEnv(t, func(o *app.Options) { o.Store = e.db })
	got := must(same.app.GetAISettings(same.ctx))
	b, _ := json.Marshal(before)
	g, _ := json.Marshal(got)
	if string(b) != string(g) {
		t.Errorf("after a restart:\n before %s\n after  %s", b, g)
	}
	otherBox, _ := secrets.NewBox(bytes.Repeat([]byte{7}, 32))
	lost := newEnv(t, func(o *app.Options) { o.Store = e.db; o.Secrets = otherBox })
	oc := must(lost.app.GetAISettings(lost.ctx)).Providers[0]
	if oc.APIKeySet || oc.Model == nil || *oc.Model != "stub-model" || oc.BaseURL == nil ||
		*oc.BaseURL != "http://first.example.test:9999/v1" {
		t.Errorf("undecryptable key: %+v", oc)
	}
	// The UI's next step on the restarted instance succeeds.
	oc = must(same.patchProvider(t, p.ID, `{"baseUrl":"http://second.example.test:9999/v1"}`))
	if !oc.Ready || *oc.Model != "stub-model" || *oc.BaseURL != "http://second.example.test:9999/v1" || oc.APIKeySet {
		t.Errorf("moving the base URL after a restart: %+v", oc)
	}
}

// legacyBox is the secret box newEnv uses.
func legacyBox(t *testing.T) *secrets.Box {
	t.Helper()
	box, err := secrets.NewBox(bytes.Repeat([]byte{3}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return box
}

// writeLegacy stores settings the way versions before saved providers did.
func writeLegacy(t *testing.T, e *env, kv map[string]string) {
	t.Helper()
	if err := e.db.Write(e.ctx, func(tx store.Tx) error {
		for k, v := range kv {
			if err := tx.SetSetting(k, v); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func legacyKeyCiphertext(t *testing.T, box *secrets.Box, kind, key, origin string) string {
	t.Helper()
	ct, err := box.EncryptBound(key, kind+"\n"+origin)
	if err != nil {
		t.Fatal(err)
	}
	return ct
}

// Settings of earlier versions are carried over into providers at startup,
// once, with their keys and the active provider as the default.
func TestLegacyAISettingsAreCarriedOver(t *testing.T) {
	envVars := app.AIEnv{OpenAIBaseURL: "http://ollama:11434/v1", AnthropicModel: "claude-env"}
	e := newEnv(t, withAIEnv(envVars))
	box := legacyBox(t)
	writeLegacy(t, e, map[string]string{
		"ai.active_provider":                  "openai_compatible",
		"ai.anthropic.api_key":                legacyKeyCiphertext(t, box, "anthropic", "sk-ant-legacy-1111", "https://api.anthropic.com"),
		"ai.anthropic.api_key_origin":         "https://api.anthropic.com",
		"ai.anthropic.base_url":               "https://api.anthropic.com/",
		"ai.openai_compatible.model":          "llama3",
		"ai.openai_compatible.api_key":        legacyKeyCiphertext(t, box, "openai_compatible", "sk-local-2222", "http://ollama:11434"),
		"ai.openai_compatible.api_key_origin": "http://ollama:11434",
	})
	restarted := newEnv(t, func(o *app.Options) { o.Store = e.db; o.AIEnv = envVars })
	st := must(restarted.app.GetAISettings(restarted.ctx))
	if len(st.Providers) != 4 {
		t.Fatalf("providers: %+v", st.Providers)
	}
	oc, an := st.Providers[0], st.Providers[1]
	// The previously active kind is the default; the model and base URL it
	// took from the environment are now its own.
	if st.DefaultProviderID == nil || *st.DefaultProviderID != oc.ID || oc.Name != "OpenAI-compatible" || oc.Source != "settings" ||
		oc.Kind != "openai_compatible" || *oc.Model != "llama3" || *oc.BaseURL != "http://ollama:11434/v1" ||
		!oc.APIKeySet || *oc.APIKeyHint != "…2222" || !oc.Ready || !oc.IsDefault {
		t.Errorf("openai_compatible: %+v", oc)
	}
	if an.Name != "Anthropic" || *an.Model != "claude-env" || *an.BaseURL != "https://api.anthropic.com/" || !an.APIKeySet ||
		*an.APIKeyHint != "…1111" || !an.Ready || an.IsDefault {
		t.Errorf("anthropic: %+v", an)
	}
	if st.Providers[2].ID != "env-anthropic" || st.Providers[3].ID != "env-openai-compatible" {
		t.Errorf("environment providers: %+v", st.Providers[2:])
	}
	restarted.ai.Responses = []any{draftJSON()}
	must(restarted.app.Draft(restarted.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`)))
	if cfg := restarted.lastConfig(); cfg.APIKey != "sk-local-2222" || cfg.Model != "llama3" || cfg.BaseURL != "http://ollama:11434/v1" {
		t.Errorf("draft config: %+v", cfg)
	}
	// The old settings are gone, and a further restart changes nothing.
	_ = e.db.Read(e.ctx, func(tx store.Tx) error {
		for _, k := range []string{"ai.active_provider", "ai.anthropic.api_key", "ai.anthropic.api_key_origin",
			"ai.anthropic.base_url", "ai.openai_compatible.model"} {
			if _, ok, _ := tx.GetSetting(k); ok {
				t.Errorf("%s is still stored", k)
			}
		}
		return nil
	})
	// (The draft counts in the provider's usage; that is not a change.)
	b, _ := json.Marshal(must(restarted.app.GetAISettings(restarted.ctx)))
	again := newEnv(t, func(o *app.Options) { o.Store = e.db; o.AIEnv = envVars })
	g, _ := json.Marshal(must(again.app.GetAISettings(again.ctx)))
	if string(b) != string(g) {
		t.Errorf("a second start changed the providers:\n before %s\n after  %s", b, g)
	}
}

func TestLegacyActiveProviderIsCarriedOver(t *testing.T) {
	cases := []struct {
		name   string
		kv     map[string]string
		env    app.AIEnv
		want   string // default id; "saved" for the carried-over provider
		nSaved int
	}{
		// Explicitly off stays off, over CODEATROPHY_AI_PROVIDER.
		{"off", map[string]string{"ai.active_provider": "", "ai.anthropic.model": "claude-x"},
			app.AIEnv{Provider: "anthropic", AnthropicAPIKey: "sk-env-1234"}, "", 1},
		// An active kind that had nothing saved becomes its environment
		// provider.
		{"environment", map[string]string{"ai.active_provider": "anthropic"},
			app.AIEnv{AnthropicAPIKey: "sk-env-1234"}, "env-anthropic", 0},
		// Nothing saved: CODEATROPHY_AI_PROVIDER still picks the default.
		{"unsaved", map[string]string{"ai.openai_compatible.base_url": "http://local:8000/v1"},
			app.AIEnv{Provider: "anthropic", AnthropicAPIKey: "sk-env-1234"}, "env-anthropic", 1},
		{"saved", map[string]string{"ai.active_provider": "anthropic", "ai.anthropic.model": "claude-x"},
			app.AIEnv{}, "saved", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			writeLegacy(t, e, c.kv)
			r := newEnv(t, func(o *app.Options) { o.Store = e.db; o.AIEnv = c.env })
			st := must(r.app.GetAISettings(r.ctx))
			saved := []app.AIProvider{}
			for _, p := range st.Providers {
				if p.Source == "settings" {
					saved = append(saved, p)
				}
			}
			if len(saved) != c.nSaved {
				t.Fatalf("saved providers: %+v", saved)
			}
			want := c.want
			if want == "saved" {
				want = saved[0].ID
			}
			got := ""
			if st.DefaultProviderID != nil {
				got = *st.DefaultProviderID
			}
			if got != want {
				t.Errorf("default %q, want %q", got, want)
			}
		})
	}
}

// A carried-over key that cannot be decrypted now is kept, not dropped.
func TestLegacyKeyThatCannotBeDecryptedIsKept(t *testing.T) {
	e := newEnv(t)
	otherBox, _ := secrets.NewBox(bytes.Repeat([]byte{7}, 32))
	ct := legacyKeyCiphertext(t, otherBox, "anthropic", "sk-ant-other-3333", "https://api.anthropic.com")
	writeLegacy(t, e, map[string]string{"ai.anthropic.api_key": ct, "ai.anthropic.api_key_origin": "https://api.anthropic.com"})
	r := newEnv(t, func(o *app.Options) { o.Store = e.db })
	if p := must(r.app.GetAISettings(r.ctx)).Providers; len(p) != 1 || p[0].APIKeySet {
		t.Errorf("providers: %+v", p)
	}
	_ = e.db.Read(e.ctx, func(tx store.Tx) error {
		rs, _ := tx.ListAIProviders()
		if len(rs) != 1 || rs[0].APIKey != ct || rs[0].APIKeyOrigin != "https://api.anthropic.com" {
			t.Errorf("the ciphertext was not kept: %+v", rs)
		}
		return nil
	})
	// With the original secret key it works again.
	restored := newEnv(t, func(o *app.Options) { o.Store = e.db; o.Secrets = otherBox })
	if p := must(restored.app.GetAISettings(restored.ctx)).Providers; !p[0].APIKeySet || *p[0].APIKeyHint != "…3333" {
		t.Errorf("after restoring the secret key: %+v", p)
	}
}
