// Package judgetest provides a fake judge engine for tests.
package judgetest

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"codeatrophy/internal/judge"
)

// Engine is a scriptable in-memory judge.Engine.
//
// By default it interprets the source code as a tiny program (see Script),
// which lets tests express behaviour without a real sandbox.
type Engine struct {
	Langs []judge.Language
	// Handler overrides the default Script interpretation when set.
	Handler func(ctx context.Context, req judge.ExecRequest) (judge.ExecResult, error)

	mu        sync.Mutex
	healthErr error
	requests  []judge.ExecRequest
	calls     atomic.Int64
}

var _ judge.Engine = (*Engine)(nil)

// New returns a fake engine offering the given languages (python and cpp by
// default).
func New(langs ...string) *Engine {
	if len(langs) == 0 {
		langs = []string{"python", "cpp"}
	}
	e := &Engine{}
	for _, l := range langs {
		e.Langs = append(e.Langs, judge.Language{ID: l, Name: l, Version: "fake"})
	}
	return e
}

// SetHealth makes Health and Languages return err.
func (e *Engine) SetHealth(err error) {
	e.mu.Lock()
	e.healthErr = err
	e.mu.Unlock()
}

// Calls returns the number of Execute calls so far.
func (e *Engine) Calls() int { return int(e.calls.Load()) }

// Requests returns a copy of all requests received.
func (e *Engine) Requests() []judge.ExecRequest {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]judge.ExecRequest(nil), e.requests...)
}

// Name implements judge.Engine.
func (e *Engine) Name() string { return "fake" }

// Health implements judge.Engine.
func (e *Engine) Health(context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.healthErr
}

// Languages implements judge.Engine.
func (e *Engine) Languages(ctx context.Context) ([]judge.Language, error) {
	if err := e.Health(ctx); err != nil {
		return nil, err
	}
	return append([]judge.Language(nil), e.Langs...), nil
}

// Execute implements judge.Engine.
func (e *Engine) Execute(ctx context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
	e.calls.Add(1)
	e.mu.Lock()
	e.requests = append(e.requests, req)
	healthErr := e.healthErr
	e.mu.Unlock()
	if healthErr != nil {
		return judge.ExecResult{}, healthErr
	}
	supported := false
	for _, l := range e.Langs {
		if l.ID == req.Language {
			supported = true
		}
	}
	if !supported {
		return judge.ExecResult{}, judge.ErrUnsupportedLanguage
	}
	if e.Handler != nil {
		return e.Handler(ctx, req)
	}
	return Script(req), nil
}

// Script interprets req.Source as a fake program. The first line selects the
// behaviour:
//
//	echo           print stdin unchanged
//	sum            print the sum of all integers in stdin
//	double         print each integer in stdin times two, one per line
//	compile_error  fail to compile
//	crash          exit with status 1, printing "boom" to stderr
//	timeout        exceed the time limit
//	oom            exceed the memory limit
//	print <text>   print the rest of the line followed by a newline
//
// Anything else prints the source itself.
func Script(req judge.ExecRequest) judge.ExecResult {
	first, _, _ := strings.Cut(req.Source, "\n")
	first = strings.TrimSpace(first)
	ms, kb, zero, one := 5, 1024, 0, 1
	ok := func(out string) judge.ExecResult {
		return judge.ExecResult{Status: judge.StatusOK, Stdout: out, ExitCode: &zero, TimeMs: &ms, MemoryKb: &kb}
	}
	switch {
	case first == "echo":
		return ok(req.Stdin)
	case first == "sum":
		total := 0
		for _, f := range strings.Fields(req.Stdin) {
			n, _ := strconv.Atoi(f)
			total += n
		}
		return ok(strconv.Itoa(total) + "\n")
	case first == "double":
		var b strings.Builder
		for _, f := range strings.Fields(req.Stdin) {
			n, _ := strconv.Atoi(f)
			b.WriteString(strconv.Itoa(2*n) + "\n")
		}
		return ok(b.String())
	case first == "compile_error":
		return judge.ExecResult{Status: judge.StatusCompileError, CompileOutput: "main.cpp:1: error: expected ';'"}
	case first == "crash":
		return judge.ExecResult{Status: judge.StatusRuntimeError, Stderr: "boom\n", ExitCode: &one, Message: "Exited with error status 1", TimeMs: &ms, MemoryKb: &kb}
	case first == "timeout":
		t := req.TimeLimitMs
		return judge.ExecResult{Status: judge.StatusTimeLimit, TimeMs: &t, MemoryKb: &kb, Message: "Time limit exceeded"}
	case first == "oom":
		m := req.MemoryLimitKb
		return judge.ExecResult{Status: judge.StatusMemoryLimit, TimeMs: &ms, MemoryKb: &m}
	case strings.HasPrefix(first, "print "):
		return ok(strings.TrimPrefix(first, "print ") + "\n")
	default:
		return ok(req.Source)
	}
}
