package app_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/judge/judgetest"
)

// toolchainEngine adds what a real engine says about its toolchains: the
// names of the program's file and a source-size limit.
type toolchainEngine struct {
	*judgetest.Engine
	limit int
}

func (e *toolchainEngine) SourceNames(lang string) []string {
	return map[string][]string{"python": {"script.py"}, "cpp": {"main.cpp"}}[lang]
}

func (e *toolchainEngine) MaxSourceBytes(_ context.Context, lang string) (int, error) {
	if lang == "cpp" {
		return e.limit, nil
	}
	return 0, nil
}

func withToolchains(limit int) option {
	return func(o *app.Options) { o.Engine = &toolchainEngine{Engine: o.Engine.(*judgetest.Engine), limit: limit} }
}

// harnessHandler runs a program built from lines: the first line that is a
// judgetest.Script command decides the output, a line containing
// COMPILE_ERROR fails to compile there and one containing RAISE fails at
// run time there, both reporting the line of the assembled program.
func harnessHandler(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
	lines := strings.Split(req.Source, "\n")
	for i, l := range lines {
		switch {
		case strings.Contains(l, "COMPILE_ERROR"):
			return judge.ExecResult{Status: judge.StatusCompileError,
				CompileOutput: fmt.Sprintf("main.cpp:%d:5: error: expected ';'\n", i+1)}, nil
		case strings.Contains(l, "RAISE"):
			one := 1
			return judge.ExecResult{Status: judge.StatusRuntimeError, ExitCode: &one, Stderr: fmt.Sprintf(
				"Traceback (most recent call last):\n  File \"script.py\", line %d, in <module>\n  File \"script.py\", line %d, in f\nValueError\n",
				len(lines)-1, i+1)}, nil
		}
	}
	for _, l := range lines {
		switch strings.TrimSpace(l) {
		case "sum", "double", "echo", "crash", "timeout":
			r := req
			r.Source = strings.TrimSpace(l)
			return judgetest.Script(r), nil
		}
	}
	return judgetest.Script(judge.ExecRequest{Source: "print no solution"}), nil
}

const fnHarness = `{"python":{"prefix":"from __future__ import annotations\nimport json\n","suffix":"\nmain()\n"},
	"cpp":{"prefix":"#include <bits/stdc++.h>","suffix":"int main() {}"}}`

func (e *env) functionProblem(t *testing.T) domain.Item {
	t.Helper()
	return must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"Sum","problem":{"interface":"function",
		"starterCode":{"python":"class Solution:\n    def f(self):\n        "},"harness":`+fnHarness+`},
		"testCases":[{"name":"s1","stdin":"1 2","expectedStdout":"3","isSample":true},{"name":"h1","stdin":"5 5","expectedStdout":"10"}]}`)))
}

func TestFunctionProblemItemRules(t *testing.T) {
	e := newEnv(t)
	it := e.functionProblem(t)
	p := it.Problem
	if p.Interface != domain.InterfaceFunction || len(p.Harness) != 2 || p.Harness["python"].Suffix != "\nmain()\n" {
		t.Fatalf("created: %+v", p)
	}
	plain := e.problem(t, "")
	if plain.Problem.Interface != domain.InterfaceProgram || plain.Problem.Harness == nil || len(plain.Problem.Harness) != 0 {
		t.Errorf("default interface: %+v", plain.Problem)
	}
	b, _ := json.Marshal(plain)
	if !strings.Contains(string(b), `"interface":"program"`) || !strings.Contains(string(b), `"harness":{}`) {
		t.Errorf("JSON shape: %s", b)
	}

	for name, js := range map[string]string{
		"program with a harness":   `{"type":"problem","title":"x","problem":{"harness":{"python":{"prefix":"","suffix":""}}}}`,
		"unknown interface":        `{"type":"problem","title":"x","problem":{"interface":"procedure"}}`,
		"null interface":           `{"type":"problem","title":"x","problem":{"interface":null}}`,
		"unknown harness language": `{"type":"problem","title":"x","problem":{"interface":"function","harness":{"cobol":{"prefix":"","suffix":""}}}}`,
		"prefix too long": `{"type":"problem","title":"x","problem":{"interface":"function","harness":{"python":{"prefix":"` +
			strings.Repeat("x", 64<<10+1) + `","suffix":""}}}}`,
	} {
		if _, err := e.app.CreateItem(e.ctx, input(t, js)); code(err) != app.CodeValidation {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A function problem may be saved without any harness entry.
	must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"later","problem":{"interface":"function"}}`)))

	// Back to a program only together with an empty harness, so runner
	// code is never dropped by accident; the change is content.
	_, err := e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"interface":"program"}}`))
	wantField(t, err, "problem.harness")
	got := must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"interface":"program","harness":{}}}`)))
	if got.Problem.Interface != domain.InterfaceProgram || len(got.Problem.Harness) != 0 || got.Revision != it.Revision+1 {
		t.Errorf("program again: %+v revision %d", got.Problem, got.Revision)
	}
	// Changing only the harness is a content change too; CRLF is normalised.
	it = e.functionProblem(t)
	got = must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"harness":{"python":{"prefix":"a\r\nb","suffix":""}}}}`)))
	if got.Revision != it.Revision+1 || got.Problem.Harness["python"].Prefix != "a\nb" || len(got.Problem.Harness) != 1 {
		t.Errorf("harness change: %+v", got)
	}
}

