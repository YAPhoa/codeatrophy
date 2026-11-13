package app

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/harness"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/store"
)

// JudgeStatus describes the judge engine for clients.
type JudgeStatus struct {
	Enabled   bool             `json:"enabled"`
	Engine    string           `json:"engine"`
	Healthy   bool             `json:"healthy"`
	Languages []judge.Language `json:"languages"`
}

// JudgeStatus returns the cached engine status.
func (a *App) JudgeStatus() JudgeStatus {
	if a.engine == nil {
		return JudgeStatus{Engine: "none", Languages: []judge.Language{}}
	}
	a.judgeMu.Lock()
	defer a.judgeMu.Unlock()
	langs := append([]judge.Language{}, a.judgeLangs...)
	return JudgeStatus{Enabled: true, Engine: a.engine.Name(), Healthy: a.judgeHealthy, Languages: langs}
}

func (a *App) probe(ctx context.Context) (bool, []judge.Language) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	healthy := a.engine.Health(ctx) == nil
	var langs []judge.Language
	if healthy {
		var err error
		langs, err = a.engine.Languages(ctx)
		if err != nil {
			healthy = false
		}
	}
	a.judgeMu.Lock()
	wasHealthy := a.judgeHealthy
	a.judgeHealthy = healthy
	if healthy {
		a.judgeLangs = langs
	}
	a.judgeChecked = time.Now()
	langs = append([]judge.Language{}, a.judgeLangs...)
	a.judgeMu.Unlock()
	if healthy != wasHealthy {
		a.log.Info("judge engine health changed", "engine", a.engine.Name(), "healthy", healthy)
	}
	return healthy, langs
}

// RefreshJudgeStatus probes the engine now instead of waiting for the next
// periodic probe.
func (a *App) RefreshJudgeStatus(ctx context.Context) JudgeStatus {
	if a.engine != nil {
		a.probe(ctx)
	}
	return a.JudgeStatus()
}

func (a *App) healthLoop() {
	defer a.wg.Done()
	a.probe(a.ctx)
	t := time.NewTicker(a.healthInterval)
	defer t.Stop()
	for {
		select {
		case <-a.stop:
			return
		case <-t.C:
			a.probe(a.ctx)
		}
	}
}

// requireLanguage checks that a judge engine is available and offers the
// language. A stale or unhealthy cache is refreshed first.
func (a *App) requireLanguage(ctx context.Context, lang string) error {
	if a.engine == nil {
		return &Error{Code: CodeJudgeUnavailable, Message: "no judge engine is configured"}
	}
	a.judgeMu.Lock()
	healthy, langs, checked := a.judgeHealthy, a.judgeLangs, a.judgeChecked
	a.judgeMu.Unlock()
	if !healthy || time.Since(checked) > 5*time.Minute || !hasLanguage(langs, lang) {
		healthy, langs = a.probe(ctx)
	}
	if !healthy {
		return &Error{Code: CodeJudgeUnavailable, Message: "the judge engine is unreachable"}
	}
	if !hasLanguage(langs, lang) {
		return errField("language", fmt.Sprintf("language %q is not offered by the judge engine", lang))
	}
	return nil
}

func sameHarness(a, b *domain.HarnessCode) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func hasLanguage(langs []judge.Language, id string) bool {
	return slices.ContainsFunc(langs, func(l judge.Language) bool { return l.ID == id })
}

// SubmissionInput is the body of a submission request.
type SubmissionInput struct {
	Language string             `json:"language"`
	Source   string             `json:"source"`
	Mode     string             `json:"mode"`
	Stdin    domain.Opt[string] `json:"stdin"`
}

