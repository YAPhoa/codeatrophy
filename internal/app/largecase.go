package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/judge"
)

// A large test case is built by a generator the model writes: a program
// that reads nothing and prints one test input near the problem's upper
// bounds. The server runs it, then runs the reference solution on what it
// printed for the expected output. A generation may ask for several, each
// from its own generator.

// Bounds of large test cases.
const (
	// MaxLargeInputBytes caps what a generator may print. Judge0 1.13
	// was checked end to end with inputs up to 8.5 MiB (generated, read
	// back and echoed); 1 MiB keeps prompts, bundles and the editor
	// comfortable while being large enough to separate O(n log n) from
	// O(n^2) at the usual bounds.
	MaxLargeInputBytes = 1 << 20
	// MaxLargeTestCases is the most large test cases one generation may
	// ask for, and DefaultLargeTestCases how many a client asks for unless
	// the user prefers otherwise.
	MaxLargeTestCases     = 5
	DefaultLargeTestCases = 3
	// A generator runs as a plain program with these limits: generous,
	// because it may build a worst case with some work, but bounded.
	generatorTimeLimitMs   = 10000
	generatorMemoryLimitKb = 512 << 10
	// promptDataBytes is the size above which test data is described by
	// its name and size, never shown, in a prompt (and so in the AI log).
	promptDataBytes = 4 << 10
)

// validateLargeCount checks the number of large test cases a request asks
// for, returning a validation message or "".
func validateLargeCount(n int) string {
	if n < 0 || n > MaxLargeTestCases {
		return fmt.Sprintf("must be between 0 and %d", MaxLargeTestCases)
	}
	return ""
}

// largeAsk is what a prompt asks for given n requested large cases.
func largeAsk(n int) ai.LargeCases {
	if n <= 0 {
		return ai.LargeCases{}
	}
	return ai.LargeCases{Count: n, MaxBytes: MaxLargeInputBytes}
}

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

// newLargeCaseReports starts one report per large case asked for, on the
// model's generators in order; those beyond n are ignored, and a case the
// model wrote no generator for has failed already.
func newLargeCaseReports(gens []*ai.ModelLargeCase, n int) []*LargeCaseReport {
	out := make([]*LargeCaseReport, n)
	for i := range out {
		r := &LargeCaseReport{}
		out[i] = r
		var gen *ai.ModelLargeCase
		if i < len(gens) {
			gen = gens[i]
		}
		switch {
		case gen != nil:
			r.Generator = &domain.Solution{Language: gen.Language, Source: domain.NormalizeText(gen.Source)}
			name := truncateRunes(oneLine(gen.Name), domain.MaxTestCaseNameChars)
			if name == "" {
				name = "Large input"
			}
			r.Name = &name
		case i < len(gens) || len(gens) == 0:
			r.fail("failed", "the model wrote no generator")
		default:
			r.fail("failed", "the model wrote only %d of the %d generators asked for", len(gens), n)
		}
	}
	return out
}

// failAll gives every report the same outcome, for a reason that applies to
// all of them.
func failAll(reports []*LargeCaseReport, status, msg string) []*LargeCaseReport {
	for _, r := range reports {
		r.fail(status, "%s", msg)
	}
	return reports
}

// largeCase is a built large test case.
type largeCase struct {
	Name, Rationale, Stdin, Expected string
}

// namedInput is a test input a large case must not repeat.
type namedInput struct{ name, stdin string }

// buildLargeCases builds the n large test cases asked for from the model's
// generators. It never fails the request: there is one report per case, in
// the model's order, and the built cases alongside, nil where the report
// does not say added. No case may repeat an existing input or an earlier
// large case.
//
// The cases are independent and run in parallel, each its generator and
// then the reference solution, so that n of them take about as long as
// one. A repeat of an earlier large case is therefore found once both have
// run.
func (a *App) buildLargeCases(ctx context.Context, spec *domain.ProblemSpec, gens []*ai.ModelLargeCase, n int,
	ref *domain.Solution, existing []namedInput) ([]*LargeCaseReport, []*largeCase) {
	reports := newLargeCaseReports(gens, n)
	built := make([]*largeCase, n)
	switch {
	case n == 0:
		return reports, built
	case a.engine == nil:
		return failAll(reports, "skipped", "no judge engine is configured"), built
	case ref == nil:
		return failAll(reports, "skipped", "there is no reference solution to compute the expected output"), built
	case ctx.Err() != nil:
		return failAll(reports, "skipped", "the check's time ran out"), built
	}
	h, ok := spec.HarnessFor(ref.Language)
	if !ok {
		return failAll(reports, "failed", "the reference solution cannot run: "+noHarnessMessage(spec, ref.Language)), built
	}
	prog, _, err := a.runnable(ctx, spec, ref.Language, h, ref.Source, "referenceSolution")
	if err != nil {
		return failAll(reports, "failed", "the reference solution cannot run: "+validationText(err)), built
	}

	inputs := make([]string, n)
	var wg sync.WaitGroup
	for i, r := range reports {
		if r.Generator == nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			inputs[i], built[i] = a.buildLargeCase(ctx, spec, gens[i], prog, r, existing)
		}()
	}
	wg.Wait()

	// A repeat of an earlier large case tests nothing new; it is reported
	// as if it had stopped there.
	seen := map[string]int{}
	for i, r := range reports {
		if inputs[i] == "" {
			continue
		}
		key := sameInput(inputs[i])
		if j, ok := seen[key]; ok {
			built[i], r.TimeMs = nil, nil
			r.fail("failed", "the generated input repeats large case %d", j+1)
			continue
		}
		seen[key] = i
	}
	return reports, built
}

