package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// AI requests run as jobs: the request is validated as the synchronous
// endpoint did, stored, and handed to the AI queue, which runs it with a
// context of its own (derived from the app's lifetime, not from the request
// that started it). The job keeps the response body the request produced,
// or its error, until the client picks it up or dismisses it.

// Kinds of AI job, one per AI endpoint.
const (
	JobDraft     = "draft"
	JobVariant   = "variant"
	JobTestCases = "testcases"
	JobCode      = "code"
)

// Bounds of the AI jobs.
const (
	// JobRetention is how long a finished job is kept.
	JobRetention = 3 * 24 * time.Hour
	// MaxKeptJobs is how many jobs are kept at most; the oldest finished
	// ones go first.
	MaxKeptJobs = 200
	// MaxActiveJobs is how many jobs may be queued or running at once.
	MaxActiveJobs = 20
	// MaxOriginChars bounds a job's origin.
	MaxOriginChars = 2000
	// jobTitleChars bounds the title taken from free text.
	jobTitleChars = 80
	// jobPruneInterval is how often old jobs are pruned.
	jobPruneInterval = time.Hour
	// jobWriteTimeout bounds the write that finishes a job.
	jobWriteTimeout = 10 * time.Second
)

// CodeInterrupted is the error code of a job that was running when the
// server stopped. It is not an HTTP error code.
const CodeInterrupted Code = "interrupted"

// task is a validated AI request ready to run.
type task[T any] struct {
	itemID *string
	title  string
	run    func(ctx context.Context) (T, error)
	// retitle names the job after its result, when that says more.
	retitle func(T) string
}

// aiTask is a task whose result type is erased, for the job runner.
type aiTask struct {
	itemID *string
	title  string
	run    func(ctx context.Context) (result any, title string, err error)
}

func (t task[T]) erase() aiTask {
	return aiTask{itemID: t.itemID, title: t.title, run: func(ctx context.Context) (any, string, error) {
		r, err := t.run(ctx)
		title := ""
		if err == nil && t.retitle != nil {
			title = t.retitle(r)
		}
		return r, title, err
	}}
}

// jobTitle is a job's title from free text: its first characters on one
// line.
func jobTitle(s string) string {
	return clipLabel(oneLine(s), jobTitleChars)
}

// clipLabel shortens a one-line label to at most n runes. A label that is
// cut ends with "…", after the last whole word when one ends near the cut.
func clipLabel(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	cut := r[:n-1]
	for i := len(cut) - 1; i >= len(cut)*2/3; i-- {
		if unicode.IsSpace(cut[i]) {
			cut = cut[:i]
			break
		}
	}
	return strings.TrimRightFunc(string(cut), func(c rune) bool { return unicode.IsSpace(c) || strings.ContainsRune(",;:-–—", c) }) + "…"
}

// JobError is the error of a failed job, in the shape of an HTTP error
// body's "error".
type JobError struct {
	Code    Code           `json:"code"`
	Message string         `json:"message"`
	Fields  map[string]any `json:"fields,omitempty"`
}

// AIJob is a job as clients see it, without its request and result.
type AIJob struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`
	ItemID     *string    `json:"itemId"`
	DraftID    *string    `json:"draftId"`
	Title      string     `json:"title"`
	Status     string     `json:"status"`
	Origin     *string    `json:"origin"`
	Error      *JobError  `json:"error"`
	PickedUp   bool       `json:"pickedUp"`
	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt"`
}

// AIJobDetail is a job with the request it was started with and, once it
// has succeeded, the response body the request produced.
type AIJobDetail struct {
	AIJob
	Request json.RawMessage `json:"request"`
	Result  json.RawMessage `json:"result"`
}

func jobView(j store.AIJob) AIJob {
	v := AIJob{ID: j.ID, Kind: j.Kind, ItemID: j.ItemID, DraftID: j.DraftID, Title: j.Title, Status: j.Status, Origin: j.Origin,
		PickedUp: j.PickedUpAt != nil, CreatedAt: j.CreatedAt, StartedAt: j.StartedAt, FinishedAt: j.FinishedAt}
	if j.Error != nil {
		var e JobError
		if json.Unmarshal([]byte(*j.Error), &e) == nil {
			v.Error = &e
		}
	}
	return v
}

func jobDetail(j store.AIJob) AIJobDetail {
	d := AIJobDetail{AIJob: jobView(j), Request: json.RawMessage(j.Request)}
	if j.Result != nil {
		d.Result = json.RawMessage(*j.Result)
	}
	return d
}

func activeJob(status string) bool { return status == store.JobQueued || status == store.JobRunning }