// CreateSubmission validates and queues a submission.
func (a *App) CreateSubmission(ctx context.Context, itemID string, in SubmissionInput) (domain.Submission, error) {
	mode := domain.SubmissionMode(in.Mode)
	if in.Mode == "" {
		mode = domain.ModeRun
	}
	fe := domain.FieldErrors{}
	if !mode.Valid() {
		fe.Add("mode", "must be run or submit")
	}
	if !domain.KnownLanguage(in.Language) {
		fe.Add("language", "unknown language")
	}
	if strings.TrimSpace(in.Source) == "" {
		fe.Add("source", "is required")
	} else if len(in.Source) > a.limits.MaxSourceBytes {
		fe.Add("source", fmt.Sprintf("must be at most %d bytes", a.limits.MaxSourceBytes))
	}
	if mode == domain.ModeSubmit && in.Stdin.HasValue() {
		fe.Add("stdin", "must be null in submit mode")
	}
	if in.Stdin.HasValue() && len(in.Stdin.Val) > domain.MaxTestCaseBytes {
		fe.Add("stdin", "is too large")
	}
	var it domain.Item
	var cases []domain.TestCase
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		it, err = tx.GetItem(itemID)
		if err != nil {
			return notFoundAs(err, "item")
		}
		if it.Type != domain.TypeProblem {
			return errField("type", "readings cannot be run")
		}
		cases, err = tx.ListTestCases(itemID)
		return err
	})
	if err != nil {
		return domain.Submission{}, err
	}
	h, ok := it.Problem.HarnessFor(in.Language)
	if !ok {
		fe.Add("language", noHarnessMessage(it.Problem, in.Language))
	}
	if err := errValidation(fe); err != nil {
		return domain.Submission{}, err
	}
	total := 1
	var caseIDs []string
	if !in.Stdin.HasValue() {
		for _, c := range selectCases(cases, mode) {
			caseIDs = append(caseIDs, c.ID)
		}
		total = len(caseIDs)
		if total == 0 {
			if mode == domain.ModeRun {
				return domain.Submission{}, errField("testCases", "the problem has no sample test cases to run")
			}
			return domain.Submission{}, errField("testCases", "the problem has no test cases to run")
		}
	}
	if a.engine == nil {
		return domain.Submission{}, &Error{Code: CodeJudgeUnavailable, Message: "no judge engine is configured"}
	}
	// An unreachable engine does not reject the submission: it completes as
	// an internal error. A reachable engine must offer the language.
	if err := a.requireLanguage(ctx, in.Language); err != nil && AsError(err).Code != CodeJudgeUnavailable {
		return domain.Submission{}, err
	}
	// What is stored is what was submitted, with the harness it runs in;
	// what runs is the two assembled.
	_, asm, err := a.runnable(ctx, it.Problem, in.Language, h, in.Source, "source")
	if err != nil {
		return domain.Submission{}, err
	}
	sub := domain.Submission{
		ID: newID(), ItemID: itemID, Mode: mode, Language: in.Language, Source: in.Source,
		LineOffset: asm.LineOffset, Harness: h,
		Status: domain.SubmissionQueued, TotalCount: total, Stdin: in.Stdin.Ptr(), CaseIDs: caseIDs,
		CreatedAt: a.clock(), Results: []domain.SubmissionResult{},
	}
	err = a.store.Write(ctx, func(tx store.Tx) error {
		cur, err := tx.GetItem(itemID)
		if err != nil {
			return notFoundAs(err, "item")
		}
		if err := tx.InsertSubmission(&sub); err != nil {
			return err
		}
		if cur.Status == domain.StatusTodo {
			next := cur.Clone()
			next.Status = domain.StatusInProgress
			return a.saveItem(tx, &cur, &next)
		}
		return nil
	})
	if err != nil {
		return domain.Submission{}, err
	}
	a.enqueue(sub.ID)
	return sub, nil
}

func selectCases(cases []domain.TestCase, mode domain.SubmissionMode) []domain.TestCase {
	if mode == domain.ModeSubmit {
		return cases
	}
	var out []domain.TestCase
	for _, c := range cases {
		if c.IsSample {
			out = append(out, c)
		}
	}
	return out
}

func (a *App) enqueue(id string) {
	select {
	case a.queue <- id:
	default:
		go func() {
			select {
			case a.queue <- id:
			case <-a.stop:
			}
		}()
	}
}

