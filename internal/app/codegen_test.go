package app_test

import (
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"testing"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

func codeEntry(lang, starter, prefix, suffix string) map[string]string {
	return map[string]string{"language": lang, "starterCode": starter, "prefix": prefix, "suffix": suffix}
}

func generateCode(t *testing.T, e *env, js string, out any) (app.CodeResponse, error) {
	t.Helper()
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return out, nil }
	return e.app.GenerateCode(e.ctx, decodeInto[app.CodeInput](t, js))
}

// The prompt is built from the problem as the request gives it, which need
// not be saved, and only the languages asked for come back.
func TestGenerateCodeFromTheForm(t *testing.T) {
	e := newEnv(t)
	samples := []string{`{"stdin":"3 11\n1 2 5\n","expectedStdout":"3\n"}`}
	for i := range 6 {
		samples = append(samples, fmt.Sprintf(`{"stdin":"sample %d\n","expectedStdout":"0\n"}`, i+2))
	}
	samples[2] = `{"stdin":"` + strings.Repeat("9 ", 4000) + `","expectedStdout":"1\n"}`
	js := `{"title":"Coin Change (edited)","body":"## Input\n\nThe first line holds n and amount.","interface":"program",
		"languages":["python","cpp","java","python"],"samples":[` + strings.Join(samples, ",") + `]}`
	_, err := e.app.GenerateCode(e.ctx, decodeInto[app.CodeInput](t, js))
	wantCode(t, err, app.CodeAIUnavailable)
	e.enableAI(t)

	res := must(generateCode(t, e, js, map[string]any{"code": []map[string]string{
		codeEntry("python", "import sys\n# region input\nn, amount = map(int, input().split())\n# endregion\n", "", ""),
		codeEntry("go", "package main\n", "", ""),                   // not asked for
		codeEntry("python", "a second python\n", "", ""),            // the first one counts
		codeEntry("cpp", "int main() {}\r\n", "ignored", "ignored"), // a program has no harness
		codeEntry("java", "  \n", "", ""),                           // no code
	}}))
	if got := slices.Sorted(maps.Keys(res.StarterCode)); strings.Join(got, ",") != "cpp,python" {
		t.Errorf("languages: %v", got)
	}
	if !strings.Contains(res.StarterCode["python"], "amount") || res.StarterCode["cpp"] != "int main() {}\n" ||
		len(res.Harness) != 0 || res.Check != nil || res.Style != nil {
		t.Errorf("response: %+v", res)
	}

	req := e.ai.Last()
	if req.SchemaName != "code" {
		t.Errorf("schema name %q", req.SchemaName)
	}
	b, _ := json.Marshal(req.Schema)
	if !strings.Contains(string(b), `"enum":["python","cpp","java"]`) || strings.Contains(string(b), `"prefix"`) {
		t.Errorf("schema: %s", b)
	}
	// The problem is data in the user turn: its title, statement and first
	// five samples, a large one by its size only.
	m := regexp.MustCompile(`(?s)<problem-([0-9a-f]{24})>\n(.*)\n</problem-([0-9a-f]{24})>`).FindStringSubmatch(req.User)
	if m == nil || m[1] != m[3] || strings.Contains(req.System, "Coin Change (edited)") {
		t.Fatalf("problem block:\n%s", req.User)
	}
	block := m[2]
	for _, want := range []string{`"title": "Coin Change (edited)"`, "The first line holds n and amount.", `"interface": "program"`,
		`3 11\n1 2 5\n`, "sample 5", "too large to show"} {
		if !strings.Contains(block, want) {
			t.Errorf("the problem block lacks %q:\n%s", want, block)
		}
	}
	if strings.Contains(block, "sample 6") || strings.Contains(block, "9 9 9") {
		t.Errorf("the problem block shows too much:\n%s", block)
	}
	if !strings.Contains(req.User, "in these languages: python, cpp, java.") || !strings.Contains(req.System, ai.AuthoringConventions[:40]) ||
		!strings.Contains(req.System, "## Code rules") || !strings.Contains(req.System, "region input") {
		t.Errorf("prompt:\n%s\n=== user ===\n%s", req.System, req.User)
	}

	// The request is logged as code generation, under the saved item it names.
	it := e.problem(t, "")
	res = must(generateCode(t, e, `{"itemId":"`+it.ID+`","body":"x","languages":["python"]}`,
		map[string]any{"code": []map[string]string{codeEntry("python", "print()\n", "", "")}}))
	d := must(e.app.GetAILogEntry(e.ctx, *res.Usage.LogID))
	if d.Operation != "code" || d.Status != "ok" || d.ItemID == nil || *d.ItemID != it.ID || d.Title == nil || *d.Title != it.Title {
		t.Errorf("log entry: %+v", d.AILogEntry)
	}
	if page := e.logPage(t, app.AILogQuery{Operation: "code"}); page.Total != 2 {
		t.Errorf("code entries: %d", page.Total)
	}
}

