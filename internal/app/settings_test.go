package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store"
)

func TestAISettingsKeysAreWriteOnly(t *testing.T) {
	e := newEnv(t)
	st := must(e.app.GetAISettings(e.ctx))
	if st.ActiveProvider != nil || len(st.Providers) != 2 || st.Providers["anthropic"].Ready || st.Providers["anthropic"].APIKeySet {
		t.Fatalf("initial: %+v", st)
	}
	if *st.Defaults["anthropic"].Model != "default-model" || st.Defaults["openai_compatible"].Model != nil {
		t.Errorf("defaults: %+v", st.Defaults)
	}
	// Selecting a provider that is not ready is rejected.
	_, err := e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"activeProvider":"anthropic"}`))
	wantCode(t, err, app.CodeValidation)

	const key = "sk-ant-api03-supersecret-x7Qa"
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t,
		`{"activeProvider":"anthropic","providers":{"anthropic":{"apiKey":"`+key+`"}}}`)))
	b, _ := json.Marshal(st)
	if strings.Contains(string(b), "supersecret") {
		t.Fatalf("the key is echoed: %s", b)
	}
	p := st.Providers["anthropic"]
	if !p.APIKeySet || *p.APIKeyHint != "…x7Qa" || *p.APIKeySource != "settings" || !p.Ready || *st.ActiveProvider != "anthropic" {
		t.Errorf("after save: %+v", p)
	}
	// The key is encrypted at rest.
	_ = e.db.Read(e.ctx, func(tx store.Tx) error {
		v, ok, _ := tx.GetSetting("ai.anthropic.api_key")
		if !ok || strings.Contains(v, "supersecret") {
			t.Errorf("stored value is not encrypted: %q", v)
		}
		return nil
	})
	// The provider receives the key and the default model.
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`)))
	cfg := e.ai.Configs()[len(e.ai.Configs())-1]
	if cfg.APIKey != key || cfg.Model != "default-model" {
		t.Errorf("provider config: %+v", cfg)
	}
	meta := must(e.app.Meta(e.ctx))
	if !meta.AI.Enabled || *meta.AI.Provider != "anthropic" || *meta.AI.Model != "default-model" {
		t.Errorf("meta ai: %+v", meta.AI)
	}
	// Omitted apiKey keeps it; model null clears the saved model.
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"providers":{"anthropic":{"model":"claude-x"}}}`)))
	if !st.Providers["anthropic"].APIKeySet || *st.Providers["anthropic"].Model != "claude-x" {
		t.Errorf("model update: %+v", st.Providers["anthropic"])
	}
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"providers":{"anthropic":{"model":null}}}`)))
	if st.Providers["anthropic"].Model != nil {
		t.Error("model null should clear it")
	}
	// Turning AI off.
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"activeProvider":null}`)))
	if st.ActiveProvider != nil {
		t.Error("activeProvider null should turn AI off")
	}
	_, err = e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	wantCode(t, err, app.CodeAIUnavailable)
	// Deleting the key.
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"providers":{"anthropic":{"apiKey":null}}}`)))
	if st.Providers["anthropic"].APIKeySet || st.Providers["anthropic"].APIKeyHint != nil {
		t.Errorf("after delete: %+v", st.Providers["anthropic"])
	}
	for _, js := range []string{
		`{"activeProvider":"gemini"}`,
		`{"providers":{"gemini":{}}}`,
		`{"providers":{"openai_compatible":{"baseUrl":"not a url"}}}`,
		`{"providers":{"anthropic":{"apiKey":"has spaces in it"}}}`,
	} {
		_, err := e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, js))
		wantCode(t, err, app.CodeValidation)
	}
}