// decodeRequest decodes a request body as the HTTP API does: a type error
// in a field is a validation error on that field, anything else that is
// not JSON a bad request.
func decodeRequest(raw json.RawMessage, v any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage("{}")
	}
	err := domain.DecodeJSON(raw, v)
	if err == nil {
		return nil
	}
	var te *domain.TypeError
	if errors.As(err, &te) {
		if te.Path == "" {
			return &Error{Code: CodeBadRequest, Message: te.Error()}
		}
		return &Error{Code: CodeValidation, Message: te.Error(), Fields: map[string]any{te.Path: "must be " + te.Expected}}
	}
	return errBadRequest("malformed JSON: %v", err)
}

// prepareAITask validates the body of an AI request of the kind, for the
// item (variant and test cases), as its endpoint does.
func (a *App) prepareAITask(ctx context.Context, kind, itemID string, raw json.RawMessage) (aiTask, error) {
	switch kind {
	case JobDraft:
		var in DraftInput
		if err := decodeRequest(raw, &in); err != nil {
			return aiTask{}, err
		}
		t, err := a.prepareDraft(ctx, in)
		return t.erase(), err
	case JobVariant:
		var in VariantInput
		if err := decodeRequest(raw, &in); err != nil {
			return aiTask{}, err
		}
		t, err := a.prepareVariant(ctx, itemID, in)
		return t.erase(), err
	case JobTestCases:
		var in GenerateTestCasesInput
		if err := decodeRequest(raw, &in); err != nil {
			return aiTask{}, err
		}
		t, err := a.prepareTestCases(ctx, itemID, in)
		return t.erase(), err
	case JobCode:
		var in CodeInput
		if err := decodeRequest(raw, &in); err != nil {
			return aiTask{}, err
		}
		t, err := a.prepareCode(ctx, in)
		return t.erase(), err
	}
	return aiTask{}, errBadRequest("unknown kind of AI job %q", kind)
}

// jobOrigin reads and checks the optional "origin" of a request body.
func jobOrigin(raw json.RawMessage) (*string, error) {
	var in struct {
		Origin domain.Opt[string] `json:"origin"`
	}
	if err := decodeRequest(raw, &in); err != nil {
		return nil, err
	}
	if !in.Origin.HasValue() {
		return nil, nil
	}
	o := in.Origin.Val
	switch {
	case utf8.RuneCountInString(o) > MaxOriginChars:
		return nil, errField("origin", fmt.Sprintf("must be at most %d characters", MaxOriginChars))
	case !domain.IsSingleLine(o):
		return nil, errField("origin", "must be a single line")
	}
	return &o, nil
}

// StartAIJob validates an AI request of the kind (testcases, with the
// item's id, or code) as its synchronous endpoint did, and queues it as a
// job. Invalid requests, AI features being off and an unusable provider are
// errors here, before any job exists. raw is the request body; its
// optional "origin" is kept with the job. Draft and variant generations
// belong to a draft and are started through it.
func (a *App) StartAIJob(ctx context.Context, kind, itemID string, raw json.RawMessage) (AIJob, error) {
	if kind != JobTestCases && kind != JobCode {
		return AIJob{}, errBadRequest("%s generations are started from a draft", kind)
	}
	raw = requestBody(raw)
	origin, err := jobOrigin(raw)
	if err != nil {
		return AIJob{}, err
	}
	t, err := a.prepareAITask(ctx, kind, itemID, raw)
	if err != nil {
		return AIJob{}, err
	}
	now := a.clock()
	j := store.AIJob{ID: newID(), CreatedAt: now, Kind: kind, ItemID: t.itemID, Title: t.title, Status: store.JobQueued,
		Origin: origin, Request: string(raw)}
	err = a.store.Write(ctx, func(tx store.Tx) error { return insertJob(tx, &j) })
	if err != nil {
		return AIJob{}, err
	}
	a.aiQueue.Push(j.ID)
	return jobView(j), nil
}

// requestBody is a request body as it is stored: an empty one is {}.
func requestBody(raw json.RawMessage) json.RawMessage {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return raw
}

// insertJob stores a new queued job, unless too many are active, and prunes
// old ones. The caller pushes it to the queue once the transaction has
// committed.
func insertJob(tx store.Tx, j *store.AIJob) error {
	active, err := tx.ListAIJobs(store.AIJobFilter{Active: true, Limit: MaxActiveJobs})
	if err != nil {
		return err
	}
	if len(active) >= MaxActiveJobs {
		return errConflict(fmt.Sprintf("%d AI jobs are already queued or running; wait for one to finish or cancel one",
			len(active)), nil)
	}
	if err := tx.InsertAIJob(j); err != nil {
		return err
	}
	_, err = tx.PruneAIJobs(j.CreatedAt.Add(-JobRetention), MaxKeptJobs)
	return err
}