// For a function problem the harness comes back too, a Python prefix gets
// its future import, and each runner is run on the first sample.
func TestGenerateCodeForAFunctionProblemChecksItsRunners(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.enableAI(t)
	e.engine.Handler = harnessHandler
	out := map[string]any{"code": []map[string]string{
		codeEntry("python", "sum", "import json\n", "\nmain()\n"),
		codeEntry("cpp", "crash", "#include <bits/stdc++.h>", "int main() {}"),
	}}
	res := must(generateCode(t, e, `{"title":"Sum","body":"Return a + b.","interface":"function","languages":["cpp","python"],
		"samples":[{"stdin":"1\n2\n","expectedStdout":"3\n"}]}`, out))
	if res.Harness["python"].Prefix != "from __future__ import annotations\nimport json\n" || res.Harness["cpp"].Suffix != "int main() {}" ||
		res.StarterCode["python"] != "sum" {
		t.Errorf("code: %+v %+v", res.StarterCode, res.Harness)
	}
	c := res.Check
	if c == nil || !c.Attempted || c.Engine == nil || len(c.Runners) != 2 {
		t.Fatalf("check: %+v", c)
	}
	if r := c.Runners[0]; r.Language != "cpp" || r.Status != "failed" || r.Error == nil || !strings.Contains(*r.Error, "boom") {
		t.Errorf("cpp runner: %+v", r)
	}
	if r := c.Runners[1]; r.Language != "python" || r.Status != "ok" {
		t.Errorf("python runner: %+v", r)
	}
	if !strings.Contains(mustJSON(t, e.ai.Last().Schema), `"prefix"`) {
		t.Error("a function problem's schema asks for the harness")
	}
	if !strings.Contains(e.ai.Last().User, "the stub and the harness of this function problem") {
		t.Errorf("user prompt: %s", e.ai.Last().User)
	}

	// Without a sample, or without an engine, nothing is run.
	res = must(generateCode(t, e, `{"body":"x","interface":"function","languages":["python"]}`, out))
	if res.Check == nil || res.Check.Attempted || res.Check.Runners == nil || len(res.Check.Runners) != 0 {
		t.Errorf("no sample: %+v", res.Check)
	}
	e = newEnv(t, withoutEngine())
	e.enableAI(t)
	res = must(generateCode(t, e, `{"body":"x","interface":"function","languages":["python"],"samples":[{"stdin":"1","expectedStdout":"1"}]}`, out))
	if res.Check == nil || res.Check.Attempted || res.Check.Engine != nil {
		t.Errorf("no engine: %+v", res.Check)
	}
}

func TestGenerateCodeValidationAndUpstreamErrors(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	ok := map[string]any{"code": []map[string]string{codeEntry("python", "x", "", "")}}
	for js, field := range map[string]string{
		`{"body":"x"}`:                                          "languages",
		`{"body":"x","languages":[]}`:                           "languages",
		`{"body":"x","languages":["cobol"]}`:                    "languages",
		`{"body":"x","languages":["python"],"interface":"api"}`: "interface",
		`{"title":" ","body":"\n","languages":["python"]}`:      "body",
		`{"title":"` + strings.Repeat("t", domain.MaxTitleChars+1) + `","languages":["python"]}`:                             "title",
		`{"body":"x","languages":["python"],"itemId":"00000000-0000-4000-8000-000000000000"}`:                                "itemId",
		`{"body":"x","languages":["python"],"styleId":"00000000-0000-4000-8000-000000000000"}`:                               "styleId",
		`{"body":"x","languages":["python"],"samples":[{"stdin":"` + strings.Repeat("1", domain.MaxTestCaseBytes+1) + `"}]}`: "samples.0",
	} {
		_, err := generateCode(t, e, js, ok)
		wantField(t, err, field)
	}
	before := len(e.ai.Requests())
	for name, out := range map[string]any{
		"not the schema":   map[string]any{"code": "python"},
		"only other ones":  map[string]any{"code": []map[string]string{codeEntry("go", "package main", "", "")}},
		"no code at all":   map[string]any{"code": []map[string]string{}},
		"over the limit":   map[string]any{"code": []map[string]string{codeEntry("python", strings.Repeat("x", 64<<10+1), "", "")}},
		"runner too large": map[string]any{"code": []map[string]string{codeEntry("python", "x", strings.Repeat("x", 64<<10+1), "")}},
	} {
		_, err := generateCode(t, e, `{"body":"x","interface":"function","languages":["python"]}`, out)
		if code(err) != app.CodeUpstream {
			t.Errorf("%s: %v", name, err)
		}
	}
	if n := len(e.ai.Requests()) - before; n != 5 {
		t.Errorf("%d requests sent, want 5", n)
	}
	if page := e.logPage(t, app.AILogQuery{Operation: "code", Status: "failed"}); page.Total != 5 {
		t.Errorf("failed code entries: %d", page.Total)
	}
}

// The style preset applies as for a draft, and a custom system prompt
// replaces the editable conventions.
func TestGenerateCodeUsesTheStyleAndConventions(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	st := must(e.app.CreateStylePreset(e.ctx, decodeInto[domain.StylePresetInput](t, `{"name":"Snake","instructions":"Use snake_case names.","isDefault":true}`)))
	must(e.app.SetSystemPrompt(e.ctx, app.SystemPromptInput{Custom: domain.Some("# House rules\n\nKeep it short.")}))
	ok := map[string]any{"code": []map[string]string{codeEntry("python", "x", "", "")}}
	res := must(generateCode(t, e, `{"body":"x","languages":["python"]}`, ok))
	sys := e.ai.Last().System
	if res.Style == nil || res.Style.ID != st.ID || !strings.Contains(sys, "Use snake_case names.") ||
		!strings.Contains(sys, "# House rules") || !strings.Contains(sys, ai.FixedConventions) || strings.Contains(sys, "Never use an em dash") {
		t.Errorf("style %+v, system:\n%s", res.Style, sys)
	}
	res = must(generateCode(t, e, `{"body":"x","languages":["python"],"styleId":null}`, ok))
	if res.Style != nil || strings.Contains(e.ai.Last().System, "snake_case") {
		t.Errorf("no style: %+v", res.Style)
	}
}
