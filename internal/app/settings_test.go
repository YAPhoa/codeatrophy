package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

// The field rules are domain.ValidateStylePreset's, tested there.
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
	must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t, `{"defaultProviderId":null}`)))
	if def := must(e.app.DefaultStylePreset(context.Background())); def == nil || def.ID != p.ID {
		t.Error("presets are independent of the AI provider")
	}
}

// Validation messages are readable sentences; fields stay machine-readable.
func TestValidationMessagesAreSentences(t *testing.T) {
	e := newEnv(t)
	p := e.addProvider(t, `{"name":"Local","kind":"openai_compatible","baseUrl":"http://localhost:11434/v1"}`)
	_, err := e.app.UpdateAISettings(e.ctx, app.AISettingsInput{DefaultProviderID: domain.Some(p.ID)})
	if ae := wantCode(t, err, app.CodeValidation); ae.Message != "defaultProviderId: the provider is not ready — it needs a model" ||
		ae.Fields["defaultProviderId"] != "the provider is not ready — it needs a model" {
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