// buildLargeCase runs one generator, then the reference solution prog on
// what it printed, recording every outcome in r. It returns the generated
// input once it is known to be usable and new to existing, and the case
// when r says added.
func (a *App) buildLargeCase(ctx context.Context, spec *domain.ProblemSpec, gen *ai.ModelLargeCase, prog grader.Program,
	r *LargeCaseReport, existing []namedInput) (string, *largeCase) {
	lc := &largeCase{Name: *r.Name, Rationale: strings.TrimSpace(gen.Rationale)}
	if fe := domain.ValidateSolution(*r.Generator, a.limits); len(fe) > 0 {
		r.fail("failed", "the generator is not usable: %s", fe.First())
		return "", nil
	}
	if err := a.requireLanguage(ctx, r.Generator.Language); err != nil {
		if AsError(err).Code == CodeJudgeUnavailable {
			r.fail("skipped", "%s", validationText(err))
		} else {
			r.fail("failed", "the generator is in a language the judge does not run: %s", validationText(err))
		}
		return "", nil
	}

	// 1. The generator, as a plain program.
	g := a.grader.RunAll(ctx, grader.Program{Language: r.Generator.Language, Source: r.Generator.Source,
		TimeLimitMs: generatorTimeLimitMs, MemoryLimitKb: generatorMemoryLimitKb}, []string{""}, nil)[0]
	if msg, skip := engineTrouble(ctx, g); msg != "" {
		r.fail(map[bool]string{true: "skipped", false: "failed"}[skip], "%s", msg)
		return "", nil
	}
	out := g.Result.Stdout
	msg := ""
	switch {
	case g.CompileFailed():
		msg = "the generator does not compile: " + domain.Truncate(strings.TrimSpace(g.Result.CompileOutput), 1000)
	case len(out) > MaxLargeInputBytes:
		msg = fmt.Sprintf("the generator printed more than %d bytes", MaxLargeInputBytes)
	case g.Result.Status != judge.StatusOK:
		msg = "the generator " + strings.TrimPrefix(describeFailure(grader.Verdict(spec.Compare, g, nil), g), "the reference solution ")
	case strings.TrimSpace(out) == "":
		msg = "the generator printed nothing"
	case !utf8.ValidString(out):
		msg = "the generator printed something that is not UTF-8"
	}
	if msg != "" {
		r.fail("failed", "%s", msg)
		return "", nil
	}
	n := len(out)
	r.InputBytes = &n
	for i, c := range existing {
		if sameInput(c.stdin) == sameInput(out) {
			r.fail("failed", "the generated input repeats %s", caseLabel(c.name, i))
			return "", nil
		}
	}

	// 2. The reference solution on it, under the problem's own limits.
	e := a.grader.RunAll(ctx, prog, []string{out}, nil)[0]
	if msg, skip := engineTrouble(ctx, e); msg != "" {
		r.fail(map[bool]string{true: "skipped", false: "failed"}[skip], "%s", msg)
		return out, nil
	}
	r.TimeMs = e.Result.TimeMs
	switch {
	case e.CompileFailed():
		msg = "the reference solution does not compile: " + domain.Truncate(strings.TrimSpace(e.Result.CompileOutput), 1000)
	case e.Result.Status == judge.StatusTimeLimit:
		msg = fmt.Sprintf("the reference solution exceeded the time limit of %d ms on the large input", spec.TimeLimitMs)
	case e.Result.Status == judge.StatusMemoryLimit:
		msg = fmt.Sprintf("the reference solution exceeded the memory limit of %d KB on the large input", spec.MemoryLimitKb)
	case e.Result.Status != judge.StatusOK:
		msg = "on the large input, " + describeFailure(grader.Verdict(spec.Compare, e, nil), e)
	case !utf8.ValidString(e.Result.Stdout) || len(e.Result.Stdout) > domain.MaxTestCaseBytes:
		msg = "the reference solution's output on the large input cannot be stored (not UTF-8 or too large)"
	}
	if msg != "" {
		r.fail("failed", "%s", msg)
		return out, nil
	}
	lc.Stdin, lc.Expected = out, e.Result.Stdout
	r.Status = "added"
	return out, lc
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
