package app_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/judge/judgetest"
	"codeatrophy/internal/store"
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

// largeDraft is a draft whose model also wrote the given generators.
func largeDraft(gens ...any) map[string]any {
	d := draftJSON()
	d["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "sum"}
	if gens == nil {
		gens = []any{}
	}
	d["largeCases"] = gens
	return d
}

func gen(source string) map[string]any {
	return map[string]any{"name": "Many sevens", "rationale": "Big n.", "language": "python", "source": source}
}

func named(name, source string) map[string]any {
	g := gen(source)
	g["name"] = name
	return g
}

func TestDraftWithLargeTestCases(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler

	// Three generators give three cases, appended in the model's order.
	res := must(draftWith(t, e, `{"text":"x","largeTestCases":3}`,
		largeDraft(gen("gen 200000"), named("Second", "gen 3000"), named("Third", "gen 5000"))))
	c, d := res.Check, res.Draft
	if len(c.LargeCases) != 3 {
		t.Fatalf("large cases: %+v", c.LargeCases)
	}
	lc := c.LargeCases[0]
	if lc.Status != "added" || lc.Error != nil || *lc.Index != 1 || *lc.Name != "Many sevens" ||
		*lc.InputBytes != 200000 || lc.TimeMs == nil || lc.Generator.Source != "gen 200000" || lc.Generator.Language != "python" {
		t.Fatalf("large case: %+v", lc)
	}
	for i, want := range []struct {
		name  string
		bytes int
	}{{"Many sevens", 200000}, {"Second", 3000}, {"Third", 5000}} {
		lc, tc := c.LargeCases[i], d.TestCases[i+1]
		if lc.Status != "added" || *lc.Index != i+1 || *lc.Name != want.name || tc.Name != want.name ||
			len(tc.Stdin) != want.bytes || tc.IsSample || !tc.Verified || tc.ExpectedStdout != strconv.Itoa(7*want.bytes/2)+"\n" ||
			tc.Generator == nil || *tc.Generator != *lc.Generator {
			t.Errorf("large case %d: %+v, test case %q (%d bytes)", i, lc, tc.Name, len(tc.Stdin))
		}
	}
	if d.TestCases[0].Generator != nil {
		t.Errorf("a case the model wrote has a generator: %+v", d.TestCases[0].Generator)
	}
	if len(d.TestCases) != 4 || c.Passed != 4 || c.Total != 4 || c.Error != nil {
		t.Errorf("check: %+v, %d cases", c, len(d.TestCases))
	}
	req := e.ai.Last()
	b, _ := json.Marshal(req.Schema)
	if !strings.Contains(req.System, `"largeCases"`) || !strings.Contains(string(b), `"largeCases"`) {
		t.Error("the large cases are not asked for")
	}

	// None asked for: not asked for, and an empty list, never null.
	res = must(draftWith(t, e, `{"text":"x"}`, largeDraft(gen("gen 2000"))))
	b, _ = json.Marshal(e.ai.Last().Schema)
	if res.Check.LargeCases == nil || len(res.Check.LargeCases) != 0 || len(res.Draft.TestCases) != 1 ||
		strings.Contains(string(b), "largeCases") || strings.Contains(e.ai.Last().System, `"largeCases"`) {
		t.Errorf("unasked: %+v", res.Check.LargeCases)
	}
	if b, _ := json.Marshal(res); !strings.Contains(string(b), `"largeCases":[]`) {
		t.Errorf("JSON: %s", b)
	}

	// Generators beyond the number asked for are ignored.
	res = must(draftWith(t, e, `{"text":"x","largeTestCases":1}`, largeDraft(gen("gen 2000"), gen("gen 4000"))))
	if len(res.Check.LargeCases) != 1 || len(res.Draft.TestCases) != 2 || len(res.Draft.TestCases[1].Stdin) != 2000 {
		t.Errorf("extra generators: %+v", res.Check.LargeCases)
	}

	// Fewer generators than asked for: the missing ones fail, the others
	// are added.
	res = must(draftWith(t, e, `{"text":"x","largeTestCases":3}`, largeDraft(gen("gen 2000"))))
	ls := res.Check.LargeCases
	if len(ls) != 3 || ls[0].Status != "added" || len(res.Draft.TestCases) != 2 {
		t.Fatalf("fewer generators: %+v", ls)
	}
	for _, lc := range ls[1:] {
		if lc.Status != "failed" || *lc.Error != "the model wrote only 1 of the 3 generators asked for" || lc.Name != nil ||
			lc.Generator != nil || lc.Index != nil || lc.InputBytes != nil {
			t.Errorf("missing generator: %+v", lc)
		}
	}
	if b, _ := json.Marshal(ls[2]); !strings.Contains(string(b), `"name":null`) || !strings.Contains(string(b), `"generator":null`) {
		t.Errorf("JSON: %s", b)
	}
	// None at all.
	for _, d := range []map[string]any{largeDraft(), draftJSON()} {
		d["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "sum"}
		res = must(draftWith(t, e, `{"text":"x","largeTestCases":2}`, d))
		if ls := res.Check.LargeCases; len(ls) != 2 || ls[0].Status != "failed" || *ls[0].Error != "the model wrote no generator" ||
			*ls[1].Error != "the model wrote no generator" || len(res.Draft.TestCases) != 1 {
			t.Errorf("no generator: %+v", ls)
		}
	}

	// Every way one can fail, among good ones it never affects.
	for name, tc := range map[string]struct {
		gen  any
		want string
	}{
		"no generator":       {nil, "the model wrote no generator"},
		"unknown language":   {map[string]any{"name": "x", "rationale": "", "language": "cobol", "source": "gen 9"}, "unknown language"},
		"not offered":        {map[string]any{"name": "x", "rationale": "", "language": "java", "source": "gen 9"}, "does not run"},
		"does not compile":   {gen("COMPILE_ERROR"), "does not compile"},
		"crashes":            {gen("crash"), "the generator failed: runtime error: boom"},
		"times out":          {gen("timeout"), "time limit exceeded"},
		"too large":          {gen("gen-big"), "printed more than 1048576 bytes"},
		"prints nothing":     {gen("gen-empty"), "printed nothing"},
		"not UTF-8":          {gen("gen-badutf8"), "not UTF-8"},
		"repeats an example": {gen("gen-text 1 2"), `repeats "Example 1"`},
		"too slow":           {gen("gen 4000"), "exceeded the time limit of 100 ms on the large input"},
	} {
		d := largeDraft(gen("gen 2000"), tc.gen, gen("gen 3000"))
		if name == "too slow" {
			// The reference solution is too slow on more than 1000 bytes.
			d = largeDraft(gen("gen 500"), tc.gen, gen("gen 800"))
			d["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "sum-small"}
		}
		res := must(draftWith(t, e, `{"text":"x","largeTestCases":3}`, d))
		ls := res.Check.LargeCases
		if len(ls) != 3 {
			t.Errorf("%s: %+v", name, ls)
			continue
		}
		if lc := ls[1]; lc.Status != "failed" || lc.Error == nil || !strings.Contains(*lc.Error, tc.want) || lc.Index != nil {
			t.Errorf("%s: %+v %v", name, lc, lc.Error)
		}
		if ls[0].Status != "added" || *ls[0].Index != 1 || ls[2].Status != "added" || *ls[2].Index != 2 ||
			len(res.Draft.TestCases) != 3 || res.Check.Total != 3 || res.Check.Passed != 3 {
			t.Errorf("%s: the others: %+v %+v, %d cases", name, ls[0], ls[2], len(res.Draft.TestCases))
		}
	}

	// An input that repeats an earlier large case fails; the earlier one
	// stays.
	res = must(draftWith(t, e, `{"text":"x","largeTestCases":3}`,
		largeDraft(named("A", "gen-text 9 9"), named("B", "gen 2000"), named("C", "gen-text 9 9  "))))
	if ls := res.Check.LargeCases; ls[0].Status != "added" || ls[1].Status != "added" || ls[2].Status != "failed" ||
		*ls[2].Error != "the generated input repeats large case 1" || ls[2].TimeMs != nil || ls[2].Index != nil ||
		*ls[2].InputBytes != 6 || len(res.Draft.TestCases) != 3 {
		t.Errorf("repeated large case: %+v %v", ls, ls[2].Error)
	}

	// Not built from a reference solution that failed another case: their
	// output would be marked verified and probably be wrong.
	wrong := largeDraft(gen("gen 2000"), gen("gen 3000"))
	wrong["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "double"}
	res = must(draftWith(t, e, `{"text":"x","largeTestCases":2}`, wrong))
	if res.Check.Error == nil || !strings.Contains(*res.Check.Error, `"Example 1"`) || len(res.Draft.TestCases) != 1 {
		t.Errorf("failed reference: %v", res.Check.Error)
	}
	for _, lc := range res.Check.LargeCases {
		if lc.Status != "skipped" || *lc.Error != "the reference solution did not pass the other test cases" {
			t.Errorf("failed reference: %+v", lc)
		}
	}
	// Skipped without a reference solution or an engine, every one of them.
	noRef := largeDraft(gen("gen 10"), gen("gen 20"))
	noRef["problem"].(map[string]any)["referenceSolution"] = nil
	ls = must(draftWith(t, e, `{"text":"x","largeTestCases":2}`, noRef)).Check.LargeCases
	if len(ls) != 2 || ls[0].Status != "skipped" || !strings.Contains(*ls[0].Error, "no reference solution") ||
		*ls[0].Name != "Many sevens" || ls[1].Status != "skipped" || *ls[1].Error != *ls[0].Error {
		t.Errorf("no reference: %+v", ls)
	}
	ne := newEnv(t, withoutEngine())
	ne.enableAI(t)
	ls = must(draftWith(t, ne, `{"text":"x","largeTestCases":3}`, largeDraft(gen("gen 10")))).Check.LargeCases
	for _, lc := range ls {
		if lc.Status != "skipped" || !strings.Contains(*lc.Error, "no judge engine") {
			t.Errorf("no engine: %+v", lc)
		}
	}
	if len(ls) != 3 {
		t.Errorf("no engine: %d reports", len(ls))
	}
	e.engine.SetHealth(errStr("down"))
	for _, lc := range must(draftWith(t, e, `{"text":"x","largeTestCases":2}`, largeDraft(gen("gen 10"), gen("gen 20")))).Check.LargeCases {
		if lc.Status != "skipped" {
			t.Errorf("engine down: %+v", lc)
		}
	}
	e.engine.SetHealth(nil)
	// A reading ignores the count.
	reading := draftJSON()
	reading["type"] = "reading"
	if res := must(draftWith(t, e, `{"text":"x","typeHint":"reading","largeTestCases":2}`, reading)); res.Check != nil ||
		strings.Contains(e.ai.Last().System, "largeCases") {
		t.Errorf("reading: %+v", res.Check)
	}
	// The count is bounded, for a reading too.
	for _, body := range []string{`{"text":"x","largeTestCases":6}`, `{"text":"x","largeTestCases":-1}`,
		`{"text":"x","typeHint":"reading","largeTestCases":6}`} {
		_, err := draftWith(t, e, body, largeDraft())
		if wantField(t, err, "largeTestCases"); app.AsError(err).Fields["largeTestCases"] != "must be between 0 and 5" {
			t.Errorf("%s: %v", body, app.AsError(err).Fields)
		}
	}
}

// The large cases run in parallel, so that several take about as long as
// one: each generator here waits until all three have started.
func TestLargeCasesRunInParallel(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	var started atomic.Int32
	all := make(chan struct{})
	e.engine.Handler = func(ctx context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		if n, ok := strings.CutPrefix(req.Source, "gen-together "); ok {
			if started.Add(1) == 3 {
				close(all)
			}
			select {
			case <-all:
			case <-ctx.Done():
				return judge.ExecResult{}, ctx.Err()
			}
			req.Source = "gen " + n
		}
		return generatorHandler(ctx, req)
	}
	ctx, cancel := context.WithTimeout(e.ctx, 10*time.Second)
	defer cancel()
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return largeDraft(gen("gen-together 2000"), gen("gen-together 3000"), gen("gen-together 4000")), nil
	}
	res := must(e.app.Draft(ctx, decodeInto[app.DraftInput](t, `{"text":"x","largeTestCases":3}`)))
	for i, lc := range res.Check.LargeCases {
		if lc.Status != "added" || *lc.Index != i+1 {
			t.Errorf("large case %d: %+v %v", i, lc, lc.Error)
		}
	}
}

// Cases not finished when the check's time runs out are skipped; the
// others are kept.
func TestLargeCasesOutOfTime(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	// The time runs out once both hanging generators have started and the
	// good case's reference run has its result.
	ctx, cancel := context.WithCancel(e.ctx)
	defer cancel()
	var hanging atomic.Int32
	var goodDone atomic.Bool
	runOut := func() {
		if hanging.Load() == 2 && goodDone.Load() {
			cancel()
		}
	}
	e.engine.Handler = func(hctx context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		switch {
		case req.Source == "gen-hang":
			hanging.Add(1)
			runOut()
			<-hctx.Done()
			return judge.ExecResult{}, hctx.Err()
		case req.Source == "sum" && len(req.Stdin) == 2000:
			r, err := generatorHandler(hctx, req)
			goodDone.Store(true)
			runOut()
			return r, err
		}
		return generatorHandler(hctx, req)
	}
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return largeDraft(gen("gen-hang"), gen("gen 2000"), gen("gen-hang")), nil
	}
	res := must(e.app.Draft(ctx, decodeInto[app.DraftInput](t, `{"text":"x","largeTestCases":3}`)))
	ls := res.Check.LargeCases
	if len(ls) != 3 || ls[1].Status != "added" || *ls[1].Index != 1 || len(res.Draft.TestCases) != 2 {
		t.Fatalf("large cases: %+v", ls)
	}
	for _, lc := range []*app.LargeCaseReport{ls[0], ls[2]} {
		if lc.Status != "skipped" || *lc.Error != "the check's time ran out" || lc.Index != nil {
			t.Errorf("out of time: %+v %v", lc, lc.Error)
		}
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
	d["largeCases"] = []any{gen("gen 3000")}
	res := must(draftWith(t, e, `{"text":"x","largeTestCases":1}`, d))
	if lc := res.Check.LargeCases[0]; lc.Status != "added" || *lc.Index != 1 {
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

func TestGeneratedTestsWithLargeCases(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler
	it := e.problem(t, "")
	respond := func(sources ...string) {
		gens := []any{}
		for _, s := range sources {
			gens = append(gens, gen(s))
		}
		e.ai.Respond = func(ai.GenerateRequest) (any, error) {
			answer := casesAnswer("4 4", "8")
			answer["largeCases"] = gens
			return answer, nil
		}
	}
	generate := func(js string) app.GenerateTestCasesResponse {
		return must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, js)))
	}
	respond("gen 50000", "gen 2000")
	res := generate(`{"count":1,"largeTestCases":2}`)
	if len(res.Cases) != 3 || len(res.LargeCases) != 2 || res.LargeCases[0].Status != "added" || *res.LargeCases[0].Index != 1 ||
		res.LargeCases[1].Status != "added" || *res.LargeCases[1].Index != 2 {
		t.Fatalf("response: %+v %+v", res.Cases, res.LargeCases)
	}
	l := res.Cases[1]
	if l.PredictedStdout != nil || l.PredictionMatched != nil || !l.Verified || l.IsSample || l.ExpectedStdout != "175000\n" ||
		l.Rationale != "Big n." || len(res.Cases[2].Stdin) != 2000 ||
		l.Generator == nil || l.Generator.Source != "gen 50000" || res.Cases[0].Generator != nil {
		t.Errorf("large case: %+v", l)
	}
	b, _ := json.Marshal(l)
	if !strings.Contains(string(b), `"predictedStdout":null`) {
		t.Errorf("JSON: %.200s", b)
	}
	if s := e.ai.Last().System; !strings.Contains(s, `"largeCases": a list of exactly 2 generators`) {
		t.Errorf("prompt: %.300s", s)
	}
	// Repeating a stored case, a proposed one or an earlier large case
	// fails it, and only it.
	for _, input := range []string{"5 5", "4 4"} {
		respond("gen 2000", "gen-text "+input)
		res = generate(`{"count":1,"largeTestCases":2}`)
		if res.LargeCases[0].Status != "added" || res.LargeCases[1].Status != "failed" ||
			!strings.Contains(*res.LargeCases[1].Error, "repeats") || len(res.Cases) != 2 {
			t.Errorf("repeat of %q: %+v", input, res.LargeCases[1])
		}
	}
	respond("gen 2000", "gen 2000")
	res = generate(`{"count":1,"largeTestCases":2}`)
	if res.LargeCases[1].Status != "failed" || *res.LargeCases[1].Error != "the generated input repeats large case 1" || len(res.Cases) != 2 {
		t.Errorf("repeat of a large case: %+v", res.LargeCases[1])
	}
	// Fewer than asked for.
	respond("gen 2000")
	res = generate(`{"count":1,"largeTestCases":2}`)
	if len(res.LargeCases) != 2 || res.LargeCases[0].Status != "added" || res.LargeCases[1].Status != "failed" ||
		res.LargeCases[1].Generator != nil || len(res.Cases) != 2 {
		t.Errorf("fewer: %+v", res.LargeCases)
	}
	// None asked for: an empty list, and nothing asked for.
	respond("gen 50")
	res = generate(`{"count":1}`)
	if res.LargeCases == nil || len(res.LargeCases) != 0 || len(res.Cases) != 1 || strings.Contains(e.ai.Last().System, `"largeCases"`) {
		t.Errorf("unasked: %+v", res.LargeCases)
	}
	if b, _ := json.Marshal(res); !strings.Contains(string(b), `"largeCases":[]`) {
		t.Error("largeCases is not []")
	}
	// The count is bounded.
	for _, js := range []string{`{"largeTestCases":6}`, `{"largeTestCases":-1}`} {
		_, err := e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, js))
		wantField(t, err, "largeTestCases")
	}
	_, err := e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{"largeTestCases":6}`))
	wantField(t, err, "largeTestCases")

	// A stored large case never reaches a prompt or the AI log.
	respond("gen 600000")
	res = generate(`{"count":1,"largeTestCases":1}`)
	l = res.Cases[1]
	must(e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t, mustJSON(t, map[string]any{
		"cases": []map[string]any{{"name": l.Name, "stdin": l.Stdin, "expectedStdout": l.ExpectedStdout, "origin": "ai", "verified": true}}}))))
	respond("gen 10")
	res = generate(`{"count":1}`)
	u := e.ai.Last().User
	if strings.Contains(u, "7 7 7 7") || !strings.Contains(u, "--- Many sevens (hidden)\n(input of 600000 bytes and expected output of 8 bytes, too large to show)") {
		t.Errorf("a stored large case in the prompt: %.300s", u)
	}
	d := must(e.app.GetAILogEntry(e.ctx, *res.Usage.LogID))
	if len(d.Request) > 64<<10 {
		t.Errorf("the logged request is %d bytes", len(d.Request))
	}
}

// Generated tests build no large case without an engine, nor from a
// reference solution too large for the engine to run (which, as in a
// draft, did not pass the other cases: verification says why); the
// proposed cases are still returned.
func TestGeneratedLargeCasesNeedARunnableReference(t *testing.T) {
	answer := func(lang, source string) func(ai.GenerateRequest) (any, error) {
		return func(ai.GenerateRequest) (any, error) {
			a := casesAnswer("4 4", "8")
			a["referenceSolution"] = map[string]any{"language": lang, "source": source}
			a["largeCases"] = []any{gen("gen 2000"), gen("gen 3000")}
			return a, nil
		}
	}
	for name, c := range map[string]struct {
		opt                  option
		lang, source, status string
		want                 string
	}{
		"no engine": {withoutEngine(), "python", "sum", "skipped", "no judge engine is configured"},
		"too large": {withToolchains(20), "cpp", "int main() { return 0; }", "skipped", "the reference solution did not pass the other test cases"},
	} {
		e := newEnv(t, c.opt)
		e.enableAI(t)
		it := e.problem(t, "")
		e.ai.Respond = answer(c.lang, c.source)
		res, err := e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t,
			`{"count":1,"largeTestCases":2,"language":"`+c.lang+`"}`))
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if len(res.Cases) != 1 || len(res.LargeCases) != 2 {
			t.Errorf("%s: %d cases, %d reports", name, len(res.Cases), len(res.LargeCases))
			continue
		}
		for _, lc := range res.LargeCases {
			if lc.Status != c.status || lc.Error == nil || !strings.Contains(*lc.Error, c.want) || lc.Index != nil {
				t.Errorf("%s: %+v %s", name, lc, ptrString(lc.Error))
			}
		}
		if v := res.Verification.Error; name == "too large" && (v == nil || !strings.Contains(*v, "the reference solution cannot run: the program is")) {
			t.Errorf("%s: verification %s", name, ptrString(v))
		}
	}
}

// Generated tests build no large case from a reference solution that
// failed a proposed case, as a draft does not: its output would be marked
// verified and probably be wrong. A prediction the reference solution
// disagrees with is not a failure.
func TestGeneratedLargeCasesSkippedWhenTheReferenceFails(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler
	it := e.problem(t, "")
	answer := func(source, predicted string) {
		e.ai.Respond = func(ai.GenerateRequest) (any, error) {
			a := casesAnswer("4 4", predicted)
			a["referenceSolution"] = map[string]any{"language": "python", "source": source}
			a["largeCases"] = []any{gen("gen 2000"), named("Second", "gen 3000")}
			return a, nil
		}
	}
	for _, source := range []string{"crash", "timeout", "COMPILE_ERROR"} {
		answer(source, "8")
		res := must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1,"largeTestCases":2}`)))
		if len(res.Cases) != 1 || res.Cases[0].Verified || len(res.LargeCases) != 2 {
			t.Errorf("%s: %+v %+v", source, res.Cases, res.LargeCases)
			continue
		}
		for i, lc := range res.LargeCases {
			if lc.Status != "skipped" || lc.Error == nil || *lc.Error != "the reference solution did not pass the other test cases" ||
				lc.Index != nil || lc.Name == nil || *lc.Name != []string{"Many sevens", "Second"}[i] || lc.Generator == nil {
				t.Errorf("%s: %+v %s", source, lc, ptrString(lc.Error))
			}
		}
	}
	answer("sum", "9")
	res := must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1,"largeTestCases":2}`)))
	if len(res.Cases) != 3 || *res.Cases[0].PredictionMatched || res.LargeCases[0].Status != "added" || res.LargeCases[1].Status != "added" {
		t.Errorf("a wrong prediction: %+v %+v", res.Cases, res.LargeCases)
	}
}

// A variant asks for large cases too, and builds them like a draft.
func TestVariantWithLargeTestCases(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler
	it := e.problem(t, "")
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return largeDraft(gen("gen 2000"), gen("gen 3000")), nil }
	res := must(e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{"largeTestCases":2}`)))
	if ls := res.Check.LargeCases; len(ls) != 2 || ls[0].Status != "added" || *ls[1].Index != 2 || len(res.Draft.TestCases) != 3 {
		t.Errorf("variant: %+v", ls)
	}
	if !strings.Contains(e.ai.Last().System, "exactly 2 generators") {
		t.Error("the variant prompt does not ask for them")
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
		// Large by its generator, however small its input.
		{"name": "Largest n", "stdin": "1000000000000\n", "expectedStdout": "1", "generator": map[string]string{"language": "python", "source": "print(10**12)"}},
	}
	body := mustJSON(t, map[string]any{"text": "x", "instruction": "shorter", "previousDraft": prev})
	must(draftWith(t, e, body, draftJSON()))
	u := e.ai.Last().User
	if strings.Contains(u, "7 7 7 7") || strings.Contains(u, "10**12") ||
		!strings.Contains(u, `"largeTestCasesOmitted":[{"expectedOutputBytes":7,"inputBytes":600000,"name":"Huge"},{"expectedOutputBytes":1,"inputBytes":14,"name":"Largest n"}]`) ||
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