func TestFunctionProblemSubmissions(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.engine.Handler = harnessHandler
	it := e.functionProblem(t)

	// The solution is run inside the harness; what is stored is what was
	// submitted, with how many lines the harness put before it.
	sub := e.submit(t, it.ID, `{"language":"python","source":"class Solution:\n    sum","mode":"submit"}`)
	if *sub.Verdict != domain.VerdictAccepted || sub.Source != "class Solution:\n    sum" || sub.LineOffset != 2 {
		t.Errorf("submission: verdict %v offset %d source %q", *sub.Verdict, sub.LineOffset, sub.Source)
	}
	want := "from __future__ import annotations\nimport json\nclass Solution:\n    sum\n\nmain()\n"
	if got := e.engine.Requests()[len(e.engine.Requests())-1].Source; got != want {
		t.Errorf("program that ran:\n%q\nwant\n%q", got, want)
	}
	if list := must(e.app.ListSubmissions(e.ctx, it.ID, app.SubmissionQuery{})); list.Items[0].LineOffset != 2 {
		t.Errorf("summary: %+v", list.Items[0])
	}

	// Line numbers in the toolchain's output are the solver's own; lines
	// inside the runner say so.
	sub = e.submit(t, it.ID, `{"language":"python","source":"x = 1\ny = 2\nRAISE\n","mode":"run"}`)
	if r := sub.Results[0]; r.Verdict != domain.VerdictRuntimeError ||
		!strings.Contains(r.Stderr, `File "<runner suffix>", line 2, in <module>`) || !strings.Contains(r.Stderr, `File "script.py", line 3, in f`) {
		t.Errorf("runtime error: %q", r.Stderr)
	}
	sub = e.submit(t, it.ID, `{"language":"cpp","source":"int f() {\n  COMPILE_ERROR\n}","mode":"run"}`)
	if *sub.Verdict != domain.VerdictCompileError || sub.LineOffset != 1 || sub.CompileOutput != "main.cpp:2:5: error: expected ';'\n" {
		t.Errorf("compile error: %v %q", *sub.Verdict, sub.CompileOutput)
	}

	// A language without a harness cannot be run.
	e.engine.Langs = append(e.engine.Langs, judge.Language{ID: "java", Name: "Java"})
	_, err := e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, `{"language":"java","source":"x","mode":"run"}`))
	wantField(t, err, "language")
	if !strings.Contains(app.AsError(err).Message, "it can be run in cpp, python") {
		t.Errorf("message: %s", app.AsError(err).Message)
	}

	// A program problem has no offset and runs the source as it is.
	plain := e.problem(t, "")
	sub = e.submit(t, plain.ID, `{"language":"python","source":"sum","mode":"run"}`)
	if sub.LineOffset != 0 || *sub.Verdict != domain.VerdictAccepted {
		t.Errorf("program problem: %+v", sub)
	}

	// The harness a submission runs in is the one it was created with.
	e.engine.Handler = harnessHandler
	queued := must(e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, `{"language":"python","source":"sum","mode":"run"}`)))
	if queued.Harness == nil || queued.Harness.Suffix != "\nmain()\n" {
		t.Errorf("snapshot: %+v", queued.Harness)
	}
}

