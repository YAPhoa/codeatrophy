package app_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/judge/judgetest"
)

// generatorHandler adds generators to harnessHandler. A program whose
// first line is
//
//	gen <n>      prints n bytes of "7 7 7 ..."
//	gen-big      prints one byte more than a large input may have
//	gen-empty    prints nothing
//	gen-text <s> prints s
//	gen-badutf8  prints invalid UTF-8
//	sum-small    sums its input, but runs out of time on more than 1000 bytes
func generatorHandler(ctx context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
	first, _, _ := strings.Cut(req.Source, "\n")
	zero, ms := 0, 3
	if first == "sum-small" {
		r := req
		r.Source = "sum"
		if len(req.Stdin) > 1000 {
			r.Source = "timeout"
		}
		return judgetest.Script(r), nil
	}
	ok := func(out string) (judge.ExecResult, error) {
		return judge.ExecResult{Status: judge.StatusOK, Stdout: out, ExitCode: &zero, TimeMs: &ms}, nil
	}
	switch {
	case strings.HasPrefix(first, "gen "):
		n, _ := strconv.Atoi(strings.TrimPrefix(first, "gen "))
		return ok(strings.Repeat("7 ", n/2))
	case first == "gen-big":
		return ok(strings.Repeat("7", app.MaxLargeInputBytes+1))
	case first == "gen-empty":
		return ok(" \n")
	case strings.HasPrefix(first, "gen-text "):
		return ok(strings.TrimPrefix(first, "gen-text ") + "\n")
	case first == "gen-badutf8":
		return ok("1 \xff\n")
	}
	return harnessHandler(ctx, req)
}

