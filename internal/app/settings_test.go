package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"codeathropy/internal/ai"
	"codeathropy/internal/app"
	"codeathropy/internal/domain"
	"codeathropy/internal/store"
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
		t.Error("explicit off should override CODEATHROPY_AI_PROVIDER")
	}
	// ready counts defaults: a model is enough for openai_compatible,
	// whose base URL defaults to the OpenAI endpoint.
	e2 := newEnv(t, withAIEnv(app.AIEnv{OpenAIModel: "gpt-x"}))
	oc = must(e2.app.GetAISettings(e2.ctx)).Providers["openai_compatible"]
	if !oc.Ready || *oc.ModelSource != "environment" || oc.BaseURLSource != nil || oc.BaseURL != nil {
		t.Errorf("defaults count for readiness: %+v", oc)
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