func TestProgramSizeLimit(t *testing.T) {
	e := newEnv(t, withToolchains(100))
	e.engine.Handler = harnessHandler
	it := e.functionProblem(t)
	// The source alone fits, the program with its runner does not.
	src := strings.Repeat("x", 80)
	_, err := e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, `{"language":"cpp","source":"`+src+`","mode":"run"}`))
	wantField(t, err, "source")
	if msg := app.AsError(err).Message; !strings.Contains(msg, "the runner code with the solution") || !strings.Contains(msg, "at most 100 bytes") {
		t.Errorf("message: %s", msg)
	}
	e.submit(t, it.ID, `{"language":"cpp","source":"sum","mode":"run"}`)
}

func TestFunctionProblemVerification(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.engine.Handler = harnessHandler
	it := e.functionProblem(t)
	_, err := e.app.VerifyTestCases(e.ctx, it.ID, false, "")
	wantField(t, err, "referenceSolution")

	ref := must(e.app.CreateSolution(e.ctx, it.ID, decodeInto[domain.ItemSolutionInput](t,
		`{"name":"ref","language":"python","source":"sum","isReference":true}`)))
	res := must(e.app.VerifyTestCases(e.ctx, it.ID, false, ""))
	if len(res.Results) != 2 || !res.Results[0].Matches || !res.Results[1].Matches {
		t.Errorf("verify: %+v", res.Results)
	}
	for _, tc := range must(e.app.ListTestCases(e.ctx, it.ID)).Items {
		if !tc.Verified {
			t.Errorf("case %s not verified", tc.Name)
		}
	}
	if !strings.HasPrefix(e.engine.Requests()[len(e.engine.Requests())-1].Source, "from __future__ import annotations\n") {
		t.Error("verification did not run inside the harness")
	}
	// A solution in a language without a harness is saved but cannot run.
	e.engine.Langs = append(e.engine.Langs, judge.Language{ID: "java", Name: "Java"})
	other := must(e.app.CreateSolution(e.ctx, it.ID, decodeInto[domain.ItemSolutionInput](t,
		`{"name":"java","language":"java","source":"class Solution {}"}`)))
	_, err = e.app.VerifyTestCases(e.ctx, it.ID, false, other.ID)
	wantField(t, err, "solutionId")
	// Stderr of a failing check is mapped too.
	broken := must(e.app.CreateSolution(e.ctx, it.ID, decodeInto[domain.ItemSolutionInput](t,
		`{"name":"broken","language":"python","source":"RAISE"}`)))
	res = must(e.app.VerifyTestCases(e.ctx, it.ID, false, broken.ID))
	if !strings.Contains(res.Results[0].Stderr, `File "script.py", line 1, in f`) {
		t.Errorf("stderr: %q", res.Results[0].Stderr)
	}
	_ = ref
}

func fnDraftJSON() map[string]any {
	d := draftJSON()
	d["problem"] = map[string]any{"interface": "function", "timeLimitMs": 1000, "memoryLimitKb": 65536, "compare": "tokens",
		"starterCode": []map[string]string{{"language": "python", "source": "class Solution:\n    def f(self):\n        "}},
		"harness": []map[string]string{
			{"language": "python", "prefix": "import json\n", "suffix": "\nmain()\n"},
			{"language": "cobol", "prefix": "", "suffix": ""},
		},
		"referenceSolution": map[string]string{"language": "python", "source": "sum"}}
	d["testCases"] = []map[string]any{
		{"name": "Example 1", "stdin": "1 2", "expectedStdout": "3", "isSample": true},
		{"name": "Example 2", "stdin": "2 2", "expectedStdout": "5", "isSample": true},
	}
	return d
}

