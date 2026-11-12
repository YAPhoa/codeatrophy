package grader

import (
	"context"
	"errors"
	"sync"
	"testing"

	"codeathropy/internal/domain"
	"codeathropy/internal/judge"
	"codeathropy/internal/judge/judgetest"
)

func strp(s string) *string { return &s }

func cases(pairs ...string) []Case {
	var out []Case
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, Case{Name: pairs[i], Stdin: pairs[i], Expected: strp(pairs[i+1])})
	}
	return out
}

func TestMatch(t *testing.T) {
	tests := []struct {
		mode      domain.CompareMode
		exp, got  string
		wantMatch bool
	}{
		{domain.CompareTokens, "1 2\n3\n", "1   2 3", true},
		{domain.CompareTokens, "1 2", "1 2 3", false},
		{domain.CompareTokens, "", "\n\n", true},
		{domain.CompareExact, "a b\nc\n", "a b  \nc\n\n\n", true},
		{domain.CompareExact, "a b\nc\n", "a  b\nc\n", false},
		{domain.CompareExact, "a\r\nb", "a\nb", true},
		{domain.CompareExact, "a\n\nb", "a\nb", false},
	}
	for _, tt := range tests {
		if got := Match(tt.mode, tt.exp, tt.got); got != tt.wantMatch {
			t.Errorf("Match(%s, %q, %q) = %v", tt.mode, tt.exp, tt.got, got)
		}
	}
}

func TestGradeVerdicts(t *testing.T) {
	g := New(judgetest.New(), 3)
	ctx := context.Background()
	prog := func(src string) Program {
		return Program{Language: "python", Source: src, TimeLimitMs: 1000, MemoryLimitKb: 65536}
	}

	out := g.Grade(ctx, prog("sum"), domain.CompareTokens, cases("1 2", "3", "4 5", "9", "1 1", "2"), nil)
	if out.Verdict != domain.VerdictAccepted || out.Passed != 3 || out.Total != 3 || len(out.Results) != 3 {
		t.Fatalf("accepted: %+v", out)
	}
	if out.TimeMs == nil || out.MemoryKb == nil {
		t.Error("max time and memory should be set")
	}

	out = g.Grade(ctx, prog("sum"), domain.CompareTokens, cases("1 2", "3", "4 5", "10", "1 1", "3"), nil)
	if out.Verdict != domain.VerdictWrongAnswer || out.Passed != 1 {
		t.Fatalf("wrong answer: %+v", out)
	}
	if out.Results[1].Verdict != domain.VerdictWrongAnswer || *out.Results[1].ExpectedStdout != "10" {
		t.Errorf("result 1: %+v", out.Results[1])
	}

	out = g.Grade(ctx, prog("compile_error"), domain.CompareTokens, cases("1", "1", "2", "2"), nil)
	if out.Verdict != domain.VerdictCompileError || len(out.Results) != 0 || out.CompileOutput == "" {
		t.Fatalf("compile error: %+v", out)
	}

	for src, want := range map[string]domain.Verdict{
		"crash":   domain.VerdictRuntimeError,
		"timeout": domain.VerdictTimeLimitExceeded,
		"oom":     domain.VerdictMemoryLimitExceeded,
	} {
		out = g.Grade(ctx, prog(src), domain.CompareTokens, cases("1", "1"), nil)
		if out.Verdict != want {
			t.Errorf("%s: verdict %s, want %s", src, out.Verdict, want)
		}
	}

	// A custom-input run has no expected output.
	out = g.Grade(ctx, prog("echo"), domain.CompareTokens, []Case{{Name: "Custom input", Stdin: "hi\n"}}, nil)
	if out.Verdict != domain.VerdictExecuted || out.Results[0].Stdout != "hi\n" || out.Results[0].ExpectedStdout != nil {
		t.Fatalf("custom run: %+v", out)
	}
}

func TestGradeFirstFailureInOrderWins(t *testing.T) {
	g := New(judgetest.New(), 4)
	// Case 2 is wrong, case 3 crashes: the overall verdict is the first
	// non-accepted in case order.
	fake := judgetest.New()
	fake.Handler = func(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		if req.Stdin == "c" {
			return judge.ExecResult{Status: judge.StatusRuntimeError}, nil
		}
		return judge.ExecResult{Status: judge.StatusOK, Stdout: req.Stdin}, nil
	}
	g.Engine = fake
	out := g.Grade(context.Background(), Program{Language: "python", Source: "x"}, domain.CompareTokens,
		cases("a", "a", "b", "x", "c", "c"), nil)
	if out.Verdict != domain.VerdictWrongAnswer {
		t.Fatalf("verdict %s", out.Verdict)
	}
}