func largeDraft(gen any) map[string]any {
	d := draftJSON()
	d["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "sum"}
	d["largeCase"] = gen
	return d
}

func gen(source string) map[string]any {
	return map[string]any{"name": "Many sevens", "rationale": "Big n.", "language": "python", "source": source}
}

func TestDraftWithALargeTestCase(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler

	res := must(newDraft(t, e, `{"text":"x","largeTestCase":true}`, largeDraft(gen("gen 200000"))))
	c, d := res.Check, res.Draft
	lc := c.LargeCase
	if lc == nil || lc.Status != "added" || lc.Error != nil || *lc.Index != 1 || *lc.Name != "Many sevens" ||
		*lc.InputBytes != 200000 || lc.TimeMs == nil || lc.Generator.Source != "gen 200000" || lc.Generator.Language != "python" {
		t.Fatalf("large case: %+v", lc)
	}
	last := d.TestCases[len(d.TestCases)-1]
	if len(d.TestCases) != 2 || last.IsSample || !last.Verified || len(last.Stdin) != 200000 || last.ExpectedStdout != "700000\n" ||
		last.Name != "Many sevens" {
		t.Errorf("draft cases: %d, last %q (%d bytes)", len(d.TestCases), last.Name, len(last.Stdin))
	}
	if c.Passed != 2 || c.Total != 2 || c.Error != nil {
		t.Errorf("check: %+v", c)
	}
	req := e.ai.Last()
	b, _ := json.Marshal(req.Schema)
	if !strings.Contains(req.System, `Also write "largeCase"`) || !strings.Contains(req.System, "at most 1048576 bytes") ||
		!strings.Contains(string(b), `"largeCase"`) {
		t.Error("the large case is not asked for")
	}

	// Without the flag: not asked for, not reported.
	res = must(newDraft(t, e, `{"text":"x"}`, largeDraft(gen("gen 2000"))))
	b, _ = json.Marshal(e.ai.Last().Schema)
	if res.Check.LargeCase != nil || len(res.Draft.TestCases) != 1 || strings.Contains(string(b), "largeCase") ||
		strings.Contains(e.ai.Last().System, `"largeCase"`) {
		t.Errorf("unasked: %+v", res.Check.LargeCase)
	}

	// Every way it can fail, without failing the draft or the other cases.
	slow := largeDraft(gen("gen 2000"))
	slow["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "sum-small"}
	for name, tc := range map[string]struct {
		draft map[string]any
		want  string
	}{
		"no generator":       {largeDraft(nil), "the model wrote no generator"},
		"unknown language":   {largeDraft(map[string]any{"name": "x", "rationale": "", "language": "cobol", "source": "gen 9"}), "unknown language"},
		"not offered":        {largeDraft(map[string]any{"name": "x", "rationale": "", "language": "java", "source": "gen 9"}), "does not run"},
		"does not compile":   {largeDraft(gen("COMPILE_ERROR")), "does not compile"},
		"crashes":            {largeDraft(gen("crash")), "the generator failed: runtime error: boom"},
		"times out":          {largeDraft(gen("timeout")), "time limit exceeded"},
		"too large":          {largeDraft(gen("gen-big")), "printed more than 1048576 bytes"},
		"prints nothing":     {largeDraft(gen("gen-empty")), "printed nothing"},
		"not UTF-8":          {largeDraft(gen("gen-badutf8")), "not UTF-8"},
		"repeats an example": {largeDraft(gen("gen-text 1 2")), `repeats "Example 1"`},
		"too slow":           {slow, "exceeded the time limit of 100 ms on the large input"},
	} {
		res := must(newDraft(t, e, `{"text":"x","largeTestCase":true}`, tc.draft))
		lc := res.Check.LargeCase
		if lc == nil || lc.Status != "failed" || lc.Error == nil || !strings.Contains(*lc.Error, tc.want) || lc.Index != nil {
			t.Errorf("%s: %+v %v", name, lc, lc.Error)
			continue
		}
		if len(res.Draft.TestCases) != 1 || res.Check.Total != 1 {
			t.Errorf("%s: a case was added", name)
		}
	}
	// Not built from a reference solution that failed another case: its
	// output would be marked verified and probably be wrong.
	wrong := largeDraft(gen("gen 2000"))
	wrong["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "double"}
	res = must(newDraft(t, e, `{"text":"x","largeTestCase":true}`, wrong))
	if lc := res.Check.LargeCase; lc.Status != "skipped" || *lc.Error != "the reference solution did not pass the other test cases" ||
		res.Check.Error == nil || !strings.Contains(*res.Check.Error, `"Example 1"`) || len(res.Draft.TestCases) != 1 {
		t.Errorf("failed reference: %+v %v", lc, res.Check.Error)
	}
	// Skipped without a reference solution or an engine.
	noRef := largeDraft(gen("gen 10"))
	noRef["problem"].(map[string]any)["referenceSolution"] = nil
	if lc := must(newDraft(t, e, `{"text":"x","largeTestCase":true}`, noRef)).Check.LargeCase; lc.Status != "skipped" ||
		!strings.Contains(*lc.Error, "no reference solution") || *lc.Name != "Many sevens" {
		t.Errorf("no reference: %+v", lc)
	}
	ne := newEnv(t, withoutEngine())
	ne.enableAI(t)
	if lc := must(newDraft(t, ne, `{"text":"x","largeTestCase":true}`, largeDraft(gen("gen 10")))).Check.LargeCase; lc.Status != "skipped" ||
		!strings.Contains(*lc.Error, "no judge engine") {
		t.Errorf("no engine: %+v", lc)
	}
	e.engine.SetHealth(errStr("down"))
	if lc := must(newDraft(t, e, `{"text":"x","largeTestCase":true}`, largeDraft(gen("gen 10")))).Check.LargeCase; lc.Status != "skipped" {
		t.Errorf("engine down: %+v", lc)
	}
	e.engine.SetHealth(nil)
	// A reading ignores the flag.
	reading := draftJSON()
	reading["type"] = "reading"
	if res := must(newDraft(t, e, `{"text":"x","typeHint":"reading","largeTestCase":true}`, reading)); res.Check != nil {
		t.Errorf("reading: %+v", res.Check)
	}
}

type errStr string

func (e errStr) Error() string { return string(e) }

// For a function problem the generator runs as a plain program and prints
// the runner's input; the reference solution runs inside the harness.
func TestLargeCaseOfAFunctionProblem(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.enableAI(t)
	e.engine.Handler = generatorHandler
	d := fnDraftJSON()
	d["testCases"] = []map[string]any{{"name": "Example 1", "stdin": "1 2", "expectedStdout": "3", "isSample": true}}
	d["largeCase"] = gen("gen 3000")
	res := must(newDraft(t, e, `{"text":"x","largeTestCase":true}`, d))
	if lc := res.Check.LargeCase; lc.Status != "added" || *lc.Index != 1 {
		t.Fatalf("large case: %+v %v", lc, lc.Error)
	}
	var sawGenerator, sawReference bool
	for _, r := range e.engine.Requests() {
		if r.Source == "gen 3000" && r.Stdin == "" && r.TimeLimitMs == 10000 && r.MemoryLimitKb == 512<<10 {
			sawGenerator = true
		}
		if strings.HasPrefix(r.Source, "from __future__") && len(r.Stdin) == 3000 && r.TimeLimitMs == 1000 {
			sawReference = true
		}
	}
	if !sawGenerator || !sawReference {
		t.Errorf("generator run %v, reference run in the harness %v", sawGenerator, sawReference)
	}
	// The runners still run after it, on the first case.
	if len(res.Check.Runners) != 1 || res.Check.Runners[0].Status != "ok" {
		t.Errorf("runners: %+v", res.Check.Runners)
	}
}

func TestGeneratedTestsWithALargeCase(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler
	it := e.problem(t, "")
	respond := func(source string) {
		e.ai.Respond = func(ai.GenerateRequest) (any, error) {
			return map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "sum"},
				"cases":     []map[string]any{{"name": "small", "rationale": "x", "stdin": "4 4", "predictedStdout": "8", "isSample": false}},
				"largeCase": gen(source)}, nil
		}
	}
	respond("gen 50000")
	res := must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1,"largeTestCase":true}`)))
	if len(res.Cases) != 2 || res.LargeCase == nil || res.LargeCase.Status != "added" || *res.LargeCase.Index != 1 {
		t.Fatalf("response: %+v %+v", res.Cases, res.LargeCase)
	}
	l := res.Cases[1]
	if l.PredictedStdout != nil || l.PredictionMatched != nil || !l.Verified || l.IsSample || l.ExpectedStdout != "175000\n" ||
		l.Rationale != "Big n." {
		t.Errorf("large case: %+v", l)
	}
	b, _ := json.Marshal(l)
	if !strings.Contains(string(b), `"predictedStdout":null`) {
		t.Errorf("JSON: %.200s", b)
	}
	// Repeating a stored case or a proposed one fails it.
	for _, input := range []string{"5 5", "4 4"} {
		respond("gen-text " + input)
		res = must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1,"largeTestCase":true}`)))
		if res.LargeCase.Status != "failed" || !strings.Contains(*res.LargeCase.Error, "repeats") || len(res.Cases) != 1 {
			t.Errorf("repeat of %q: %+v", input, res.LargeCase)
		}
	}
	// Without the flag there is no report, and nothing is asked for.
	respond("gen 50")
	res = must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1}`)))
	if res.LargeCase != nil || len(res.Cases) != 1 || strings.Contains(e.ai.Last().System, `"largeCase"`) {
		t.Errorf("unasked: %+v", res.LargeCase)
	}
	if b, _ := json.Marshal(res); !strings.Contains(string(b), `"largeCase":null`) {
		t.Error("largeCase is not null")
	}

	// A stored large case never reaches a prompt or the AI log.
	respond("gen 600000")
	res = must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1,"largeTestCase":true}`)))
	l = res.Cases[1]
	must(e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t, mustJSON(t, map[string]any{
		"cases": []map[string]any{{"name": l.Name, "stdin": l.Stdin, "expectedStdout": l.ExpectedStdout, "origin": "ai", "verified": true}}}))))
	respond("gen 10")
	res = must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1}`)))
	u := e.ai.Last().User
	if strings.Contains(u, "7 7 7 7") || !strings.Contains(u, "--- Many sevens (hidden)\n(input of 600000 bytes and expected output of 8 bytes, too large to show)") {
		t.Errorf("a stored large case in the prompt: %.300s", u)
	}
	d := must(e.app.GetAILogEntry(e.ctx, *res.Usage.LogID))
	if len(d.Request) > 64<<10 {
		t.Errorf("the logged request is %d bytes", len(d.Request))
	}
}

// A revision does not carry a large case over: the previous draft's large
// cases are named and sized, never shown.
func TestRevisionsDoNotShowLargeCases(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	prev := draftJSON()
	prev["testCases"] = []map[string]any{
		{"name": "Example 1", "stdin": "1 2", "expectedStdout": "3", "isSample": true},
		{"name": "Huge", "stdin": strings.Repeat("7 ", 300000), "expectedStdout": "2100000", "isSample": false},
	}
	body := mustJSON(t, map[string]any{"text": "x", "instruction": "shorter", "previousDraft": prev})
	must(newDraft(t, e, body, draftJSON()))
	u := e.ai.Last().User
	if strings.Contains(u, "7 7 7 7") || !strings.Contains(u, `"largeTestCasesOmitted":[{"expectedOutputBytes":7,"inputBytes":600000,"name":"Huge"}]`) ||
		!strings.Contains(u, "Leave them out of the revision") || !strings.Contains(u, `"stdin":"1 2"`) {
		t.Errorf("revision prompt: %.600s", u)
	}
	// A variant's original shows a large sample by name and size.
	it := e.problem(t, "")
	must(e.app.AddTestCase(e.ctx, it.ID, decodeInto[domain.TestCaseInput](t, mustJSON(t, map[string]any{
		"name": "Big sample", "stdin": strings.Repeat("1 ", 5000), "expectedStdout": "5000", "isSample": true}))))
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	must(e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{}`)))
	if u := e.ai.Last().User; strings.Contains(u, "1 1 1 1") || !strings.Contains(u, "input of 10000 bytes") {
		t.Errorf("variant prompt: %.600s", u)
	}
}

