package app

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/judge"
)

// A large test case is built by a generator the model writes: a program
// that reads nothing and prints one test input near the problem's upper
// bounds. The server runs it, then runs the reference solution on what it
// printed for the expected output.

// Bounds of large test cases.
const (
	// MaxLargeInputBytes caps what a generator may print. Judge0 1.13
	// was checked end to end with inputs up to 8.5 MiB (generated, read
	// back and echoed); 1 MiB keeps prompts, bundles and the editor
	// comfortable while being large enough to separate O(n log n) from
	// O(n^2) at the usual bounds.
	MaxLargeInputBytes = 1 << 20
	// A generator runs as a plain program with these limits: generous,
	// because it may build a worst case with some work, but bounded.
	generatorTimeLimitMs   = 10000
	generatorMemoryLimitKb = 512 << 10
	// promptDataBytes is the size above which test data is described by
	// its name and size, never shown, in a prompt (and so in the AI log).
	promptDataBytes = 4 << 10
)

// LargeCaseReport says what became of a requested large test case.
type LargeCaseReport struct {
	Status     string           `json:"status"` // added, failed or skipped
	Error      *string          `json:"error"`
	Index      *int             `json:"index"`
	Name       *string          `json:"name"`
	InputBytes *int             `json:"inputBytes"`
	TimeMs     *int             `json:"timeMs"`
	Generator  *domain.Solution `json:"generator"`
}

func (r *LargeCaseReport) fail(status, format string, args ...any) *LargeCaseReport {
	msg := fmt.Sprintf(format, args...)
	r.Status, r.Error = status, &msg
	return r
}

// newLargeCaseReport starts a report on the model's generator.
func newLargeCaseReport(gen *ai.ModelLargeCase) *LargeCaseReport {
	r := &LargeCaseReport{}
	if gen != nil {
		r.Generator = &domain.Solution{Language: gen.Language, Source: domain.NormalizeText(gen.Source)}
		name := truncateRunes(oneLine(gen.Name), domain.MaxTestCaseNameChars)
		if name == "" {
			name = "Large input"
		}
		r.Name = &name
	}
	return r
}

// largeCase is a built large test case.
type largeCase struct {
	Name, Rationale, Stdin, Expected string
}

// namedInput is a test input a large case must not repeat.
type namedInput struct{ name, stdin string }

