package app_test

import (
	"strings"
	"testing"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

// The test case prompt is saved and validated like the system prompt (see
// TestSystemPromptSetValidateReset), under a key of its own.
func TestTestCasePromptSetAndReset(t *testing.T) {
	e := newEnv(t)
	tp := must(e.app.GetTestCasePrompt(e.ctx))
	if tp.IsCustom || tp.Custom != nil || tp.BuiltIn != strings.TrimSpace(ai.EditableTestCaseRules) ||
		tp.Fixed != strings.TrimSpace(ai.FixedTestCaseRules()) || !strings.HasPrefix(tp.Fixed, "# Fixed rules") {
		t.Fatalf("built-in: %+v", tp)
	}
	tp = must(e.app.SetTestCasePrompt(e.ctx, decodeInto[app.TestCasePromptInput](t, `{"custom":"  # Mine\r\n\tindented  \n"}`)))
	if !tp.IsCustom || tp.Custom == nil || *tp.Custom != "# Mine\n\tindented" {
		t.Fatalf("custom: %+v", tp)
	}
	if got := must(e.app.GetTestCasePrompt(e.ctx)); got.Custom == nil || *got.Custom != "# Mine\n\tindented" {
		t.Errorf("read back: %+v", got)
	}
	// It is a setting of its own: the system prompt is untouched, and
	// resetting that leaves this one.
	if sp := must(e.app.GetSystemPrompt(e.ctx)); sp.IsCustom {
		t.Errorf("the system prompt changed: %+v", sp)
	}
	must(e.app.SetSystemPrompt(e.ctx, app.SystemPromptInput{Custom: domain.Some("conventions")}))
	if err := e.app.ResetSystemPrompt(e.ctx); err != nil {
		t.Fatal(err)
	}
	if !must(e.app.GetTestCasePrompt(e.ctx)).IsCustom {
		t.Error("resetting the system prompt reset the test case prompt")
	}
	if err := e.app.ResetTestCasePrompt(e.ctx); err != nil {
		t.Fatal(err)
	}
	if tp := must(e.app.GetTestCasePrompt(e.ctx)); tp.IsCustom || tp.Custom != nil {
		t.Errorf("after reset: %+v", tp)
	}
}

// The custom test case prompt replaces the editable test-case rules in test
// generation, and the fixed rules always follow; drafts and variants are
// unaffected.
func TestTestCasePromptReachesGeneration(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	systems := func() map[string]string { return e.systemPrompts(t, it.ID) }
	fixedRules := strings.TrimSuffix(ai.FixedTestCaseRules(), "Respond with a single JSON object that matches the provided schema, and nothing else.")
	before := systems()
	builtIn := func(s string) bool {
		return strings.Contains(s, "correct, efficient") && strings.Contains(s, "Cover: the examples")
	}
	if !builtIn(before["testcases"]) || strings.Contains(before["testcases"], "# Fixed rules") {
		t.Errorf("without a custom prompt test generation uses the built-in rules:\n%s", before["testcases"])
	}

	must(e.app.SetTestCasePrompt(e.ctx, app.TestCasePromptInput{Custom: domain.Some("CUSTOM-TEST-DESIGN")}))
	after := systems()
	s := after["testcases"]
	if !strings.Contains(s, "CUSTOM-TEST-DESIGN\n\n"+fixedRules) || strings.Contains(s, "Cover: the examples") || strings.Contains(s, "correct, efficient") ||
		!strings.HasSuffix(s, "and nothing else.") {
		t.Errorf("test generation with a custom prompt:\n%s", s)
	}
	for _, op := range []string{"draft", "variant"} {
		if strings.Contains(after[op], "CUSTOM-TEST-DESIGN") || after[op] == "" {
			t.Errorf("%s carries the test case prompt", op)
		}
	}

	// The large-case rules still follow when large cases are asked for.
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		answer := casesAnswer("7 7", "14")
		answer["largeCases"] = []map[string]any{{"name": "big", "rationale": "r", "language": "python", "source": "print(1, 1)"}}
		return answer, nil
	}
	_, _ = e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1,"largeTestCases":1}`))
	if s := e.ai.Last().System; !strings.Contains(s, "CUSTOM-TEST-DESIGN") || !strings.Contains(s, `"largeCases"`) {
		t.Errorf("with large cases:\n%s", s)
	}

	if err := e.app.ResetTestCasePrompt(e.ctx); err != nil {
		t.Fatal(err)
	}
	if s := systems()["testcases"]; strings.Contains(s, "CUSTOM-TEST-DESIGN") || !builtIn(s) {
		t.Error("after a reset test generation uses the built-in rules again")
	}
}