func TestLargeTestCasePreferenceAndLimit(t *testing.T) {
	e := newEnv(t)
	if p := must(e.app.GetPreferences(e.ctx)); p["largeTestCase"] != false {
		t.Errorf("default: %v", p["largeTestCase"])
	}
	if p := must(e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"largeTestCase":true}`))); p["largeTestCase"] != true {
		t.Errorf("saved: %v", p["largeTestCase"])
	}
	_, err := e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"largeTestCase":"yes"}`))
	wantField(t, err, "largeTestCase")
	if m := must(e.app.Meta(e.ctx)); m.Limits.MaxLargeInputBytes != 1<<20 {
		t.Errorf("limit: %d", m.Limits.MaxLargeInputBytes)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The draft check's 10-case cap does not starve the large case.
func TestLargeCaseAfterManyCases(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler
	d := largeDraft(gen("gen 20000"))
	var cases []map[string]any
	for i := range 12 {
		cases = append(cases, map[string]any{"name": "c" + strconv.Itoa(i), "stdin": strconv.Itoa(i), "expectedStdout": strconv.Itoa(i), "isSample": true})
	}
	d["testCases"] = cases
	res := must(newDraft(t, e, `{"text":"x","largeTestCase":true}`, d))
	c := res.Check
	if c.LargeCase.Status != "added" || *c.LargeCase.Index != 12 || c.Total != 13 || c.Passed != 11 ||
		!strings.Contains(*c.Error, "only the first 10") {
		t.Errorf("check: %+v %+v %v", c, c.LargeCase, *c.Error)
	}
}