func (a *App) worker() {
	defer a.wg.Done()
	for {
		select {
		case <-a.stop:
			return
		case id := <-a.queue:
			a.judge(id)
		}
	}
}

// judge runs one queued submission to completion.
func (a *App) judge(id string) {
	ctx := a.ctx
	var sub domain.Submission
	var it domain.Item
	var cases []domain.TestCase
	err := a.store.Write(ctx, func(tx store.Tx) error {
		var err error
		sub, err = tx.GetSubmission(id)
		if err != nil {
			return err
		}
		if sub.Status != domain.SubmissionQueued {
			return errors.New("not queued")
		}
		it, err = tx.GetItem(sub.ItemID)
		if err != nil {
			return err
		}
		cases, err = tx.ListTestCases(sub.ItemID)
		if err != nil {
			return err
		}
		sub.Status = domain.SubmissionRunning
		return tx.UpdateSubmission(&sub)
	})
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			a.log.Warn("could not start submission", "submission", id, "error", err)
		}
		return
	}
	var gcases []grader.Case
	if sub.Stdin != nil {
		gcases = []grader.Case{{Name: "Custom input", Stdin: *sub.Stdin}}
	} else {
		byID := map[string]domain.TestCase{}
		for _, c := range cases {
			byID[c.ID] = c
		}
		for _, id := range sub.CaseIDs {
			tcID := id
			c, ok := byID[id]
			if !ok {
				gcases = append(gcases, grader.Case{TestCaseID: &tcID, Name: "(deleted test case)",
					Unavailable: "the test case was deleted before it ran"})
				continue
			}
			exp := c.ExpectedStdout
			gcases = append(gcases, grader.Case{TestCaseID: &tcID, Name: c.Name, IsSample: c.IsSample, Stdin: c.Stdin, Expected: &exp})
		}
	}
	// The harness is the one the submission was created with.
	prog := a.graderProgram(it.Problem, harness.Assemble(sub.Language, sub.Harness, sub.Source))
	start := time.Now()
	out := a.grader.Grade(ctx, prog, it.Problem.Compare, gcases, func(i int, r domain.SubmissionResult) {
		if err := a.store.Write(ctx, func(tx store.Tx) error { return tx.AddSubmissionResult(id, i, r) }); err != nil &&
			!errors.Is(err, context.Canceled) {
			a.log.Warn("could not store submission result", "submission", id, "error", err)
		}
	})
	if ctx.Err() != nil {
		// Shutting down; the submission is finished as interrupted on the
		// next start.
		return
	}
	now := a.clock()
	sub.Status = domain.SubmissionCompleted
	v := out.Verdict
	sub.Verdict = &v
	sub.PassedCount = out.Passed
	sub.TimeMs, sub.MemoryKb = out.TimeMs, out.MemoryKb
	sub.CompileOutput = domain.Truncate(out.CompileOutput, domain.MaxResultTextBytes)
	sub.Error = out.Error
	sub.FinishedAt = &now
	err = a.store.Write(context.Background(), func(tx store.Tx) error {
		if err := tx.UpdateSubmission(&sub); err != nil {
			return err
		}
		if sub.Mode == domain.ModeSubmit && v == domain.VerdictAccepted {
			cur, err := tx.GetItem(sub.ItemID)
			if err != nil {
				return err
			}
			if cur.Status != domain.StatusDone {
				next := cur.Clone()
				next.Status = domain.StatusDone
				return a.saveItem(tx, &cur, &next)
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		a.log.Warn("could not complete submission", "submission", id, "error", err)
	}
	a.log.Debug("submission judged", "submission", id, "verdict", v, "passed", out.Passed, "total", len(gcases),
		"duration", time.Since(start).Round(time.Millisecond))
}

// recoverSubmissions finishes submissions left queued or running by a
// previous process.
func (a *App) recoverSubmissions(ctx context.Context) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		ids, err := tx.UnfinishedSubmissionIDs()
		if err != nil {
			return err
		}
		now := a.clock()
		for _, id := range ids {
			s, err := tx.GetSubmission(id)
			if err != nil {
				return err
			}
			v := domain.VerdictInternalError
			msg := "judging was interrupted because the server stopped; submit again"
			s.Status, s.Verdict, s.Error, s.FinishedAt = domain.SubmissionCompleted, &v, &msg, &now
			s.PassedCount = 0
			for _, r := range s.Results {
				if r.Verdict == domain.VerdictAccepted || r.Verdict == domain.VerdictExecuted {
					s.PassedCount++
				}
			}
			if err := tx.UpdateSubmission(&s); err != nil {
				return err
			}
		}
		if len(ids) > 0 {
			a.log.Info("finished interrupted submissions", "count", len(ids))
		}
		return nil
	})
}