func TestDraftCheck(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.enableAI(t)
	e.engine.Handler = harnessHandler
	res := must(newDraft(t, e, `{"text":"sum it","interfaceHint":"auto"}`, fnDraftJSON()))
	p := res.Draft.Problem
	// A Python prefix gets the future import a model forgot; unknown
	// languages are dropped.
	if p.Interface != domain.InterfaceFunction || len(p.Harness) != 1 ||
		p.Harness["python"].Prefix != "from __future__ import annotations\nimport json\n" ||
		p.ReferenceSolution == nil || p.ReferenceSolution.Source != "sum" {
		t.Fatalf("draft problem: %+v", p)
	}
	c := res.Check
	if c == nil || !c.Attempted || *c.Engine != "fake" || c.Passed != 1 || c.Total != 2 || c.Error == nil ||
		!strings.Contains(*c.Error, `"Example 2": the reference solution printed "4", but the expected output is "5"`) {
		t.Fatalf("check: %+v %v", c, c.Error)
	}
	if !res.Draft.TestCases[0].Verified || res.Draft.TestCases[1].Verified {
		t.Errorf("verified flags: %+v", res.Draft.TestCases)
	}
	if res.Draft.TestCases[1].ExpectedStdout != "5" {
		t.Error("the check must not correct the draft")
	}
	if u := e.ai.Last().User; !strings.Contains(u, "<judge_languages-") || !strings.Contains(u, "python: python fake") {
		t.Errorf("the judge's languages are not in the prompt: %s", u)
	}
	if !strings.Contains(e.ai.Last().System, "from __future__ import annotations") {
		t.Error("the conventions do not mention the future import")
	}

	// A runner that does not compile.
	broken := fnDraftJSON()
	broken["problem"].(map[string]any)["harness"] = []map[string]string{{"language": "cpp", "prefix": "COMPILE_ERROR", "suffix": ""}}
	broken["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "cpp", "source": "sum"}
	c = must(newDraft(t, e, `{"text":"x"}`, broken)).Check
	if !c.Attempted || c.Passed != 0 || c.Error == nil || !strings.Contains(*c.Error, "does not compile") ||
		!strings.Contains(*c.Error, "<runner prefix>:1:5") {
		t.Errorf("compile error: %+v %v", c, *c.Error)
	}
	// A reference solution in a language without a harness.
	noRunner := fnDraftJSON()
	noRunner["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "cpp", "source": "sum"}
	c = must(newDraft(t, e, `{"text":"x"}`, noRunner)).Check
	if !c.Attempted || c.Error == nil || !strings.Contains(*c.Error, "no runner code") {
		t.Errorf("no runner: %+v", c)
	}
	// No reference solution, or no test cases: nothing is attempted.
	none := fnDraftJSON()
	none["problem"].(map[string]any)["referenceSolution"] = nil
	c = must(newDraft(t, e, `{"text":"x"}`, none)).Check
	if c.Attempted || c.Engine != nil || c.Total != 2 || c.Error != nil {
		t.Errorf("no reference: %+v", c)
	}
	// The interface hint is the interface, whatever the model chose.
	res = must(newDraft(t, e, `{"text":"x","interfaceHint":"program"}`, fnDraftJSON()))
	if res.Draft.Problem.Interface != domain.InterfaceProgram || len(res.Draft.Problem.Harness) != 0 {
		t.Errorf("program hint: %+v", res.Draft.Problem)
	}
	if !strings.Contains(e.ai.Last().User, "give it the program interface") {
		t.Error("the hint is not in the prompt")
	}
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x","interfaceHint":"procedure"}`))
	wantField(t, err, "interfaceHint")
	// An unreachable engine is reported, not an error.
	e.engine.SetHealth(errors.New("down"))
	res = must(newDraft(t, e, `{"text":"x"}`, fnDraftJSON()))
	if c := res.Check; !c.Attempted || c.Passed != 0 || c.Error == nil || !strings.Contains(*c.Error, "the judge engine failed: down") {
		t.Errorf("engine down: %+v", c)
	}
	e.engine.SetHealth(nil)
	// A reading has no check.
	reading := draftJSON()
	reading["type"] = "reading"
	if res := must(newDraft(t, e, `{"text":"x"}`, reading)); res.Check != nil {
		t.Errorf("reading: %+v", res.Check)
	}

	// Without an engine nothing is attempted.
	ne := newEnv(t, withoutEngine())
	ne.enableAI(t)
	res = must(newDraft(t, ne, `{"text":"x"}`, fnDraftJSON()))
	if c := res.Check; c == nil || c.Attempted || c.Engine != nil || c.Total != 2 || res.Draft.TestCases[0].Verified {
		t.Errorf("no engine: %+v", c)
	}
	if !strings.Contains(ne.ai.Last().User, "no judge engine is configured") {
		t.Error("the prompt does not say there is no judge")
	}
}

func TestVariantInterface(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.enableAI(t)
	e.engine.Handler = harnessHandler
	it := e.functionProblem(t)
	out := fnDraftJSON()
	out["problem"].(map[string]any)["interface"] = "program"
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return out, nil }
	res := must(e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{}`)))
	if res.Draft.Problem.Interface != domain.InterfaceFunction || res.Check == nil || !res.Check.Attempted {
		t.Errorf("a variant keeps the original's interface: %+v %+v", res.Draft.Problem, res.Check)
	}
	if u := e.ai.Last().User; !strings.Contains(u, `"harness"`) || !strings.Contains(u, "function interface") {
		t.Errorf("the original's runners are not shown: %s", u)
	}
	res = must(e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{"interfaceHint":"program"}`)))
	if res.Draft.Problem.Interface != domain.InterfaceProgram {
		t.Errorf("hint: %+v", res.Draft.Problem)
	}
	_, err := e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{"interfaceHint":"x"}`))
	wantField(t, err, "interfaceHint")
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	_, err = e.app.Variant(e.ctx, reading.ID, decodeInto[app.VariantInput](t, `{"interfaceHint":"function"}`))
	wantField(t, err, "interfaceHint")
}

func TestGenerateTestCasesForFunctionProblem(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.enableAI(t)
	e.engine.Handler = harnessHandler
	it := e.functionProblem(t)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{
			"referenceSolution": map[string]any{"language": "python", "source": "sum"},
			"cases":             []map[string]any{{"name": "small", "rationale": "min", "stdin": "1 1", "predictedStdout": "2", "isSample": false}},
		}, nil
	}
	res := must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1}`)))
	if !res.Cases[0].Verified || res.Cases[0].ExpectedStdout != "2\n" {
		t.Errorf("generated: %+v", res.Cases[0])
	}
	if !strings.HasPrefix(e.engine.Requests()[len(e.engine.Requests())-1].Source, "from __future__") {
		t.Error("the generated solution did not run inside the harness")
	}
	req := e.ai.Last()
	if !strings.Contains(req.User, `"stub"`) || !strings.Contains(req.User, `"interface": "function"`) ||
		!strings.Contains(req.User, "the solution part of a reference solution") {
		t.Errorf("prompt: %s", req.User)
	}
	b, _ := json.Marshal(req.Schema)
	if !strings.Contains(string(b), "Only the solution part") {
		t.Errorf("schema: %s", b)
	}
	e.engine.Langs = append(e.engine.Langs, judge.Language{ID: "java", Name: "Java"})
	n := len(e.ai.Requests())
	_, err := e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"language":"java"}`))
	wantField(t, err, "language")
	if len(e.ai.Requests()) != n {
		t.Error("the provider was called for a language without a harness")
	}
}

func TestGeneratedTestCasesPreference(t *testing.T) {
	e := newEnv(t)
	if p := must(e.app.GetPreferences(e.ctx)); p["generatedTestCases"] != 8 {
		t.Errorf("default: %v", p["generatedTestCases"])
	}
	p := must(e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"generatedTestCases":12}`)))
	if p["generatedTestCases"] != 12 {
		t.Errorf("saved: %v", p["generatedTestCases"])
	}
	for _, js := range []string{`{"generatedTestCases":0}`, `{"generatedTestCases":31}`, `{"generatedTestCases":"8"}`} {
		_, err := e.app.UpdatePreferences(e.ctx, json.RawMessage(js))
		wantField(t, err, "generatedTestCases")
	}
}

