// Package grader runs programs against test cases through a judge engine,
// compares their output and assigns verdicts. All judging rules live here so
// that behaviour is identical across engines.
package grader

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/judge"
)

// DefaultConcurrency is the number of executions run in parallel for one
// program when no other value is configured.
const DefaultConcurrency = 4

// Match reports whether actual equals expected under the compare mode.
func Match(mode domain.CompareMode, expected, actual string) bool {
	if mode == domain.CompareExact {
		return normalizeExact(expected) == normalizeExact(actual)
	}
	return tokensEqual(expected, actual)
}

func tokensEqual(a, b string) bool {
	fa, fb := strings.Fields(a), strings.Fields(b)
	if len(fa) != len(fb) {
		return false
	}
	for i := range fa {
		if fa[i] != fb[i] {
			return false
		}
	}
	return true
}

// normalizeExact strips trailing whitespace on each line and trailing blank
// lines.
func normalizeExact(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t\r\v\f")
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}

// Program is code to execute under limits.
type Program struct {
	Language      string
	Source        string
	TimeLimitMs   int
	MemoryLimitKb int
	// MapOutput, if set, rewrites the compile output and stderr of every
	// execution before anything else sees them (to map line numbers of an
	// assembled program back to the solver's code).
	MapOutput func(string) string
}

func (p Program) mapOutput(e Execution) Execution {
	if p.MapOutput != nil && e.Err == nil {
		e.Result.Stderr = p.MapOutput(e.Result.Stderr)
		e.Result.CompileOutput = p.MapOutput(e.Result.CompileOutput)
	}
	return e
}

// Grader executes programs through an engine.
type Grader struct {
	Engine      judge.Engine
	Concurrency int
}

// New returns a grader for the engine.
func New(engine judge.Engine, concurrency int) *Grader {
	if concurrency <= 0 {
		concurrency = DefaultConcurrency
	}
	return &Grader{Engine: engine, Concurrency: concurrency}
}

// Execution is the result of running a program on one input. Err is set when
// the engine itself failed.
type Execution struct {
	Result judge.ExecResult
	Err    error
}

// CompileFailed reports whether the execution failed to compile.
func (e Execution) CompileFailed() bool {
	return e.Err == nil && e.Result.Status == judge.StatusCompileError
}

// EngineFailed reports whether the engine itself failed on the execution:
// it could not be reached, or it reported an internal error (Judge0's
// status 13). Either way the execution says nothing about the program.
func (e Execution) EngineFailed() bool {
	return e.Err != nil || e.Result.Status == judge.StatusInternalError
}

// RunAll executes the program once per input. The first input runs alone so
// that a compile error is detected once; in that case every execution
// reports the compile error and the remaining inputs are not run. After the
// first engine failure (unreachable, timed out) no further executions are
// started: the inputs not yet run report judge.ErrNotRun. Results already
// finished are always kept. onDone, if non-nil, is called (sequentially) as
// each execution finishes.
func (g *Grader) RunAll(ctx context.Context, p Program, stdins []string, onDone func(i int, e Execution)) []Execution {
	out := make([]Execution, len(stdins))
	if len(stdins) == 0 {
		return out
	}
	var mu sync.Mutex
	var failed atomic.Bool
	done := func(i int, e Execution) {
		e = p.mapOutput(e)
		if e.Err != nil && !errors.Is(e.Err, judge.ErrNotRun) {
			failed.Store(true)
		}
		mu.Lock()
		defer mu.Unlock()
		out[i] = e
		if onDone != nil {
			onDone(i, e)
		}
	}
	notRun := func(i int) { done(i, Execution{Err: judge.ErrNotRun}) }

	first := g.exec(ctx, p, stdins[0])
	if first.CompileFailed() {
		first = p.mapOutput(first)
		for i := range stdins {
			out[i] = first
		}
		if onDone != nil {
			onDone(0, first)
		}
		return out
	}
	done(0, first)
	rest := stdins[1:]
	if len(rest) == 0 {
		return out
	}
	if failed.Load() {
		for i := range rest {
			notRun(i + 1)
		}
		return out
	}
	if be, ok := g.Engine.(judge.BatchEngine); ok {
		reqs := make([]judge.ExecRequest, len(rest))
		for i, in := range rest {
			reqs[i] = request(p, in)
		}
		err := be.ExecuteBatch(ctx, reqs, func() bool { return !failed.Load() && ctx.Err() == nil },
			func(i int, r judge.ExecResult, err error) { done(i+1, Execution{Result: r, Err: err}) })
		if err == nil {
			return out
		}
		// The batch could not be started; fall back to single executions.
	}
	sem := make(chan struct{}, max(1, g.Concurrency))
	var wg sync.WaitGroup
	for i, in := range rest {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				done(i+1, Execution{Err: ctx.Err()})
				return
			}
			defer func() { <-sem }()
			if failed.Load() {
				notRun(i + 1)
				return
			}
			done(i+1, g.exec(ctx, p, in))
		}()
	}
	wg.Wait()
	return out
}