// GetSubmission returns a submission with its results.
func (a *App) GetSubmission(ctx context.Context, id string) (domain.Submission, error) {
	var s domain.Submission
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		s, err = tx.GetSubmission(id)
		return notFoundAs(err, "submission")
	})
	return s, err
}

// WaitSubmission polls until the submission is completed or ctx ends.
func (a *App) WaitSubmission(ctx context.Context, id string) (domain.Submission, error) {
	delay := 100 * time.Millisecond
	for {
		s, err := a.GetSubmission(ctx, id)
		if err != nil || s.Status == domain.SubmissionCompleted {
			return s, err
		}
		select {
		case <-ctx.Done():
			return s, ctx.Err()
		case <-time.After(delay):
		}
		delay = min(delay*2, time.Second)
	}
}

// SubmissionQuery filters a problem's submissions.
type SubmissionQuery struct {
	Mode   string
	Limit  *int
	Offset int
}

// ListSubmissions lists a problem's submissions, newest first.
func (a *App) ListSubmissions(ctx context.Context, itemID string, q SubmissionQuery) (Page[domain.SubmissionSummary], error) {
	mode := domain.SubmissionMode(q.Mode)
	if q.Mode != "" && !mode.Valid() {
		return Page[domain.SubmissionSummary]{}, errBadRequest("mode must be run or submit")
	}
	limit, offset, err := pageBounds(q.Limit, q.Offset)
	if err != nil {
		return Page[domain.SubmissionSummary]{}, err
	}
	var out Page[domain.SubmissionSummary]
	err = a.store.Read(ctx, func(tx store.Tx) error {
		if _, err := tx.GetItem(itemID); err != nil {
			return notFoundAs(err, "item")
		}
		items, total, err := tx.ListSubmissions(itemID, mode, limit, offset)
		out = Page[domain.SubmissionSummary]{Items: items, Total: total}
		return err
	})
	return out, err
}

// VerifyResult is the outcome of running the reference solution on one case.
type VerifyResult struct {
	TestCaseID   string         `json:"testCaseId"`
	OK           bool           `json:"ok"`
	Matches      bool           `json:"matches"`
	ActualStdout string         `json:"actualStdout"`
	Verdict      domain.Verdict `json:"verdict"`
	Stderr       string         `json:"stderr"`
	TimeMs       *int           `json:"timeMs"`
}

// VerifyResponse lists verification results in case order.
type VerifyResponse struct {
	Results []VerifyResult `json:"results"`
}