func TestAISettingsEnvironmentFallback(t *testing.T) {
	e := newEnv(t, withAIEnv(app.AIEnv{Provider: "openai_compatible", OpenAIModel: "llama3", OpenAIBaseURL: "http://ollama:11434/v1",
		AnthropicAPIKey: "env-key-abcd"}))
	st := must(e.app.GetAISettings(e.ctx))
	oc := st.Providers["openai_compatible"]
	if *st.ActiveProvider != "openai_compatible" || !oc.Ready || oc.APIKeySet || *oc.Model != "llama3" ||
		*oc.ModelSource != "environment" || *oc.BaseURLSource != "environment" {
		t.Errorf("env openai: %+v %+v", st.ActiveProvider, oc)
	}
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"providers":{"openai_compatible":{"model":"saved"}}}`)))
	if oc := st.Providers["openai_compatible"]; *oc.ModelSource != "settings" || *oc.BaseURLSource != "environment" {
		t.Errorf("sources after save: %+v", oc)
	}
	if an := st.Providers["anthropic"]; an.ModelSource != nil || an.Model != nil || !an.Ready {
		t.Errorf("the default model applies with source null: %+v", an)
	}
	an := st.Providers["anthropic"]
	if !an.APIKeySet || *an.APIKeySource != "environment" || *an.APIKeyHint != "…abcd" {
		t.Errorf("env anthropic: %+v", an)
	}
	// A saved key overrides the environment, and deleting it restores it.
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"providers":{"anthropic":{"apiKey":"saved-key-wxyz"}}}`)))
	if *st.Providers["anthropic"].APIKeySource != "settings" {
		t.Error("saved key should win")
	}
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"providers":{"anthropic":{"apiKey":null}}}`)))
	if *st.Providers["anthropic"].APIKeySource != "environment" {
		t.Error("environment key should apply again")
	}
	// Turning AI off is remembered over the environment default.
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"activeProvider":null}`)))
	if st.ActiveProvider != nil {
		t.Error("explicit off should override CODEATROPHY_AI_PROVIDER")
	}
	// ready counts defaults: openai_compatible's base URL defaults to the
	// OpenAI endpoint, which needs a key as well as a model.
	e2 := newEnv(t, withAIEnv(app.AIEnv{OpenAIModel: "gpt-x"}))
	oc = must(e2.app.GetAISettings(e2.ctx)).Providers["openai_compatible"]
	if oc.Ready || *oc.ModelSource != "environment" || oc.BaseURLSource != nil || oc.BaseURL != nil {
		t.Errorf("the default OpenAI endpoint without a key is not ready: %+v", oc)
	}
	e3 := newEnv(t, withAIEnv(app.AIEnv{OpenAIModel: "gpt-x", OpenAIAPIKey: "sk-env-1234"}))
	if oc = must(e3.app.GetAISettings(e3.ctx)).Providers["openai_compatible"]; !oc.Ready {
		t.Errorf("defaults with an environment key: %+v", oc)
	}
}

func TestAIProviderConnectionTest(t *testing.T) {
	e := newEnv(t)
	res := must(e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, `{"provider":"anthropic"}`)))
	if res.OK || res.Error == nil {
		t.Errorf("without a key: %+v", res)
	}
	res = must(e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, `{"provider":"anthropic","apiKey":"sk-ant-trial-9876","model":"claude-t"}`)))
	if !res.OK || res.LatencyMs == nil || res.Error != nil {
		t.Errorf("test with override: %+v", res)
	}
	cfg := e.ai.Configs()[len(e.ai.Configs())-1]
	if cfg.APIKey != "sk-ant-trial-9876" || cfg.Model != "claude-t" || !e.ai.Last().Light {
		t.Errorf("override config: %+v", cfg)
	}
	// Nothing is saved.
	if must(e.app.GetAISettings(e.ctx)).Providers["anthropic"].APIKeySet {
		t.Error("the test must not save the key")
	}
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return nil, fmt.Errorf("upstream said: invalid x-api-key sk-ant-trial-9876")
	}
	res = must(e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, `{"provider":"anthropic","apiKey":"sk-ant-trial-9876"}`)))
	if res.OK || res.Error == nil || strings.Contains(*res.Error, "sk-ant-trial-9876") {
		t.Errorf("failure must be reported without the key: %+v", res)
	}
	_, err := e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, `{"provider":"nope"}`))
	wantCode(t, err, app.CodeValidation)
}

