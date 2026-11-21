package app

import (
	"context"
	"fmt"
	"sync"

	"codeatrophy/internal/domain"
)

// A test case may be given a generator instead of its stdin: the server
// runs it, as it runs the generators a model writes for large test cases,
// and stores what it printed as the stdin, with the generator alongside.
// The generators of one request run before its write transaction, in
// parallel, and the request is atomic: if one fails nothing is stored.
// When a new case gives both, as a client saving a case the server built
// earlier does (a draft's or a test generation's large case), both are
// stored as given and nothing runs, as in a bundle import: the server does
// not check that the stdin came from the generator. Only PATCH refuses
// both together.

// needsRun reports whether a test case input is to get its stdin from its
// generator: it has one and no stdin.
func needsRun(in domain.TestCaseInput) bool { return in.Generator.HasValue() && !in.Stdin.Set }

// generatedInputs runs the generators of the inputs that have one but no
// stdin, and sets each one's stdin to what it printed. field names input
// i's generator in errors. A generator that fails, or prints an input that
// repeats an earlier case of the same request, is a validation error on
// its field; an engine that is missing or cannot run them is
// judge_unavailable. It reports which inputs were generated, for the
// caller to check against the cases already stored.
func (a *App) generatedInputs(ctx context.Context, inputs []domain.TestCaseInput, field func(i int) string) ([]bool, error) {
	generated := make([]bool, len(inputs))
	fe := domain.FieldErrors{}
	var todo []int
	for i, in := range inputs {
		if !needsRun(in) {
			continue
		}
		g := normalizedGenerator(in.Generator.Val)
		if msg := domain.ValidateGenerator(g, a.limits); msg != "" {
			fe.Add(field(i), msg)
			continue
		}
		generated[i] = true
		todo = append(todo, i)
	}
	if err := errValidation(fe); err != nil || len(todo) == 0 {
		return generated, err
	}
	if a.engine == nil {
		return nil, &Error{Code: CodeJudgeUnavailable, Message: "no judge engine is configured to run the generators"}
	}

	runs := make([]generatorRun, len(inputs))
	limit := make(chan struct{}, max(1, a.grader.Concurrency))
	var wg sync.WaitGroup
	for _, i := range todo {
		wg.Add(1)
		go func() {
			defer wg.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			runs[i] = a.runGenerator(ctx, normalizedGenerator(inputs[i].Generator.Val))
		}()
	}
	wg.Wait()

	for _, i := range todo {
		if r := runs[i]; r.skip {
			return nil, &Error{Code: CodeJudgeUnavailable, Message: "the generators could not run: " + r.err}
		}
	}
	for _, i := range todo {
		r := runs[i]
		if r.err != "" {
			fe.Add(field(i), r.err)
			continue
		}
		// A repeat of an earlier case of the request tests nothing new.
		for j := range i {
			var earlier string
			switch {
			case generated[j]:
				earlier = runs[j].input
			case inputs[j].Stdin.HasValue():
				earlier = inputs[j].Stdin.Val
			}
			if (generated[j] || inputs[j].Stdin.HasValue()) && sameInput(earlier) == sameInput(r.input) {
				fe.Add(field(i), "the generated input repeats "+requestCaseLabel(inputs[j], j))
				break
			}
		}
	}
	if err := errValidation(fe); err != nil {
		return nil, err
	}
	for _, i := range todo {
		inputs[i].Stdin = domain.Some(runs[i].input)
	}
	return generated, nil
}

func normalizedGenerator(g domain.GeneratorSpec) domain.GeneratorSpec {
	g.Source = domain.NormalizeText(g.Source)
	return g
}

// requestCaseLabel names case i of a request.
func requestCaseLabel(in domain.TestCaseInput, i int) string {
	if in.Name.HasValue() && oneLine(in.Name.Val) != "" {
		return fmt.Sprintf("%q", oneLine(in.Name.Val))
	}
	return fmt.Sprintf("case %d of the request", i+1)
}

// generatedRepeats checks the generated cases against the stored ones they
// are added to: a generated input that repeats one is a validation error on
// its field.
func generatedRepeats(stored []domain.TestCase, cases []domain.TestCase, generated []bool, field func(i int) string) error {
	fe := domain.FieldErrors{}
	for i, c := range cases {
		if i >= len(generated) || !generated[i] {
			continue
		}
		for j, s := range stored {
			if s.ID != c.ID && sameInput(s.Stdin) == sameInput(c.Stdin) {
				fe.Add(field(i), "the generated input repeats "+caseLabel(s.Name, j))
				break
			}
		}
	}
	return errValidation(fe)
}

// validateCase checks a test case as stored, its generator included.
func (a *App) validateCase(tc *domain.TestCase) domain.FieldErrors {
	fe := domain.ValidateTestCase(tc)
	if tc.Generator != nil {
		if msg := domain.ValidateGenerator(*tc.Generator, a.limits); msg != "" {
			fe.Add("generator", msg)
		}
	}
	return fe
}