// VerifyTestCases runs a saved solution (the reference solution unless
// solutionID names another) against every test case,
// marks matching cases verified and, with updateExpected, replaces expected
// outputs that differ.
func (a *App) VerifyTestCases(ctx context.Context, itemID string, updateExpected bool, solutionID string) (VerifyResponse, error) {
	var it domain.Item
	var cases []domain.TestCase
	var ref domain.Solution
	var isRef bool
	var h *domain.HarnessCode
	field := "solutionId"
	if solutionID == "" {
		field = "referenceSolution"
	}
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		if it, err = problemItem(tx, itemID); err != nil {
			return err
		}
		if ref, isRef, err = solutionFor(tx, &it, solutionID); err != nil {
			return err
		}
		if updateExpected && !isRef {
			return errField("updateExpected", "only applies when verifying with the reference solution")
		}
		if h, err = harnessFor(it.Problem, ref.Language, field); err != nil {
			return err
		}
		cases, err = tx.ListTestCases(itemID)
		return err
	})
	if err != nil {
		return VerifyResponse{}, err
	}
	if err := a.requireLanguage(ctx, ref.Language); err != nil {
		return VerifyResponse{}, err
	}
	prog, _, err := a.runnable(ctx, it.Problem, ref.Language, h, ref.Source, field)
	if err != nil {
		return VerifyResponse{}, err
	}
	stdins := make([]string, len(cases))
	for i, c := range cases {
		stdins[i] = c.Stdin
	}
	execs := a.grader.RunAll(ctx, prog, stdins, nil)
	if len(execs) > 0 {
		allFailed := true
		for _, e := range execs {
			if e.Err == nil {
				allFailed = false
				break
			}
		}
		if allFailed {
			return VerifyResponse{}, &Error{Code: CodeJudgeUnavailable, Message: "the judge engine is unreachable: " + grader.ErrorMessage(execs[0])}
		}
	}
	resp := VerifyResponse{Results: make([]VerifyResult, len(cases))}
	for i, c := range cases {
		e := execs[i]
		r := VerifyResult{TestCaseID: c.ID, Verdict: grader.Verdict(it.Problem.Compare, e, nil), TimeMs: e.Result.TimeMs}
		r.OK = r.Verdict == domain.VerdictExecuted
		r.ActualStdout = e.Result.Stdout
		r.Stderr = domain.Truncate(e.Result.Stderr, domain.MaxResultTextBytes)
		switch {
		case e.CompileFailed():
			r.Stderr = domain.Truncate(e.Result.CompileOutput, domain.MaxResultTextBytes)
		case e.Err != nil || e.Result.Status == judge.StatusInternalError:
			r.Stderr = grader.ErrorMessage(e)
		case !r.OK && r.Stderr == "":
			r.Stderr = e.Result.Message
		}
		r.Matches = r.OK && grader.Match(it.Problem.Compare, c.ExpectedStdout, e.Result.Stdout)
		resp.Results[i] = r
	}
	if !isRef {
		// Any other solution is only checked against the cases.
		return resp, nil
	}
	err = a.store.Write(ctx, func(tx store.Tx) error {
		cur, err := tx.GetItem(itemID)
		if err != nil {
			return notFoundAs(err, "item")
		}
		changed := false
		now := a.clock()
		if cur.Problem == nil || !domain.RefEqual(cur.Problem.ReferenceSolution, &ref) {
			return nil // the reference solution changed meanwhile
		}
		if hn, ok := cur.Problem.HarnessFor(ref.Language); !ok || !sameHarness(hn, h) {
			return nil // so did the harness it ran in
		}
		for i, c := range cases {
			r := resp.Results[i]
			if execs[i].Err != nil {
				continue // the engine failed; that says nothing about the case
			}
			tc, err := tx.GetTestCase(c.ID)
			if err != nil || tc.Stdin != c.Stdin || tc.ExpectedStdout != c.ExpectedStdout {
				continue // deleted or edited meanwhile
			}
			fixable := r.OK && !r.Matches && updateExpected &&
				utf8.ValidString(r.ActualStdout) && len(r.ActualStdout) <= domain.MaxTestCaseBytes
			switch {
			case fixable:
				tc.ExpectedStdout, tc.Verified = r.ActualStdout, true
			case r.OK && r.Matches:
				if tc.Verified {
					continue
				}
				tc.Verified = true
			default:
				if !tc.Verified {
					continue
				}
				tc.Verified = false
			}
			tc.UpdatedAt = now
			if err := tx.UpdateTestCase(&tc); err != nil {
				return err
			}
			changed = true
		}
		if changed {
			return a.testCasesChanged(tx, &cur)
		}
		return nil
	})
	return resp, err
}