func request(p Program, stdin string) judge.ExecRequest {
	return judge.ExecRequest{
		Language: p.Language, Source: p.Source, Stdin: stdin,
		TimeLimitMs: p.TimeLimitMs, MemoryLimitKb: p.MemoryLimitKb,
	}
}

func (g *Grader) exec(ctx context.Context, p Program, stdin string) Execution {
	if err := ctx.Err(); err != nil {
		return Execution{Err: err}
	}
	r, err := g.Engine.Execute(ctx, request(p, stdin))
	return Execution{Result: r, Err: err}
}

// Case is one test to grade.
type Case struct {
	TestCaseID *string
	Name       string
	IsSample   bool
	Stdin      string
	// Expected is nil for a custom-input run.
	Expected *string
	// Unavailable, when non-empty, means the case cannot be run (for
	// example, it was deleted after the submission was created). It is
	// reported as an internal error with this message and not executed.
	Unavailable string
}

// Outcome is the graded result of a whole submission.
type Outcome struct {
	Verdict       domain.Verdict
	Passed        int
	Total         int
	TimeMs        *int
	MemoryKb      *int
	CompileOutput string
	Error         *string
	Results       []domain.SubmissionResult // in case order
}

// Verdict maps an execution to a case verdict.
func Verdict(mode domain.CompareMode, e Execution, expected *string) domain.Verdict {
	if e.Err != nil {
		return domain.VerdictInternalError
	}
	switch e.Result.Status {
	case judge.StatusOK:
		if expected == nil {
			return domain.VerdictExecuted
		}
		if Match(mode, *expected, e.Result.Stdout) {
			return domain.VerdictAccepted
		}
		return domain.VerdictWrongAnswer
	case judge.StatusCompileError:
		return domain.VerdictCompileError
	case judge.StatusRuntimeError:
		return domain.VerdictRuntimeError
	case judge.StatusTimeLimit:
		return domain.VerdictTimeLimitExceeded
	case judge.StatusMemoryLimit:
		return domain.VerdictMemoryLimitExceeded
	default:
		return domain.VerdictInternalError
	}
}

// ErrorMessage describes why an execution could not be judged, for
// internal errors.
func ErrorMessage(e Execution) string {
	switch {
	case e.Err != nil:
		if errors.Is(e.Err, judge.ErrNotRun) {
			return e.Err.Error()
		}
		if errors.Is(e.Err, context.Canceled) || errors.Is(e.Err, context.DeadlineExceeded) {
			return "the execution was cancelled or timed out"
		}
		return e.Err.Error()
	case e.Result.Status == judge.StatusInternalError:
		if e.Result.Message != "" {
			return "judge engine error: " + e.Result.Message
		}
		return "judge engine error"
	}
	return ""
}