// finishJob runs the completion step of a job's kind, if it has one, in
// the transaction that finished the job.
func (a *App) finishJob(tx store.Tx, j *store.AIJob) error {
	if done := a.completions[j.Kind]; done != nil {
		return done(tx, j)
	}
	return nil
}

// runJob runs one queued job to the end, unless it was cancelled first. A
// job whose run is cut short because the server stops is left running and
// becomes failed on the next start.
func (a *App) runJob(ctx context.Context, id string) {
	var j store.AIJob
	err := a.store.Write(ctx, func(tx store.Tx) error {
		var err error
		if j, err = tx.GetAIJob(id); err != nil {
			return err
		}
		if j.Status != store.JobQueued {
			return errNotQueued
		}
		now := a.clock()
		j.Status, j.StartedAt = store.JobRunning, &now
		return tx.UpdateAIJob(&j)
	})
	if err != nil {
		if !errors.Is(err, errNotQueued) && !errors.Is(err, store.ErrNotFound) && ctx.Err() == nil {
			a.log.Warn("could not start an AI job", "job", id, "error", err)
		}
		return
	}
	start := time.Now()
	var result any
	var title string
	t, err := a.prepareAITask(ctx, j.Kind, derefOr(j.ItemID), json.RawMessage(j.Request))
	if err == nil {
		result, title, err = t.run(ctx)
	}
	if a.ctx.Err() != nil {
		return // shutting down
	}
	wctx, cancel := context.WithTimeout(context.Background(), jobWriteTimeout)
	defer cancel()
	err = a.store.Write(wctx, func(tx store.Tx) error {
		cur, gerr := tx.GetAIJob(id)
		if gerr != nil {
			return gerr
		}
		if cur.Status != store.JobRunning {
			return errNotQueued // cancelled meanwhile; that state stands
		}
		now := a.clock()
		cur.FinishedAt = &now
		switch {
		case err != nil && ctx.Err() != nil && errors.Is(err, context.Canceled):
			cur.Status = store.JobCancelled
		case err != nil:
			ae := AsError(err)
			if ae.Code == CodeInternal {
				a.log.Error("AI job failed", "job", id, "kind", j.Kind, "error", err)
			}
			body, _ := json.Marshal(jobError(ae))
			s := string(body)
			cur.Status, cur.Error = store.JobFailed, &s
		default:
			body, merr := marshalBody(result)
			if merr != nil {
				return merr
			}
			cur.Status, cur.Result = store.JobSucceeded, &body
			if title != "" {
				cur.Title = truncateRunes(oneLine(title), domain.MaxTitleChars)
			}
		}
		if err := tx.UpdateAIJob(&cur); err != nil {
			return err
		}
		return a.finishJob(tx, &cur)
	})
	if err != nil && !errors.Is(err, errNotQueued) && !errors.Is(err, store.ErrNotFound) {
		a.log.Warn("could not finish an AI job", "job", id, "error", err)
	}
	a.log.Debug("AI job finished", "job", id, "kind", j.Kind, "duration", time.Since(start).Round(time.Millisecond))
}

var errNotQueued = errors.New("the job is not in the expected state")

func derefOr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func jobError(ae *Error) JobError {
	e := JobError{Code: ae.Code, Message: ae.Message}
	if ae.Code == CodeValidation || (ae.Code == CodeConflict && len(ae.Fields) > 0) {
		e.Fields = ae.Fields
		if e.Fields == nil {
			e.Fields = map[string]any{}
		}
	}
	return e
}

// marshalBody encodes a response body as the HTTP API writes it.
func marshalBody(v any) (string, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return string(bytes.TrimRight(b.Bytes(), "\n")), nil
}

// recoverAIJobs finishes the jobs a previous process left running as
// failed, prunes old jobs, and returns the ids of queued jobs, oldest
// first, to queue again.
func (a *App) recoverAIJobs(ctx context.Context) ([]string, error) {
	var queued []string
	err := a.store.Write(ctx, func(tx store.Tx) error {
		active, err := tx.ListAIJobs(store.AIJobFilter{Active: true})
		if err != nil {
			return err
		}
		now := a.clock()
		body, _ := json.Marshal(JobError{Code: CodeInterrupted,
			Message: "the server restarted before this job finished; start it again"})
		failed := 0
		for i := len(active) - 1; i >= 0; i-- {
			j := active[i]
			if j.Status == store.JobQueued {
				queued = append(queued, j.ID)
				continue
			}
			full, err := tx.GetAIJob(j.ID)
			if err != nil {
				return err
			}
			s := string(body)
			full.Status, full.Error, full.FinishedAt = store.JobFailed, &s, &now
			if err := tx.UpdateAIJob(&full); err != nil {
				return err
			}
			if err := a.finishJob(tx, &full); err != nil {
				return err
			}
			failed++
		}
		if failed > 0 {
			a.log.Info("failed AI jobs interrupted by a restart", "count", failed)
		}
		_, err = tx.PruneAIJobs(now.Add(-JobRetention), MaxKeptJobs)
		return err
	})
	return queued, err
}

