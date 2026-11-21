package ai

import (
	"flag"
	"os"
	"regexp"
	"strings"
	"testing"
)

var updateGolden = flag.Bool("update", false, "rewrite the golden prompts in testdata")

var nonceRe = regexp.MustCompile(`suffix ([0-9a-f]{24}) is unique`)

// stableNonce replaces a prompt's envelope nonce with a fixed word, so that
// two builds of the same prompt compare equal.
func stableNonce(system, user string) string {
	out := system + "\n=== user ===\n" + user
	if m := nonceRe.FindStringSubmatch(system); m != nil {
		out = strings.ReplaceAll(out, m[1], "NONCE")
	}
	return out
}

// builtinPrompts renders every prompt with the built-in conventions, over a
// spread of inputs.
func builtinPrompts() string {
	style := &Style{Name: "Terse", Instructions: "Short statements.\nPython only."}
	tools := []Toolchain{{Language: "python", Version: "3.8.1"}, {Language: "go", Version: "1.13.5"}}
	prev := `{"title":"x","` + OmittedCasesKey + `":["big (300 KB)"]}`
	var b strings.Builder
	add := func(name, system, user string) {
		b.WriteString("##### " + name + "\n" + stableNonce(system, user) + "\n")
	}
	s, u := DraftPrompt{Text: "two sum", InterfaceHint: "auto"}.Build()
	add("draft plain", s, u)
	s, u = DraftPrompt{Style: style, Text: "two sum", TypeHint: "problem", InterfaceHint: "function", Instruction: "harder",
		PreviousDraft: prev, Toolchains: tools, Large: LargeCases{Count: 3, MaxBytes: 1000}}.Build()
	add("draft full", s, u)
	s, u = DraftPrompt{Text: "a note", TypeHint: "reading", Large: LargeCases{Count: 1, MaxBytes: 500}}.Build()
	add("draft reading", s, u)
	s, u = VariantPrompt{Original: "{}", Mode: "similar"}.Build()
	add("variant plain", s, u)
	s, u = VariantPrompt{Style: style, Original: `{"title":"o"}`, Mode: "twist", Interface: "program", Instruction: "smaller",
		PreviousDraft: prev, Toolchains: tools, Large: LargeCases{Count: 2, MaxBytes: 900}}.Build()
	add("variant full", s, u)
	s, u = TestCasesPrompt{Problem: "{}", Count: 4, Language: "python"}.Build()
	add("testcases plain", s, u)
	s, u = TestCasesPrompt{Problem: "{}", ExistingCases: "--- a\n1\n", Function: true, Count: 2, Language: "go",
		ExistingSolution: "x", Instruction: "edge", Toolchains: tools, Large: LargeCases{Count: 1, MaxBytes: 100}}.Build()
	add("testcases full", s, u)
	s, u = CodePrompt{Problem: "{}", Languages: []string{"python", "cpp"}}.Build()
	add("code plain", s, u)
	s, u = CodePrompt{Style: style, Problem: `{"title":"t"}`, Function: true, Languages: []string{"go"}, Toolchains: tools}.Build()
	add("code full", s, u)
	add("guide plain", AuthoringGuide("", nil), "")
	add("guide style", AuthoringGuide("", style), "")
	env := NewEnvelope(GuideTexts("", style)...)
	add("guide in", env.Rules()+"\n"+AuthoringGuideIn(env, "", style), "")
	s, u = DraftPrompt{Text: "two sum", TypeHint: "problem", Toolchains: tools, TestCases: 8,
		Large: LargeCases{Count: 2, MaxBytes: 1000}}.Build()
	add("draft test cases", s, u)
	s, u = VariantPrompt{Original: `{"title":"o"}`, Mode: "harder", Interface: "function", TestCases: 1}.Build()
	add("variant one test case", s, u)
	return b.String()
}

// The prompts sent without a custom system prompt stay exactly as they were
// before the conventions became editable.
func TestBuiltinPromptsUnchanged(t *testing.T) {
	const path = "testdata/builtin-prompts.golden"
	got := builtinPrompts()
	if *updateGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		gl, wl := strings.Split(got, "\n"), strings.Split(string(want), "\n")
		for i := range min(len(gl), len(wl)) {
			if gl[i] != wl[i] {
				t.Fatalf("built-in prompts changed at line %d:\n got: %q\nwant: %q", i+1, gl[i], wl[i])
			}
		}
		t.Fatalf("built-in prompts changed: %d lines, want %d", len(gl), len(wl))
	}
}

