package app_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"codeatrophy/internal/app"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/judge/judgetest"
)

func TestCheckUnsavedItem(t *testing.T) {
	e := newEnv(t, withToolchains(0))
	e.engine.Handler = harnessHandler
	before := len(must(e.app.ListAILog(e.ctx, app.AILogQuery{})).Items)

	// A program problem with more than ten cases, one with a wrong expected
	// output: every case runs.
	var cases []string
	for i := range 13 {
		exp := fmt.Sprint(2 * i)
		if i == 11 {
			exp = "999"
		}
		cases = append(cases, fmt.Sprintf(`{"name":"c%d","stdin":"%d %d","expectedStdout":%q}`, i, i, i, exp))
	}
	body := `{"type":"problem","title":"ignored","tags":["ignored"],"problem":{"referenceSolution":{"language":"python","source":"sum"}},
		"testCases":[` + strings.Join(cases, ",") + `]}`
	res := must(e.app.CheckItem(e.ctx, input(t, body)))
	c := res.Check
	if !c.Attempted || c.Passed != 12 || c.Total != 13 || c.LargeCases == nil || len(c.LargeCases) != 0 || len(res.Cases) != 13 ||
		res.Cases[11].Outcome != "wrong" || res.Cases[11].Error != nil || res.Cases[12].Outcome != "passed" ||
		c.Error == nil || !strings.Contains(*c.Error, `"c11"`) || len(c.Runners) != 0 {
		t.Errorf("check: %+v %+v %v", c, res.Cases, c.Error)
	}

	// A case the reference solution crashes on is failed; one the engine
	// failed on was not run.
	e.engine.Handler = func(ctx context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		switch req.Stdin {
		case "crash":
			r := req
			r.Source = "crash"
			return judgetest.Script(r), nil
		case "lost":
			return judge.ExecResult{}, errors.New("connection reset")
		}
		return harnessHandler(ctx, req)
	}
	outcomes := func(cases string) string {
		res := must(e.app.CheckItem(e.ctx, input(t, `{"problem":{"referenceSolution":{"language":"python","source":"sum"}},
			"testCases":[{"stdin":"1 2","expectedStdout":"3"},`+cases+`]}`)))
		got := []string{}
		for _, o := range res.Cases {
			s := o.Outcome
			if o.Error != nil {
				s += ": " + *o.Error
			}
			got = append(got, s)
		}
		return strings.Join(got, "\n")
	}
	if got := outcomes(`{"stdin":"crash","expectedStdout":"0"}`); got != "passed\nfailed: the reference solution failed: runtime error: boom" {
		t.Errorf("crash:\n%s", got)
	}
	if got := outcomes(`{"stdin":"lost","expectedStdout":"0"}`); got != "passed\nnot_run: the judge engine failed: connection reset" {
		t.Errorf("engine failure:\n%s", got)
	}
	e.engine.Handler = harnessHandler
	// A reference solution that does not compile fails every case.
	res = must(e.app.CheckItem(e.ctx, input(t, `{"problem":{"referenceSolution":{"language":"python","source":"COMPILE_ERROR"}},
		"testCases":[{"stdin":"1 2","expectedStdout":"3"},{"stdin":"2 2","expectedStdout":"4"}]}`)))
	if o := res.Cases[1]; o.Outcome != "failed" || !strings.Contains(*o.Error, "does not compile") {
		t.Errorf("compile error: %+v", res.Cases)
	}

	// A function problem: through the harness, then the runners.
	fn := `{"problem":{"interface":"function","starterCode":{"python":"class Solution:\n    pass\n"},"harness":` + fnHarness + `,
		"referenceSolution":{"language":"python","source":"sum"}},"testCases":[{"stdin":"1 2","expectedStdout":"3"}]}`
	res = must(e.app.CheckItem(e.ctx, input(t, fn)))
	if c := res.Check; c.Passed != 1 || len(c.Runners) != 2 || c.Runners[0].Status != "skipped" || c.Runners[1].Status != "ok" {
		t.Errorf("function problem: %+v", c)
	}
	if src := e.engine.Requests()[len(e.engine.Requests())-1].Source; !strings.HasPrefix(src, "from __future__") {
		t.Errorf("not run in the harness: %q", src)
	}

	// No reference solution or no test case: not attempted.
	for _, js := range []string{
		`{"problem":{},"testCases":[{"stdin":"1 2","expectedStdout":"3"}]}`,
		`{"problem":{"referenceSolution":{"language":"python","source":"sum"}}}`,
	} {
		res := must(e.app.CheckItem(e.ctx, input(t, js)))
		if res.Check.Attempted || res.Check.Engine != nil || len(res.Cases) != res.Check.Total {
			t.Errorf("%s: %+v", js, res.Check)
		}
		if len(res.Cases) == 1 && (res.Cases[0].Outcome != "not_run" || *res.Cases[0].Error != "there is no reference solution") {
			t.Errorf("%s: %+v", js, res.Cases)
		}
	}

	// Validated as for creating an item.
	for js, field := range map[string]string{
		`{"type":"reading","problem":{}}`:                              "type",
		`{"testCases":[]}`:                                             "problem",
		`{"problem":null}`:                                             "problem",
		`{"problem":{"timeLimitMs":5}}`:                                "problem.timeLimitMs",
		`{"problem":{"harness":{"python":{"prefix":"","suffix":""}}}}`: "problem.harness",
		`{"problem":{},"testCases":[{"stdin":"1"}]}`:                   "testCases.0.expectedStdout",
	} {
		_, err := e.app.CheckItem(e.ctx, input(t, js))
		wantField(t, err, field)
	}
	// Nothing stored, nothing logged.
	if st := must(e.app.Stats(e.ctx)); st.Items.Total != 0 {
		t.Errorf("stored %d items", st.Items.Total)
	}
	if n := len(must(e.app.ListAILog(e.ctx, app.AILogQuery{})).Items); n != before {
		t.Errorf("logged %d entries", n-before)
	}
}

func TestCheckUnsavedItemWithoutEngine(t *testing.T) {
	e := newEnv(t, withoutEngine())
	res := must(e.app.CheckItem(e.ctx, input(t, `{"problem":{"referenceSolution":{"language":"python","source":"sum"}},
		"testCases":[{"stdin":"1 2","expectedStdout":"3"}]}`)))
	if res.Check.Attempted || res.Cases[0].Outcome != "not_run" || *res.Cases[0].Error != "no judge engine is configured" {
		t.Errorf("no engine: %+v %+v", res.Check, res.Cases)
	}
}
