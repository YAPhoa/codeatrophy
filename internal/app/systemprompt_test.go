package app_test

import (
	"strings"
	"testing"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

func TestSystemPromptSetValidateReset(t *testing.T) {
	e := newEnv(t)
	set := func(js string) (app.SystemPrompt, error) {
		return e.app.SetSystemPrompt(e.ctx, decodeInto[app.SystemPromptInput](t, js))
	}
	sp := must(e.app.GetSystemPrompt(e.ctx))
	if sp.IsCustom || sp.Custom != nil || sp.BuiltIn != strings.TrimSpace(ai.EditableConventions) ||
		sp.Fixed != strings.TrimSpace(ai.FixedConventions) || !strings.HasPrefix(sp.DraftRules, "## Drafting rules") ||
		!strings.HasPrefix(sp.VariantRules, "## Variant rules") {
		t.Fatalf("built-in: %+v", sp)
	}
	for _, js := range []string{
		`{}`,
		`{"custom":null}`,
		`{"custom":"  \n\t "}`,
		`{"custom":"bell\u0007"}`,
		`{"custom":"esc\u001b[31m"}`,
		`{"custom":"` + strings.Repeat("é", domain.MaxSystemPromptChars+1) + `"}`,
	} {
		_, err := set(js)
		wantCode(t, err, app.CodeValidation)
	}
	if must(e.app.GetSystemPrompt(e.ctx)).IsCustom {
		t.Fatal("a rejected text was saved")
	}
	// Code points, not bytes; trimmed; CRLF normalised; newline and tab kept.
	must(set(`{"custom":"` + strings.Repeat("é", domain.MaxSystemPromptChars) + `"}`))
	sp = must(set(`{"custom":"  # Mine\r\n\n\tindented  \n"}`))
	if !sp.IsCustom || sp.Custom == nil || *sp.Custom != "# Mine\n\n\tindented" {
		t.Fatalf("custom: %+v", sp)
	}
	if got := must(e.app.GetSystemPrompt(e.ctx)); got.Custom == nil || *got.Custom != "# Mine\n\n\tindented" {
		t.Errorf("read back: %+v", got)
	}
	if c := must(e.app.Conventions(e.ctx)); c != "# Mine\n\n\tindented" {
		t.Errorf("conventions: %q", c)
	}
	// Saving the built-in text unchanged is no customisation.
	sp = must(e.app.SetSystemPrompt(e.ctx, app.SystemPromptInput{Custom: domain.Some("\n" + ai.EditableConventions + "\n")}))
	if sp.IsCustom || must(e.app.Conventions(e.ctx)) != "" {
		t.Errorf("built-in text saved as custom: %+v", sp)
	}
	must(set(`{"custom":"mine"}`))
	if err := e.app.ResetSystemPrompt(e.ctx); err != nil {
		t.Fatal(err)
	}
	if sp := must(e.app.GetSystemPrompt(e.ctx)); sp.IsCustom || sp.Custom != nil {
		t.Errorf("after reset: %+v", sp)
	}
	// Resetting twice is fine.
	if err := e.app.ResetSystemPrompt(e.ctx); err != nil {
		t.Fatal(err)
	}
}

// systemPrompts runs a draft, a variant of the problem itemID and a test
// generation for it, and returns the system prompt each one sent.
func (e *env) systemPrompts(t *testing.T, itemID string) map[string]string {
	t.Helper()
	out := map[string]string{}
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`)))
	out["draft"] = e.ai.Last().System
	must(e.app.Variant(e.ctx, itemID, decodeInto[app.VariantInput](t, `{"mode":"similar"}`)))
	out["variant"] = e.ai.Last().System
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return casesAnswer("7 7", "14"), nil }
	must(e.app.GenerateTestCases(e.ctx, itemID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1}`)))
	out["testcases"] = e.ai.Last().System
	return out
}

// The custom system prompt replaces the editable conventions in drafts and
// variants; the fixed rules and the style preset still apply, and test
// generation, which has rules of its own, is unaffected.
func TestSystemPromptReachesGenerations(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	must(e.app.CreateStylePreset(e.ctx, decodeInto[domain.StylePresetInput](t, `{"name":"Mark","instructions":"STYLE-MARKER","isDefault":true}`)))
	systems := func() map[string]string { return e.systemPrompts(t, it.ID) }
	before := systems()
	for _, op := range []string{"draft", "variant"} {
		if !strings.Contains(before[op], ai.AuthoringConventions) || !strings.Contains(before[op], "STYLE-MARKER") {
			t.Errorf("%s without a custom prompt lacks the built-in conventions or the style", op)
		}
	}
	must(e.app.SetSystemPrompt(e.ctx, app.SystemPromptInput{Custom: domain.Some("CUSTOM-CONVENTIONS")}))
	after := systems()
	for _, op := range []string{"draft", "variant"} {
		s := after[op]
		if !strings.Contains(s, "CUSTOM-CONVENTIONS\n\n"+ai.FixedConventions) || strings.Contains(s, "# Codeatrophy authoring conventions") ||
			!strings.Contains(s, "STYLE-MARKER") || strings.Index(s, "STYLE-MARKER") < strings.Index(s, "# Fixed rules") {
			t.Errorf("%s with a custom prompt:\n%s", op, s)
		}
	}
	if !strings.Contains(after["draft"], ai.DraftRules()) || !strings.Contains(after["variant"], ai.VariantRules()) {
		t.Error("the request rules must stay")
	}
	if strings.Contains(after["testcases"], "CUSTOM-CONVENTIONS") || strings.Contains(after["testcases"], "# Fixed rules") {
		t.Error("test generation does not use the conventions")
	}
	if err := e.app.ResetSystemPrompt(e.ctx); err != nil {
		t.Fatal(err)
	}
	if s := systems()["draft"]; !strings.Contains(s, ai.AuthoringConventions) || strings.Contains(s, "CUSTOM-CONVENTIONS") {
		t.Error("after a reset drafts use the built-in conventions again")
	}
}