// Every part of the built-in conventions is either editable or fixed, and
// the fixed rules hold the rules the app depends on.
func TestConventionsSplit(t *testing.T) {
	for _, p := range convParts {
		if p.heading != "" {
			continue
		}
		inFixed, inEditable := strings.Contains(FixedConventions, p.text), strings.Contains(EditableConventions, p.text)
		if inFixed == inEditable || inFixed != p.fixed {
			t.Errorf("part %.60q: fixed %v, in fixed view %v, in editable view %v", p.text, p.fixed, inFixed, inEditable)
		}
	}
	for _, want := range []string{"**stdin/stdout** basis", "The **interface** says what the solver writes", "# region input",
		"public class Main", "**harness suffix** reads one test case", "from __future__ import annotations",
		"Language ids:", "Python 3.8", "compared token by token", "(`isSample: true`)", "Expected outputs must come from running a reference solution",
		"`<summary>Answer</summary>`"} {
		if !strings.Contains(FixedConventions, want) || strings.Contains(EditableConventions, want) {
			t.Errorf("%q should be a fixed rule", want)
		}
	}
	for _, want := range []string{"# Codeatrophy authoring conventions", "these sections, in this order", "A good test set covers",
		"well-structured Markdown article", "Never use an em dash", "Choose `function` for an algorithmic problem"} {
		if !strings.Contains(EditableConventions, want) || strings.Contains(FixedConventions, want) {
			t.Errorf("%q should be editable", want)
		}
	}
	if !strings.HasPrefix(FixedConventions, "# Fixed rules\n\n") || strings.Contains(FixedConventions, "## Readings") ||
		strings.Contains(EditableConventions, "### Function problems") {
		t.Error("each view carries only the headings of its own parts")
	}
	if ConventionsText("") != AuthoringConventions || ConventionsText(" \n\t") != AuthoringConventions {
		t.Error("a blank custom text means the built-in conventions")
	}
}

// A custom system prompt replaces the editable conventions in every prompt
// that carries them, while the fixed rules, the style and the request's own
// rules stay.
func TestCustomConventionsReplaceTheEditableOnes(t *testing.T) {
	const custom = "# House rules\n\nWrite statements like a textbook."
	style := &Style{Name: "Terse", Instructions: "Short statements."}
	draft, _ := DraftPrompt{Conventions: custom, Style: style, Text: "x"}.Build()
	variant, _ := VariantPrompt{Conventions: custom, Style: style, Original: "{}", Mode: "similar"}.Build()
	code, _ := CodePrompt{Conventions: custom, Style: style, Problem: "{}", Languages: []string{"python"}}.Build()
	guide := AuthoringGuide(custom, style)
	env := NewEnvelope(GuideTexts(custom, style)...)
	guideIn := AuthoringGuideIn(env, custom, style)
	for name, p := range map[string]string{"draft": draft, "variant": variant, "code": code, "guide": guide, "guide in": guideIn} {
		if !strings.Contains(p, custom+"\n\n"+FixedConventions+"\n## Style preferences") {
			t.Errorf("%s: the custom text, then the fixed rules, then the style:\n%s", name, p)
		}
		for _, gone := range []string{"# Codeatrophy authoring conventions", "A good test set covers", "Never use an em dash"} {
			if strings.Contains(p, gone) {
				t.Errorf("%s still carries the built-in %q", name, gone)
			}
		}
		if !strings.Contains(p, "<"+BlockStylePreset+"-") {
			t.Errorf("%s lost the style block", name)
		}
		if !strings.Contains(p, "collapsible block: `<details>`") {
			t.Errorf("%s lost the one HTML block that renders", name)
		}
		if !strings.Contains(p, "fenced block with `tab` after the language") {
			t.Errorf("%s lost the language tabs", name)
		}
	}
	if !strings.Contains(draft, DraftRules()) || !strings.HasSuffix(draft, jsonOnly) {
		t.Error("draft lost its rules")
	}
	if !strings.Contains(variant, VariantRules()) || !strings.HasSuffix(variant, jsonOnly) {
		t.Error("variant lost its rules")
	}
	if !strings.Contains(code, "## Code rules") || !strings.HasSuffix(code, jsonOnly) {
		t.Error("code generation lost its rules")
	}
	if !strings.Contains(guide, "## Working with the Codeatrophy tools") {
		t.Error("guide lost the tool guide")
	}
	// Without a style the guide needs no data blocks.
	if g := AuthoringGuide(custom, nil); !strings.HasPrefix(g, custom+"\n\n"+FixedConventions) {
		t.Errorf("guide without a style:\n%s", g)
	}

	// That the custom text cannot open or close a block is checked with the
	// other slots in TestPromptSlotsCannotBreakOut.
}