func TestGradeEngineFailureIsInternalError(t *testing.T) {
	fake := judgetest.New()
	fake.Handler = func(context.Context, judge.ExecRequest) (judge.ExecResult, error) {
		return judge.ExecResult{}, errors.New("judge0: connection refused")
	}
	out := New(fake, 2).Grade(context.Background(), Program{Language: "python", Source: "x"}, domain.CompareTokens,
		cases("1", "1"), nil)
	if out.Verdict != domain.VerdictInternalError || out.Error == nil || *out.Error == "" {
		t.Fatalf("got %+v", out)
	}
}

func TestGradeReportsResultsAsTheyFinish(t *testing.T) {
	g := New(judgetest.New(), 2)
	var mu sync.Mutex
	seen := map[int]bool{}
	g.Grade(context.Background(), Program{Language: "python", Source: "echo"}, domain.CompareTokens,
		cases("1", "1", "2", "2", "3", "3", "4", "4"), func(i int, r domain.SubmissionResult) {
			mu.Lock()
			seen[i] = true
			mu.Unlock()
		})
	if len(seen) != 4 {
		t.Errorf("callbacks for %v", seen)
	}
}

func TestRunAllStopsAfterCompileError(t *testing.T) {
	fake := judgetest.New()
	g := New(fake, 2)
	execs := g.RunAll(context.Background(), Program{Language: "cpp", Source: "compile_error"}, []string{"1", "2", "3"}, nil)
	if fake.Calls() != 1 {
		t.Errorf("engine called %d times, want 1", fake.Calls())
	}
	for _, e := range execs {
		if !e.CompileFailed() {
			t.Error("every execution should report the compile error")
		}
	}
}

type batchFake struct {
	*judgetest.Engine
	batches int
}

func (b *batchFake) ExecuteBatch(ctx context.Context, reqs []judge.ExecRequest) ([]judge.ExecResult, error) {
	b.batches++
	out := make([]judge.ExecResult, len(reqs))
	for i, r := range reqs {
		out[i] = judgetest.Script(r)
	}
	return out, nil
}

func TestRunAllUsesBatchEngine(t *testing.T) {
	b := &batchFake{Engine: judgetest.New()}
	out := New(b, 2).Grade(context.Background(), Program{Language: "python", Source: "double"}, domain.CompareTokens,
		cases("1", "2", "2", "4", "3", "6"), nil)
	if out.Verdict != domain.VerdictAccepted {
		t.Fatalf("verdict %s", out.Verdict)
	}
	if b.batches != 1 || b.Calls() != 1 {
		t.Errorf("batches %d, single calls %d; want 1 and 1", b.batches, b.Calls())
	}
}

func TestGradeUnavailableCases(t *testing.T) {
	cs := cases("1 2", "3", "2 2", "4")
	cs[0].Unavailable = "the test case was deleted before it ran"
	var reported []int
	out := New(judgetest.New(), 2).Grade(context.Background(), Program{Language: "python", Source: "sum"}, domain.CompareTokens, cs,
		func(i int, r domain.SubmissionResult) { reported = append(reported, i) })
	if out.Verdict != domain.VerdictInternalError || out.Passed != 1 || out.Total != 2 || len(out.Results) != 2 || out.Error == nil {
		t.Fatalf("got %+v", out)
	}
	if out.Results[0].Verdict != domain.VerdictInternalError || out.Results[1].Verdict != domain.VerdictAccepted || len(reported) != 2 {
		t.Errorf("results: %+v, reported %v", out.Results, reported)
	}
	// With a compile error, no results at all.
	out = New(judgetest.New(), 2).Grade(context.Background(), Program{Language: "python", Source: "compile_error"}, domain.CompareTokens, cs, nil)
	if out.Verdict != domain.VerdictCompileError || len(out.Results) != 0 || out.Passed != 0 || out.TimeMs != nil {
		t.Errorf("compile error: %+v", out)
	}
}