func TestStylePresetCRUDAndLimits(t *testing.T) {
	e := newEnv(t)
	create := func(js string) (domain.StylePreset, error) {
		return e.app.CreateStylePreset(e.ctx, decodeInto[domain.StylePresetInput](t, js))
	}
	a := must(create(`{"name":"  Beta  ","instructions":" one \n two ","isDefault":true}`))
	if a.Name != "Beta" || a.Instructions != "one \n two" || !a.IsDefault {
		t.Errorf("trimmed: %+v", a)
	}
	b := must(create(`{"name":"alpha","instructions":"x"}`))
	// Names are unique case-insensitively, including non-ASCII.
	_, err := create(`{"name":"BETA","instructions":"x"}`)
	wantCode(t, err, app.CodeValidation)
	must(create(`{"name":"Ärger","instructions":"x"}`))
	_, err = create(`{"name":"ärger","instructions":"x"}`)
	wantCode(t, err, app.CodeValidation)
	for _, js := range []string{
		`{"instructions":"x"}`,
		`{"name":"x"}`,
		`{"name":"x","instructions":"` + strings.Repeat("é", domain.MaxStyleInstructionsChars+1) + `"}`,
		`{"name":"` + strings.Repeat("名", domain.MaxStyleNameChars+1) + `","instructions":"x"}`,
		`{"name":"x","instructions":"bell\u0007"}`,
		`{"name":"x","instructions":"   "}`,
	} {
		_, err := create(js)
		wantCode(t, err, app.CodeValidation)
	}
	must(create(`{"name":"` + strings.Repeat("名", domain.MaxStyleNameChars) + `","instructions":"` + strings.Repeat("é", domain.MaxStyleInstructionsChars) + `"}`))

	// Single default: setting it on one clears the others.
	b = must(e.app.UpdateStylePreset(e.ctx, b.ID, decodeInto[domain.StylePresetInput](t, `{"isDefault":true}`)))
	list := must(e.app.ListStylePresets(e.ctx)).Items
	defaults := 0
	for _, p := range list {
		if p.IsDefault {
			defaults++
		}
	}
	if defaults != 1 || list[0].ID != b.ID {
		t.Errorf("single default, listed first: %+v", list)
	}
	// Renaming onto another preset's name is rejected; keeping one's own name is fine.
	_, err = e.app.UpdateStylePreset(e.ctx, b.ID, decodeInto[domain.StylePresetInput](t, `{"name":"beta"}`))
	wantCode(t, err, app.CodeValidation)
	must(e.app.UpdateStylePreset(e.ctx, b.ID, decodeInto[domain.StylePresetInput](t, `{"name":"ALPHA"}`)))
	_, err = e.app.UpdateStylePreset(e.ctx, b.ID, decodeInto[domain.StylePresetInput](t, `{"instructions":null}`))
	wantCode(t, err, app.CodeValidation)
	// Deleting the default leaves no default.
	if err := e.app.DeleteStylePreset(e.ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	if def := must(e.app.DefaultStylePreset(e.ctx)); def != nil {
		t.Errorf("default after delete: %+v", def)
	}
	wantCode(t, e.app.DeleteStylePreset(e.ctx, b.ID), app.CodeNotFound)

	// At most 20 presets; the 21st is a conflict.
	n := len(must(e.app.ListStylePresets(e.ctx)).Items)
	for i := n; i < domain.MaxStylePresets; i++ {
		must(create(fmt.Sprintf(`{"name":"preset %d","instructions":"x"}`, i)))
	}
	_, err = create(`{"name":"twenty-first","instructions":"x"}`)
	wantCode(t, err, app.CodeConflict)
}

func TestStylePresetsSurviveProviderChanges(t *testing.T) {
	e := newEnv(t)
	p := must(e.app.CreateStylePreset(e.ctx, decodeInto[domain.StylePresetInput](t, `{"name":"Keep","instructions":"x","isDefault":true}`)))
	e.enableAI(t)
	must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"activeProvider":null}`)))
	if def := must(e.app.DefaultStylePreset(context.Background())); def == nil || def.ID != p.ID {
		t.Error("presets are independent of the AI provider")
	}
}

// A key is only ever sent to the origin it was stored for.
func TestAPIKeyIsBoundToItsOrigin(t *testing.T) {
	e := newEnv(t)
	put := func(js string) app.ProviderSettings {
		return must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, js))).Providers["anthropic"]
	}
	if st := put(`{"activeProvider":"anthropic","providers":{"anthropic":{"apiKey":"sk-ant-saved-1111"}}}`); !st.APIKeySet || !st.Ready {
		t.Fatalf("saved key: %+v", st)
	}
	// Moving the base URL to another origin without a new key deletes it.
	if st := put(`{"providers":{"anthropic":{"baseUrl":"https://proxy.example/v1"}}}`); st.APIKeySet || st.Ready {
		t.Errorf("key kept across an origin change: %+v", st)
	}
	// ...for good: moving back does not bring it back.
	if st := put(`{"providers":{"anthropic":{"baseUrl":null}}}`); st.APIKeySet {
		t.Errorf("the key was only hidden: %+v", st)
	}
	// A key saved with a base URL is bound to that origin; a path change on
	// the same origin keeps it.
	put(`{"providers":{"anthropic":{"baseUrl":"https://proxy.example/v1","apiKey":"sk-ant-proxy-2222"}}}`)
	if st := put(`{"providers":{"anthropic":{"baseUrl":"https://proxy.example/other"}}}`); !st.APIKeySet {
		t.Errorf("same origin, new path: %+v", st)
	}
	e.ai.Responses = []any{draftJSON()}
	must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`)))
	if cfg := e.ai.Configs()[len(e.ai.Configs())-1]; cfg.APIKey != "sk-ant-proxy-2222" || cfg.BaseURL != "https://proxy.example/other" {
		t.Errorf("draft config: key %q base %q", cfg.APIKey, cfg.BaseURL)
	}
}

