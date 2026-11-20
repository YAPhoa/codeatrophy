package ai

import (
	"strings"
	"testing"
)

// Every part of the built-in test-case rules is either editable or fixed, an
// editable part restates the rules it carries that the app depends on, and
// the fixed rules hold those rules.
func TestTestCaseRulesSplit(t *testing.T) {
	for _, p := range tcParts {
		inFixed, inEditable := strings.Contains(fixedTestCaseRules, p.text), strings.Contains(EditableTestCaseRules, p.text)
		if inFixed == inEditable || inFixed != p.fixed {
			t.Errorf("part %.60q: fixed %v, in fixed view %v, in editable view %v", p.text, p.fixed, inFixed, inEditable)
		}
		if p.fixed == (p.keep != "") || (p.keep != "" && !strings.Contains(fixedTestCaseRules, p.keep)) {
			t.Errorf("part %.60q: only an editable part restates its rules, among the fixed ones", p.text)
		}
	}
	fixed := FixedTestCaseRules()
	for _, want := range []string{"reads stdin and writes stdout exactly in the format", "the harness prefix, your\n  solution and the harness suffix",
		"one JSON value per line", "language versions the judge runs", "under about 100 KB", `"predictedStdout"`,
		"The server will run the solution", "(isSample: true)", `"public class Main"`, `"fun main()"`, jsonOnly} {
		if !strings.Contains(fixed, want) {
			t.Errorf("%q should be a fixed rule", want)
		}
	}
	for _, want := range []string{"correct, efficient reference solution", "Cover: the examples", "one-sentence rationale"} {
		if !strings.Contains(EditableTestCaseRules, want) || strings.Contains(fixed, want) {
			t.Errorf("%q should be editable", want)
		}
	}
	for _, gone := range []string{"public class Main", "predictedStdout", "harness suffix", "isSample", "Respond with"} {
		if strings.Contains(EditableTestCaseRules, gone) {
			t.Errorf("the editable rules carry the fixed %q", gone)
		}
	}
	if !strings.HasPrefix(fixed, "# Fixed rules\n\n") || !strings.HasSuffix(fixed, jsonOnly) {
		t.Errorf("fixed rules:\n%s", fixed)
	}
	for _, blank := range []string{"", " \n\t"} {
		if testCaseRules(blank, LargeCases{}) != builtinTestCaseRules+"\n"+jsonOnly {
			t.Error("a blank custom text means the built-in rules")
		}
	}
}

// A custom test case prompt replaces the editable rules; the fixed rules,
// the large-case rules and the user prompt stay, and the authoring
// conventions stay out.
func TestCustomTestCasePromptReplacesTheEditableRules(t *testing.T) {
	const custom = "# My tests\n\nAlways include a case with n = 1."
	base := TestCasesPrompt{Problem: "{}", Count: 3, Language: "python", Instruction: "edge"}
	withCustom := base
	withCustom.Guidance = custom
	builtSys, builtUser := base.Build()
	sys, user := withCustom.Build()
	if !strings.Contains(sys, "## Data blocks") || !strings.Contains(sys, custom+"\n\n"+FixedTestCaseRules()) || !strings.HasSuffix(sys, jsonOnly) {
		t.Errorf("the custom text, then the fixed rules:\n%s", sys)
	}
	for _, gone := range []string{"Cover: the examples", "correct, efficient", "# Codeatrophy authoring conventions", "# Fixed rules\n\nThese rules are how the app works, and they always apply. Where the\nconventions"} {
		if strings.Contains(sys, gone) {
			t.Errorf("a custom prompt still carries %q", gone)
		}
	}
	if nonceFree(user, nonceOf(t, user)) != nonceFree(builtUser, nonceOf(t, builtUser)) {
		t.Error("the user prompt is the same with a custom text")
	}
	if strings.Contains(builtSys, "# Fixed rules") {
		t.Error("the built-in prompt has no fixed-rules section")
	}

	withCustom.Large = LargeCases{Count: 2, MaxBytes: 500}
	sys, _ = withCustom.Build()
	if !strings.HasSuffix(sys, custom+"\n\n"+fixedTestCaseRules+largeCaseRules(withCustom.Large)+"\n"+jsonOnly) {
		t.Errorf("the large-case rules follow the fixed rules:\n%s", sys)
	}
	// That the custom text cannot open or close a block is checked with the
	// other slots in TestPromptSlotsCannotBreakOut.
}

func nonceFree(s, nonce string) string { return strings.ReplaceAll(s, nonce, "NONCE") }