func TestLargeTestCasePreferencesAndLimits(t *testing.T) {
	e := newEnv(t)
	if p := must(e.app.GetPreferences(e.ctx)); p["largeTestCase"] != false || p["largeTestCaseCount"] != 3 {
		t.Errorf("defaults: %v %v", p["largeTestCase"], p["largeTestCaseCount"])
	}
	// A document stored before the count existed keeps working: the count
	// takes its default.
	if err := e.db.Write(e.ctx, func(tx store.Tx) error {
		return tx.SetSetting("preferences", `{"largeTestCase":true,"generatedTestCases":12}`)
	}); err != nil {
		t.Fatal(err)
	}
	if p := must(e.app.GetPreferences(e.ctx)); p["largeTestCase"] != true || p["largeTestCaseCount"] != 3 || p["generatedTestCases"] != 12 {
		t.Errorf("an older document: %v", p)
	}
	if p := must(e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"largeTestCaseCount":5}`))); p["largeTestCaseCount"] != 5 ||
		p["largeTestCase"] != true {
		t.Errorf("saved: %v", p)
	}
	for _, bad := range []string{`{"largeTestCase":"yes"}`, `{"largeTestCaseCount":0}`, `{"largeTestCaseCount":6}`, `{"largeTestCaseCount":true}`} {
		_, err := e.app.UpdatePreferences(e.ctx, json.RawMessage(bad))
		wantField(t, err, strings.Split(bad, `"`)[1])
	}
	if p := must(e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"largeTestCaseCount":1}`))); p["largeTestCaseCount"] != 1 {
		t.Errorf("lower bound: %v", p["largeTestCaseCount"])
	}
	if m := must(e.app.Meta(e.ctx)); m.Limits.MaxLargeInputBytes != 1<<20 || m.Limits.MaxLargeTestCases != 5 {
		t.Errorf("limits: %d %d", m.Limits.MaxLargeInputBytes, m.Limits.MaxLargeTestCases)
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

// The large cases come after as many other cases as a draft can have, and
// the check's case cap does not apply to them.
func TestLargeCasesAfterManyCases(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler
	d := largeDraft(gen("gen 20000"), gen("gen 30000"))
	var cases []map[string]any
	for i := range domain.DefaultMaxGeneratedTestCases + 2 {
		cases = append(cases, map[string]any{"name": "c" + strconv.Itoa(i), "stdin": strconv.Itoa(i), "expectedStdout": strconv.Itoa(i), "isSample": i < 3})
	}
	d["testCases"] = cases
	res := must(draftWith(t, e, `{"text":"x","largeTestCases":2,"testCaseCount":30}`, d))
	c, n := res.Check, domain.DefaultMaxGeneratedTestCases
	if c.LargeCases[0].Status != "added" || *c.LargeCases[0].Index != n || *c.LargeCases[1].Index != n+1 || c.Total != n+2 ||
		c.Passed != n+2 || c.Error != nil {
		t.Errorf("check: %+v %+v %v", c, c.LargeCases, c.Error)
	}
}

// The operator's generation limits bound every request and preference that
// counts test cases, with the usual messages; a preference saved under a
// higher limit reads as the limit, and the defaults never exceed it.
func TestConfiguredGenerationLimits(t *testing.T) {
	e := newEnv(t, func(o *app.Options) { o.Limits.MaxGeneratedTestCases = 6; o.Limits.MaxLargeTestCases = 2 })
	e.enableAI(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	m := must(e.app.Meta(e.ctx)).Limits
	ov := must(e.app.Overview(e.ctx))
	if m.MaxGeneratedTestCases != 6 || m.MaxLargeTestCases != 2 || ov.Limits.MaxGeneratedTestCases != 6 || ov.Limits.MaxLargeTestCases != 2 {
		t.Errorf("published limits: %+v %+v", m, ov.Limits)
	}
	// The defaults (8 and 3) are above the limits.
	if p := must(e.app.GetPreferences(e.ctx)); p["generatedTestCases"] != 6 || p["largeTestCaseCount"] != 2 {
		t.Errorf("defaults: %v", p)
	}
	if p := ov.Preferences; p.GeneratedTestCases != 6 || p.LargeTestCaseCount != 2 {
		t.Errorf("overview preferences: %+v", p)
	}

	field := func(err error, name, want string) {
		t.Helper()
		if wantField(t, err, name); app.AsError(err).Fields[name] != want {
			t.Errorf("%s: %v", name, app.AsError(err).Fields)
		}
	}
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x","testCaseCount":7}`))
	field(err, "testCaseCount", "must be between 0 and 6")
	_, err = e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x","largeTestCases":3}`))
	field(err, "largeTestCases", "must be between 0 and 2")
	_, err = e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{"testCaseCount":7}`))
	field(err, "testCaseCount", "must be between 0 and 6")
	_, err = e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{"largeTestCases":3}`))
	field(err, "largeTestCases", "must be between 0 and 2")
	_, err = e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":7}`))
	field(err, "count", "must be between 1 and 6")
	_, err = e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"largeTestCases":3}`))
	field(err, "largeTestCases", "must be between 0 and 2")
	_, err = e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"generatedTestCases":7}`))
	field(err, "generatedTestCases", "must be between 1 and 6")
	_, err = e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"largeTestCaseCount":3}`))
	field(err, "largeTestCaseCount", "must be between 1 and 2")

	// At the limits everything is accepted; without a count, test-case
	// generation asks for the default within the limit.
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x","testCaseCount":6,"largeTestCases":2}`)))
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return casesAnswer("7 7", "14"), nil }
	must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{}`)))
	if u := e.ai.Last().User; !strings.Contains(u, "propose exactly 6 test cases") {
		t.Errorf("default count: %s", u)
	}

	// Saved under higher limits, then read under these.
	if err := e.db.Write(e.ctx, func(tx store.Tx) error {
		return tx.SetSetting("preferences", `{"generatedTestCases":25,"largeTestCaseCount":5}`)
	}); err != nil {
		t.Fatal(err)
	}
	if p := must(e.app.GetPreferences(e.ctx)); p["generatedTestCases"] != 6 || p["largeTestCaseCount"] != 2 {
		t.Errorf("clamped: %v", p)
	}
	if p := must(e.app.TestCasePreferences(e.ctx)); p.GeneratedTestCases != 6 || p.LargeTestCaseCount != 2 {
		t.Errorf("clamped for MCP: %+v", p)
	}
	if p := must(e.app.UpdatePreferences(e.ctx, json.RawMessage(`{"hideTestCases":false}`))); p["generatedTestCases"] != 6 {
		t.Errorf("clamped after another write: %v", p)
	}
	// Values below a limit are not touched, and an invalid one still falls back to the default.
	if err := e.db.Write(e.ctx, func(tx store.Tx) error {
		return tx.SetSetting("preferences", `{"generatedTestCases":4,"largeTestCaseCount":0}`)
	}); err != nil {
		t.Fatal(err)
	}
	if p := must(e.app.GetPreferences(e.ctx)); p["generatedTestCases"] != 4 || p["largeTestCaseCount"] != 2 {
		t.Errorf("below the limit: %v", p)
	}
}