func (a *App) pruneJobsLoop() {
	defer a.wg.Done()
	t := time.NewTicker(jobPruneInterval)
	defer t.Stop()
	for {
		select {
		case <-a.stop:
			return
		case <-t.C:
			if err := a.store.Write(a.ctx, func(tx store.Tx) error {
				_, err := tx.PruneAIJobs(a.clock().Add(-JobRetention), MaxKeptJobs)
				return err
			}); err != nil && a.ctx.Err() == nil {
				a.log.Warn("could not prune AI jobs", "error", err)
			}
		}
	}
}

// AIJobQuery filters the job list.
type AIJobQuery struct {
	Active   bool
	Kind     string
	ItemID   string
	DraftID  string
	PickedUp bool
	Limit    *int
}

// ListAIJobs lists jobs, newest first: by default those whose result has
// not been picked up.
func (a *App) ListAIJobs(ctx context.Context, q AIJobQuery) (List[AIJob], error) {
	limit, _, err := pageBounds(q.Limit, 0)
	if err != nil {
		return List[AIJob]{}, err
	}
	switch q.Kind {
	case "", JobDraft, JobVariant, JobTestCases, JobCode:
	default:
		return List[AIJob]{}, errBadRequest("kind must be draft, variant, testcases or code")
	}
	f := store.AIJobFilter{Active: q.Active, Kind: q.Kind, ItemID: q.ItemID, DraftID: q.DraftID, PickedUp: &q.PickedUp, Limit: limit}
	var jobs []store.AIJob
	err = a.store.Read(ctx, func(tx store.Tx) (err error) { jobs, err = tx.ListAIJobs(f); return err })
	out := List[AIJob]{Items: make([]AIJob, len(jobs))}
	for i, j := range jobs {
		out.Items[i] = jobView(j)
	}
	return out, err
}

// GetAIJob returns a job with its request and result.
func (a *App) GetAIJob(ctx context.Context, id string) (AIJobDetail, error) {
	var j store.AIJob
	err := a.store.Read(ctx, func(tx store.Tx) (err error) { j, err = tx.GetAIJob(id); return notFoundAs(err, "AI job") })
	if err != nil {
		return AIJobDetail{}, err
	}
	return jobDetail(j), nil
}

// CancelAIJob cancels a queued or running job; its provider request is
// aborted. A finished job is returned as it is.
func (a *App) CancelAIJob(ctx context.Context, id string) (AIJob, error) {
	var j store.AIJob
	err := a.store.Write(ctx, func(tx store.Tx) (err error) {
		if j, err = tx.GetAIJob(id); err != nil {
			return notFoundAs(err, "AI job")
		}
		if !activeJob(j.Status) {
			return nil
		}
		now := a.clock()
		j.Status, j.FinishedAt = store.JobCancelled, &now
		return tx.UpdateAIJob(&j)
	})
	if err != nil {
		return AIJob{}, err
	}
	a.aiQueue.Cancel(id)
	return jobView(j), nil
}

// DismissAIJob removes a job, cancelling it first if it is still queued or
// running.
func (a *App) DismissAIJob(ctx context.Context, id string) error {
	err := a.store.Write(ctx, func(tx store.Tx) error {
		ok, err := tx.DeleteAIJob(id)
		if err == nil && !ok {
			return errNotFound("AI job")
		}
		return err
	})
	if err != nil {
		return err
	}
	a.aiQueue.Cancel(id)
	return nil
}

// PickUpAIJob marks a finished job's outcome as taken by its screen, so it
// leaves the default list, and returns it with its result.
func (a *App) PickUpAIJob(ctx context.Context, id string) (AIJobDetail, error) {
	var j store.AIJob
	err := a.store.Write(ctx, func(tx store.Tx) (err error) {
		if j, err = tx.GetAIJob(id); err != nil {
			return notFoundAs(err, "AI job")
		}
		if activeJob(j.Status) {
			return errConflict("the AI job has not finished yet", nil)
		}
		if j.PickedUpAt != nil {
			return nil
		}
		now := a.clock()
		j.PickedUpAt = &now
		return tx.UpdateAIJob(&j)
	})
	if err != nil {
		return AIJobDetail{}, err
	}
	return jobDetail(j), nil
}