// The environment key belongs to the environment (or default) base URL.
func TestEnvironmentKeyIsBoundToItsBaseURL(t *testing.T) {
	e := newEnv(t, withAIEnv(app.AIEnv{Provider: "anthropic", AnthropicAPIKey: "sk-ant-env-3333"}))
	st := must(e.app.GetAISettings(e.ctx)).Providers["anthropic"]
	if !st.APIKeySet || !st.Ready {
		t.Fatalf("env key on the default base URL: %+v", st)
	}
	st = must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t,
		`{"providers":{"anthropic":{"baseUrl":"https://elsewhere.example"}}}`))).Providers["anthropic"]
	if st.APIKeySet || st.Ready {
		t.Errorf("env key offered to another origin: %+v", st)
	}
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	wantCode(t, err, app.CodeAIUnavailable)
	for _, cfg := range e.ai.Configs() {
		if cfg.APIKey == "sk-ant-env-3333" && cfg.BaseURL == "https://elsewhere.example" {
			t.Error("the environment key was sent to the overridden base URL")
		}
	}
}

// A connection test against another origin uses only a key from the same
// request.
func TestConnectionTestDoesNotSendSavedKeyElsewhere(t *testing.T) {
	e := newEnv(t, withAIEnv(app.AIEnv{AnthropicAPIKey: "sk-ant-env-4444"}))
	must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"providers":{"anthropic":{"apiKey":"sk-ant-saved-5555"}}}`)))
	n := len(e.ai.Configs())
	res := must(e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, `{"provider":"anthropic","baseUrl":"https://attacker.example"}`)))
	for _, cfg := range e.ai.Configs()[n:] {
		if cfg.APIKey != "" {
			t.Errorf("a stored key was sent to the override: %q", cfg.APIKey)
		}
	}
	if res.OK {
		t.Errorf("no key for the override: %+v", res)
	}
	must(e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, `{"provider":"anthropic","baseUrl":"https://attacker.example","apiKey":"sk-own-6666"}`)))
	if cfg := e.ai.Configs()[len(e.ai.Configs())-1]; cfg.APIKey != "sk-own-6666" {
		t.Errorf("request key: %q", cfg.APIKey)
	}
	// The same origin as the saved key still uses it.
	must(e.app.TestAIProvider(e.ctx, decodeInto[app.AITestInput](t, `{"provider":"anthropic","baseUrl":"https://api.anthropic.com/"}`)))
	if cfg := e.ai.Configs()[len(e.ai.Configs())-1]; cfg.APIKey != "sk-ant-saved-5555" {
		t.Errorf("same-origin override: %q", cfg.APIKey)
	}
}

// A rejected update leaves every stored setting as it was, including a key
// that the update's origin change would otherwise have deleted.
func TestRejectedAISettingsUpdateChangesNothing(t *testing.T) {
	e := newEnv(t)
	put := func(js string) (app.AISettings, error) {
		return e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, js))
	}
	before := must(put(`{"activeProvider":"openai_compatible","providers":{"openai_compatible":
		{"model":"stub-model","baseUrl":"http://first.example.test:9999/v1","apiKey":"sk-first-1234"}}}`))
	_, err := put(`{"activeProvider":"anthropic","providers":{"openai_compatible":{"baseUrl":"http://second.example.test:9999/v1","model":null}}}`)
	wantField(t, err, "activeProvider")
	after := must(e.app.GetAISettings(e.ctx))
	b, _ := json.Marshal(before)
	a, _ := json.Marshal(after)
	if string(a) != string(b) {
		t.Errorf("a rejected update changed the settings:\n before %s\n after  %s", b, a)
	}
}

// Saved provider settings survive a restart on the same database. A key
// that can no longer be decrypted (for example after the secret key file
// was lost) is reported as not set; model and base URL are kept.
func TestAISettingsSurviveRestart(t *testing.T) {
	e := newEnv(t)
	must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"activeProvider":"openai_compatible",
		"providers":{"openai_compatible":{"model":"stub-model","baseUrl":"http://first.example.test:9999/v1","apiKey":"sk-first-1234"}}}`)))
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
	oc := must(lost.app.GetAISettings(lost.ctx)).Providers["openai_compatible"]
	if oc.APIKeySet || oc.Model == nil || *oc.Model != "stub-model" || oc.BaseURL == nil || *oc.BaseURL != "http://first.example.test:9999/v1" {
		t.Errorf("undecryptable key: %+v", oc)
	}
	// The UI's next step on the restarted instance succeeds.
	st := must(same.app.UpdateAISettings(same.ctx, decodeInto[app.AISettingsInput](t,
		`{"activeProvider":"openai_compatible","providers":{"openai_compatible":{"baseUrl":"http://second.example.test:9999/v1"}}}`)))
	oc = st.Providers["openai_compatible"]
	if !oc.Ready || *oc.Model != "stub-model" || *oc.BaseURL != "http://second.example.test:9999/v1" || oc.APIKeySet {
		t.Errorf("moving the base URL after a restart: %+v", oc)
	}
}

// Validation messages are readable sentences; fields stay machine-readable.
func TestValidationMessagesAreSentences(t *testing.T) {
	e := newEnv(t)
	_, err := e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"activeProvider":"openai_compatible"}`))
	if ae := wantCode(t, err, app.CodeValidation); ae.Message != "activeProvider: the provider is not ready — it needs a model and a base URL" ||
		ae.Fields["activeProvider"] != "the provider is not ready — it needs a model and a base URL" {
		t.Errorf("message %q, fields %v", ae.Message, ae.Fields)
	}
	_, err = e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"nope":1}`))
	if ae := wantCode(t, err, app.CodeValidation); ae.Message != "nope: unknown preference" {
		t.Errorf("message %q", ae.Message)
	}
	_, err = e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"","problem":{"timeLimitMs":1}}`))
	if ae := wantCode(t, err, app.CodeValidation); !strings.HasPrefix(ae.Message, "problem.timeLimitMs: ") ||
		!strings.HasSuffix(ae.Message, "(and 1 more problem)") || len(ae.Fields) != 2 {
		t.Errorf("message %q, fields %v", ae.Message, ae.Fields)
	}
}
