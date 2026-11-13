package app

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/harness"
	"codeatrophy/internal/judge"
)

// Every path that runs code for a problem — submissions, test-case
// verification, the verification step of test generation and the draft
// check — builds its program here, so that a function problem's source
// always runs inside its harness and its output is mapped back to the
// solver's lines the same way.

// harnessFor returns the harness a solution in lang runs in: nil for a
// program problem. For a function problem without an entry for lang it
// returns a validation error on field.
func harnessFor(p *domain.ProblemSpec, lang, field string) (*domain.HarnessCode, error) {
	h, ok := p.HarnessFor(lang)
	if ok {
		return h, nil
	}
	return nil, errField(field, noHarnessMessage(p, lang))
}

func noHarnessMessage(p *domain.ProblemSpec, lang string) string {
	langs := slices.Sorted(maps.Keys(p.Harness))
	msg := fmt.Sprintf("%s has no runner code (harness) on this solution-only problem", lang)
	if len(langs) == 0 {
		return msg + ", and no language has one yet"
	}
	return msg + "; it can be run in " + strings.Join(langs, ", ")
}

// runnable assembles the program that runs for source and checks that the
// judge engine accepts a program of its size; a program that is too large
// is a validation error on field.
func (a *App) runnable(ctx context.Context, p *domain.ProblemSpec, lang string, h *domain.HarnessCode, source,
	field string) (grader.Program, harness.Program, error) {
	asm := harness.Assemble(lang, h, source)
	if err := a.checkProgramSize(ctx, lang, len(asm.Text), h != nil, field); err != nil {
		return grader.Program{}, asm, err
	}
	return a.graderProgram(p, asm), asm, nil
}

// graderProgram is the grader's view of an assembled program, with its
// output mapped back to the solver's lines.
func (a *App) graderProgram(p *domain.ProblemSpec, asm harness.Program) grader.Program {
	prog := grader.Program{Language: asm.Language, Source: asm.Text, TimeLimitMs: p.TimeLimitMs, MemoryLimitKb: p.MemoryLimitKb}
	if asm.Harnessed() {
		var names []string
		if n, ok := a.engine.(judge.SourceNamer); ok {
			names = n.SourceNames(asm.Language)
		}
		prog.MapOutput = func(s string) string { return asm.Rewrite(s, names) }
	}
	return prog
}

// checkProgramSize rejects a program larger than the engine accepts in the
// language. An engine that cannot be asked is not a reason to refuse: the
// run then reports the engine's failure.
func (a *App) checkProgramSize(ctx context.Context, lang string, size int, harnessed bool, field string) error {
	lim, ok := a.engine.(judge.SourceLimiter)
	if !ok {
		return nil
	}
	limit, err := lim.MaxSourceBytes(ctx, lang)
	if err != nil || limit <= 0 || size <= limit {
		return nil
	}
	what := "the program"
	if harnessed {
		what = "the program that runs (the runner code with the solution)"
	}
	name := lang
	if l, ok := domain.LookupLanguage(lang); ok {
		name = l.Name
	}
	return errField(field, fmt.Sprintf("%s is %d bytes; the judge engine accepts %s programs of at most %d bytes",
		what, size, name, limit))
}

// toolchains lists the judge's languages and versions for the prompts,
// probing the engine first if it has not been asked yet.
func (a *App) toolchains(ctx context.Context) []ai.Toolchain {
	if a.engine != nil {
		a.judgeMu.Lock()
		never := a.judgeChecked.IsZero()
		a.judgeMu.Unlock()
		if never {
			a.probe(ctx)
		}
	}
	langs := a.JudgeStatus().Languages
	out := make([]ai.Toolchain, 0, len(langs))
	for _, l := range langs {
		v := l.Version
		if l.Name != "" {
			v = strings.TrimSpace(l.Name + " " + l.Version)
		}
		out = append(out, ai.Toolchain{Language: l.ID, Version: v})
	}
	return out
}