// Grade runs the program against every case. onResult, if non-nil, is called
// (sequentially) with each case's result as it finishes.
func (g *Grader) Grade(ctx context.Context, p Program, mode domain.CompareMode, cases []Case,
	onResult func(i int, r domain.SubmissionResult)) Outcome {
	out := Outcome{Total: len(cases)}
	if len(cases) == 0 {
		v := domain.VerdictInternalError
		msg := "no test cases to run"
		out.Verdict, out.Error = v, &msg
		return out
	}
	// Cases that cannot run get their result up front; the rest execute.
	results := make([]*domain.SubmissionResult, len(cases))
	var runnable []int
	var firstErr string
	for i, c := range cases {
		if c.Unavailable == "" {
			runnable = append(runnable, i)
			continue
		}
		r := domain.SubmissionResult{TestCaseID: c.TestCaseID, Name: c.Name, IsSample: c.IsSample,
			Verdict: domain.VerdictInternalError, Stdin: domain.Truncate(c.Stdin, domain.MaxResultTextBytes), Stderr: c.Unavailable}
		if c.Expected != nil {
			exp := domain.Truncate(*c.Expected, domain.MaxResultTextBytes)
			r.ExpectedStdout = &exp
		}
		results[i] = &r
		if firstErr == "" {
			firstErr = c.Unavailable
		}
	}
	stdins := make([]string, len(runnable))
	for j, i := range runnable {
		stdins[j] = cases[i].Stdin
	}
	var compileOutput string
	caseCompileOutput := make([]string, len(cases))
	execs := g.RunAll(ctx, p, stdins, func(j int, e Execution) {
		// A compile error on the first case fails the whole run (RunAll
		// reports it once, below). A later case can still report one, for
		// example when the compiler times out under load; that is recorded
		// as the case's own result so the run cannot pass without it.
		if j == 0 && e.CompileFailed() {
			return
		}
		i := runnable[j]
		if e.CompileFailed() {
			caseCompileOutput[i] = e.Result.CompileOutput
		} else if compileOutput == "" && e.Result.CompileOutput != "" {
			compileOutput = e.Result.CompileOutput
		}
		r := caseResult(mode, cases[i], e)
		if r.Verdict == domain.VerdictInternalError && firstErr == "" && !errors.Is(e.Err, judge.ErrNotRun) {
			firstErr = ErrorMessage(e)
		}
		results[i] = &r
		if onResult != nil {
			onResult(i, r)
		}
	})
	if len(execs) == 0 {
		execs = []Execution{{}}
	}
	if len(runnable) > 0 && execs[0].CompileFailed() {
		out.Verdict = domain.VerdictCompileError
		out.CompileOutput = execs[0].Result.CompileOutput
		if out.CompileOutput == "" {
			out.CompileOutput = "Compilation failed."
		}
		out.Results = []domain.SubmissionResult{}
		return out
	}
	if onResult != nil {
		for i, c := range cases {
			if c.Unavailable != "" {
				onResult(i, *results[i])
			}
		}
	}
	out.CompileOutput = compileOutput
	out.Verdict = domain.VerdictAccepted
	if cases[0].Expected == nil && len(cases) == 1 {
		out.Verdict = domain.VerdictExecuted
	}
	decided := false
	for i, r := range results {
		if r == nil {
			continue
		}
		out.Results = append(out.Results, *r)
		if r.Verdict == domain.VerdictAccepted || r.Verdict == domain.VerdictExecuted {
			out.Passed++
		} else if !decided {
			out.Verdict, decided = r.Verdict, true
			if r.Verdict == domain.VerdictCompileError {
				out.CompileOutput = caseCompileOutput[i]
				if out.CompileOutput == "" {
					out.CompileOutput = "Compilation failed."
				}
			}
		}
		out.TimeMs = maxPtr(out.TimeMs, r.TimeMs)
		out.MemoryKb = maxPtr(out.MemoryKb, r.MemoryKb)
	}
	if out.Verdict == domain.VerdictInternalError {
		if firstErr == "" {
			firstErr = "the judge engine failed to execute the program"
		}
		out.Error = &firstErr
	}
	return out
}

func caseResult(mode domain.CompareMode, c Case, e Execution) domain.SubmissionResult {
	r := domain.SubmissionResult{
		TestCaseID: c.TestCaseID,
		Name:       c.Name,
		IsSample:   c.IsSample,
		Verdict:    Verdict(mode, e, c.Expected),
		Stdin:      domain.Truncate(c.Stdin, domain.MaxResultTextBytes),
		Stdout:     domain.Truncate(e.Result.Stdout, domain.MaxResultTextBytes),
		Stderr:     domain.Truncate(e.Result.Stderr, domain.MaxResultTextBytes),
		TimeMs:     e.Result.TimeMs,
		MemoryKb:   e.Result.MemoryKb,
	}
	if c.Expected != nil {
		exp := domain.Truncate(*c.Expected, domain.MaxResultTextBytes)
		r.ExpectedStdout = &exp
	}
	if r.Verdict == domain.VerdictInternalError && r.Stderr == "" {
		r.Stderr = ErrorMessage(e)
	}
	if r.Verdict == domain.VerdictCompileError && r.Stderr == "" {
		r.Stderr = domain.Truncate(e.Result.CompileOutput, domain.MaxResultTextBytes)
	}
	if r.Verdict == domain.VerdictRuntimeError && r.Stderr == "" && e.Result.Message != "" {
		r.Stderr = e.Result.Message
	}
	return r
}

func maxPtr(a, b *int) *int {
	if b == nil {
		return a
	}
	if a == nil || *b > *a {
		v := *b
		return &v
	}
	return a
}
