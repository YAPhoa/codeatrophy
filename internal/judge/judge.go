// Package judge defines the interface to sandboxed code execution engines.
//
// An engine only executes a program with some stdin under limits and reports
// what happened. Choosing test cases, comparing output and assigning
// verdicts is the job of package grader.
package judge

import (
	"context"
	"errors"
)

// Language is a language an engine can execute, identified by the app's
// canonical id.
type Language struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

// ExecRequest asks an engine to compile (if needed) and run a program once.
type ExecRequest struct {
	Language      string // canonical language id
	Source        string
	Stdin         string
	TimeLimitMs   int
	MemoryLimitKb int
}

// Status is what happened to an execution.
type Status string

const (
	// StatusOK means the program ran to completion and exited with status 0.
	StatusOK Status = "ok"
	// StatusCompileError means the program did not compile.
	StatusCompileError Status = "compile_error"
	// StatusRuntimeError means the program crashed or exited non-zero.
	StatusRuntimeError Status = "runtime_error"
	// StatusTimeLimit means the program exceeded its time limit.
	StatusTimeLimit Status = "time_limit"
	// StatusMemoryLimit means the program exceeded its memory limit.
	StatusMemoryLimit Status = "memory_limit"
	// StatusInternalError means the engine failed to execute the program.
	StatusInternalError Status = "internal_error"
)

// ExecResult reports one execution. TimeMs and MemoryKb are nil when the
// engine does not know them.
type ExecResult struct {
	Status        Status
	Stdout        string
	Stderr        string
	CompileOutput string
	// Message is a short engine-provided explanation, e.g. a signal name.
	Message  string
	ExitCode *int
	TimeMs   *int
	MemoryKb *int
}

// Engine is a sandboxed runner.
type Engine interface {
	Name() string
	Health(ctx context.Context) error
	Languages(ctx context.Context) ([]Language, error)
	// Execute runs one program. A returned error means the engine could not
	// be reached or misbehaved; failures of the program itself are reported
	// through ExecResult.Status.
	Execute(ctx context.Context, req ExecRequest) (ExecResult, error)
}

// BatchEngine is an optional optimisation: engines that can execute several
// programs in one round trip implement it. Results are in request order.
type BatchEngine interface {
	Engine
	ExecuteBatch(ctx context.Context, reqs []ExecRequest) ([]ExecResult, error)
}

// ErrUnsupportedLanguage is returned by Execute for a language the engine
// does not offer.
var ErrUnsupportedLanguage = errors.New("language not supported by the judge engine")