func TestSolutionOnlyProblemsTravelInBundles(t *testing.T) {
	src := newEnv(t)
	it := src.functionProblem(t)
	must(src.app.CreateSolution(src.ctx, it.ID, decodeInto[domain.ItemSolutionInput](t,
		`{"name":"ref","language":"python","source":"sum","isReference":true}`)))
	data := src.export(t, `{"scope":"items","itemIds":["`+it.ID+`"]}`)
	if !strings.Contains(zipText(t, data), `"formatVersion": 2`) {
		t.Error("a bundle with a solution-only problem is not version 2")
	}
	plain := src.problem(t, "")
	if !strings.Contains(zipText(t, src.export(t, `{"scope":"items","itemIds":["`+plain.ID+`"]}`)), `"formatVersion": 1`) {
		t.Error("a bundle without one is not version 1")
	}

	dst := newEnv(t, withToolchains(0))
	dst.engine.Handler = harnessHandler
	pre := must(dst.app.PreviewImport(dst.ctx, data))
	if pre.Bundle.FormatVersion != 2 || pre.Counts.New != 1 || len(pre.Warnings) != 0 {
		t.Fatalf("preview: %+v", pre)
	}
	must(dst.app.Import(dst.ctx, data, ""))
	got := must(dst.app.GetItem(dst.ctx, it.ID))
	if got.Problem.Interface != domain.InterfaceFunction || len(got.Problem.Harness) != 2 ||
		got.Problem.Harness["python"] != it.Problem.Harness["python"] || got.Problem.StarterCode["python"] != it.Problem.StarterCode["python"] {
		t.Fatalf("imported: %+v", got.Problem)
	}
	// It runs again: the reference solution passes inside the harness.
	res := must(dst.app.VerifyTestCases(dst.ctx, it.ID, false, ""))
	if len(res.Results) != 2 || !res.Results[0].Matches || !res.Results[1].Matches {
		t.Errorf("verify after import: %+v", res.Results)
	}
	if pre := must(dst.app.PreviewImport(dst.ctx, data)); pre.Counts.Unchanged != 1 {
		t.Errorf("re-import: %+v", pre.Counts)
	}

	// A local change to the runner is a change the preview names, and an
	// overwrite restores it as content (the revision moves).
	before := must(dst.app.UpdateItem(dst.ctx, it.ID, input(t, `{"problem":{"harness":{"python":{"prefix":"local","suffix":""}}}}`)))
	pre = must(dst.app.PreviewImport(dst.ctx, data))
	if pre.Counts.Changed != 1 || fmt.Sprint(pre.Items[0].Changes) != "[harness]" {
		t.Errorf("changed harness: %+v", pre.Items)
	}
	must(dst.app.Import(dst.ctx, data, "overwrite"))
	after := must(dst.app.GetItem(dst.ctx, it.ID))
	if len(after.Problem.Harness) != 2 || after.Revision != before.Revision+1 {
		t.Errorf("overwrite: %+v revision %d", after.Problem.Harness, after.Revision)
	}
	// Turned into a program locally: interface and harness both differ.
	must(dst.app.UpdateItem(dst.ctx, it.ID, input(t, `{"problem":{"interface":"program","harness":{}}}`)))
	if pre := must(dst.app.PreviewImport(dst.ctx, data)); fmt.Sprint(pre.Items[0].Changes) != "[interface harness]" {
		t.Errorf("changed interface: %+v", pre.Items[0].Changes)
	}
}