// buildLargeCase runs the generator and the reference solution. It never
// fails the request: every outcome is in the report, and the case is
// returned only when the report says added.
func (a *App) buildLargeCase(ctx context.Context, spec *domain.ProblemSpec, gen *ai.ModelLargeCase, ref *domain.Solution,
	existing []namedInput) (*LargeCaseReport, *largeCase) {
	r := newLargeCaseReport(gen)
	lc := &largeCase{Name: "Large input"}
	if r.Name != nil {
		lc.Name, lc.Rationale = *r.Name, strings.TrimSpace(gen.Rationale)
	}
	switch {
	case a.engine == nil:
		return r.fail("skipped", "no judge engine is configured"), nil
	case ref == nil:
		return r.fail("skipped", "there is no reference solution to compute the expected output"), nil
	case r.Generator == nil:
		return r.fail("failed", "the model wrote no generator"), nil
	case len(domain.ValidateSolution(*r.Generator, a.limits)) > 0:
		return r.fail("failed", "the generator is not usable: %s", domain.ValidateSolution(*r.Generator, a.limits).First()), nil
	}
	if ctx.Err() != nil {
		return r.fail("skipped", "the check's time ran out"), nil
	}
	if err := a.requireLanguage(ctx, r.Generator.Language); err != nil {
		if AsError(err).Code == CodeJudgeUnavailable {
			return r.fail("skipped", "%s", validationText(err)), nil
		}
		return r.fail("failed", "the generator is in a language the judge does not run: %s", validationText(err)), nil
	}

	// 1. The generator, as a plain program.
	g := a.grader.RunAll(ctx, grader.Program{Language: r.Generator.Language, Source: r.Generator.Source,
		TimeLimitMs: generatorTimeLimitMs, MemoryLimitKb: generatorMemoryLimitKb}, []string{""}, nil)[0]
	if msg, skip := engineTrouble(ctx, g); msg != "" {
		return r.fail(map[bool]string{true: "skipped", false: "failed"}[skip], "%s", msg), nil
	}
	out := g.Result.Stdout
	switch {
	case g.CompileFailed():
		return r.fail("failed", "the generator does not compile: %s", domain.Truncate(strings.TrimSpace(g.Result.CompileOutput), 1000)), nil
	case len(out) > MaxLargeInputBytes:
		return r.fail("failed", "the generator printed more than %d bytes", MaxLargeInputBytes), nil
	case g.Result.Status != judge.StatusOK:
		return r.fail("failed", "the generator %s", strings.TrimPrefix(describeFailure(grader.Verdict(spec.Compare, g, nil), g),
			"the reference solution ")), nil
	case strings.TrimSpace(out) == "":
		return r.fail("failed", "the generator printed nothing"), nil
	case !utf8.ValidString(out):
		return r.fail("failed", "the generator printed something that is not UTF-8"), nil
	}
	n := len(out)
	r.InputBytes = &n
	for i, c := range existing {
		if sameInput(c.stdin) == sameInput(out) {
			return r.fail("failed", "the generated input repeats %s", caseLabel(c.name, i)), nil
		}
	}

	// 2. The reference solution on it, under the problem's own limits.
	h, ok := spec.HarnessFor(ref.Language)
	if !ok {
		return r.fail("failed", "the reference solution cannot run: %s", noHarnessMessage(spec, ref.Language)), nil
	}
	prog, _, err := a.runnable(ctx, spec, ref.Language, h, ref.Source, "referenceSolution")
	if err != nil {
		return r.fail("failed", "the reference solution cannot run: %s", validationText(err)), nil
	}
	e := a.grader.RunAll(ctx, prog, []string{out}, nil)[0]
	if msg, skip := engineTrouble(ctx, e); msg != "" {
		return r.fail(map[bool]string{true: "skipped", false: "failed"}[skip], "%s", msg), nil
	}
	r.TimeMs = e.Result.TimeMs
	switch {
	case e.CompileFailed():
		return r.fail("failed", "the reference solution does not compile: %s",
			domain.Truncate(strings.TrimSpace(e.Result.CompileOutput), 1000)), nil
	case e.Result.Status == judge.StatusTimeLimit:
		return r.fail("failed", "the reference solution exceeded the time limit of %d ms on the large input", spec.TimeLimitMs), nil
	case e.Result.Status == judge.StatusMemoryLimit:
		return r.fail("failed", "the reference solution exceeded the memory limit of %d KB on the large input", spec.MemoryLimitKb), nil
	case e.Result.Status != judge.StatusOK:
		return r.fail("failed", "on the large input, %s", describeFailure(grader.Verdict(spec.Compare, e, nil), e)), nil
	case !utf8.ValidString(e.Result.Stdout) || len(e.Result.Stdout) > domain.MaxTestCaseBytes:
		return r.fail("failed", "the reference solution's output on the large input cannot be stored (not UTF-8 or too large)"), nil
	}
	lc.Stdin, lc.Expected = out, e.Result.Stdout
	r.Status = "added"
	return r, lc
}

// engineTrouble describes an execution that says nothing about the program:
// the engine failed (skip: true when it could not be reached or the time
// ran out).
func engineTrouble(ctx context.Context, e grader.Execution) (string, bool) {
	switch {
	case e.Err != nil && ctx.Err() != nil:
		return "the check's time ran out", true
	case e.Err != nil:
		return "the judge engine could not run it: " + grader.ErrorMessage(e), true
	case e.Result.Status == judge.StatusInternalError:
		return "the judge engine failed: " + grader.ErrorMessage(e), true
	}
	return "", false
}

// Prompts never carry large test data: a case larger than promptDataBytes
// is described by its name and size.

func isLargeData(stdin, expected string) bool {
	return len(stdin) > promptDataBytes || len(expected) > promptDataBytes
}

// elidePreviousDraft takes the large test cases out of a previous draft's
// testCases and lists them by name and size under ai.OmittedCasesKey.
func elidePreviousDraft(obj map[string]any) {
	cases, ok := obj["testCases"].([]any)
	if !ok {
		return
	}
	kept := []any{}
	var omitted []any
	for _, c := range cases {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		in, _ := m["stdin"].(string)
		exp, _ := m["expectedStdout"].(string)
		if !isLargeData(in, exp) {
			kept = append(kept, c)
			continue
		}
		name, _ := m["name"].(string)
		omitted = append(omitted, map[string]any{"name": truncateRunes(oneLine(name), domain.MaxTestCaseNameChars),
			"inputBytes": len(in), "expectedOutputBytes": len(exp)})
	}
	obj["testCases"] = kept
	if len(omitted) > 0 {
		obj[ai.OmittedCasesKey] = omitted
	}
}

// largeCaseInfo is how a prompt mentions a test case too large to show.
func largeCaseInfo(stdin, expected string) string {
	return fmt.Sprintf("(input of %d bytes and expected output of %d bytes, too large to show)", len(stdin), len(expected))
}