func TestDraftCheckRunsEveryRunner(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.enableAI(t)
	e.engine.Handler = harnessHandler
	e.engine.Langs = append(e.engine.Langs, judge.Language{ID: "javascript", Name: "JavaScript"})
	d := fnDraftJSON()
	p := d["problem"].(map[string]any)
	p["starterCode"] = []map[string]string{
		{"language": "python", "source": "sum"},
		{"language": "cpp", "source": "crash"},
		{"language": "javascript", "source": "x"},
		{"language": "java", "source": "class Solution {}"},
	}
	p["harness"] = []map[string]string{
		{"language": "python", "prefix": "", "suffix": ""},
		{"language": "cpp", "prefix": "", "suffix": ""},
		{"language": "javascript", "prefix": "COMPILE_ERROR", "suffix": ""},
		{"language": "java", "prefix": "", "suffix": ""},
		{"language": "ruby", "prefix": "", "suffix": ""},
	}
	c := must(newDraft(t, e, `{"text":"x"}`, d)).Check
	got := []string{}
	for _, r := range c.Runners {
		s := r.Language + ":" + r.Status
		if r.Error != nil {
			s += "(" + *r.Error + ")"
		}
		got = append(got, s)
	}
	want := []string{
		"cpp:failed(runtime error: boom)",
		`java:skipped(language "java" is not offered by the judge engine)`,
		"javascript:failed(does not compile: main.cpp:1:5: error: expected ';')", // the fake names no JavaScript file
		"python:ok",
		"ruby:skipped(there is no starter code for ruby)",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("runners:\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if c.Passed != 1 || !c.Attempted {
		t.Errorf("reference part: %+v", c)
	}
	// A program problem, and a check that was not attempted, have none.
	prog := draftJSON()
	prog["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "sum"}
	if c := must(newDraft(t, e, `{"text":"x"}`, prog)).Check; c.Runners == nil || len(c.Runners) != 0 {
		t.Errorf("program problem runners: %+v", c.Runners)
	}
	d["problem"].(map[string]any)["referenceSolution"] = nil
	if c := must(newDraft(t, e, `{"text":"x"}`, d)).Check; c.Attempted || len(c.Runners) != 0 {
		t.Errorf("not attempted: %+v", c)
	}
}

func TestInterfaceHintRulesForReadings(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x","typeHint":"reading","interfaceHint":"function"}`))
	wantField(t, err, "interfaceHint")
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	_, err = e.app.Variant(e.ctx, reading.ID, decodeInto[app.VariantInput](t, `{"interfaceHint":"auto"}`))
	wantField(t, err, "interfaceHint")
}
