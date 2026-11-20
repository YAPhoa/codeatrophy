package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// A draft is a new item in progress, kept on the server until it is saved
// to the library or deleted. Its AI generations are jobs (of kind draft or
// variant) whose completion step writes their outcome into the draft, so
// the outcome arrives whether or not a client is watching, and however long
// the job takes. The client's review form is an opaque document the server
// stores and returns.

// Kinds of draft.
const (
	DraftCapture = "capture"
	DraftVariant = "variant"
)

// States of a draft, derived from its fields (see draftState).
const (
	DraftNew      = "new"
	DraftDrafting = "drafting"
	DraftReady    = "ready"
	DraftEdited   = "edited"
	DraftFailed   = "failed"
)

// MaxDrafts is how many drafts an instance keeps at most.
const MaxDrafts = 500

// DraftSummary is a draft as lists show it.
type DraftSummary struct {
	ID            string    `json:"id"`
	Kind          string    `json:"kind"`
	VariantOf     *string   `json:"variantOf"`
	Title         string    `json:"title"`
	State         string    `json:"state"`
	Revision      int       `json:"revision"`
	Edited        bool      `json:"edited"`
	Job           *AIJob    `json:"job"`
	Error         *JobError `json:"error"`
	GenerationSeq int       `json:"generationSeq"`
	BasedOn       int       `json:"basedOn"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// Draft is a draft with its documents.
type Draft struct {
	DraftSummary
	Request    json.RawMessage `json:"request"`
	Generation json.RawMessage `json:"generation"`
	Content    json.RawMessage `json:"content"`
}

func rawOrNil(p *string) json.RawMessage {
	if p == nil {
		return nil
	}
	return json.RawMessage(*p)
}

// draftState derives what a draft is waiting for; job is its latest job,
// or nil.
func draftState(d store.Draft, job *store.AIJob) string {
	switch {
	case job != nil && activeJob(job.Status):
		return DraftDrafting
	case d.Error != nil:
		return DraftFailed
	case d.GenerationSeq > d.BasedOn, d.GenerationSeq > 0 && !d.Edited:
		return DraftReady
	case d.Content != nil || d.Edited:
		return DraftEdited
	}
	return DraftNew
}

func draftSummary(d store.Draft, job *store.AIJob) DraftSummary {
	s := DraftSummary{ID: d.ID, Kind: d.Kind, VariantOf: d.VariantOf, Title: d.Title, State: draftState(d, job),
		Revision: d.Revision, Edited: d.Edited, GenerationSeq: d.GenerationSeq, BasedOn: d.BasedOn,
		CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt}
	if job != nil {
		v := jobView(*job)
		s.Job = &v
	}
	if d.Error != nil {
		var e JobError
		if json.Unmarshal([]byte(*d.Error), &e) == nil {
			s.Error = &e
		}
	}
	return s
}

// draftJob reads a draft's latest job, without its bodies, or nil when the
// server no longer has it.
func draftJob(tx store.Tx, d store.Draft) (*store.AIJob, error) {
	if d.JobID == nil {
		return nil, nil
	}
	jobs, err := tx.ListAIJobs(store.AIJobFilter{DraftID: d.ID})
	if err != nil {
		return nil, err
	}
	for _, j := range jobs {
		if j.ID == *d.JobID {
			return &j, nil
		}
	}
	return nil, nil
}

func (a *App) draftView(tx store.Tx, d store.Draft) (Draft, error) {
	job, err := draftJob(tx, d)
	if err != nil {
		return Draft{}, err
	}
	return Draft{DraftSummary: draftSummary(d, job), Request: rawOrNil(d.Request), Generation: rawOrNil(d.Generation),
		Content: rawOrNil(d.Content)}, nil
}

// draftLabel is the label lists show for a draft that has no title of the
// client's: the title of its latest generation, else the start of its
// request's text, else "Variant of" the original.
func draftLabel(tx store.Tx, d store.Draft) string {
	if d.ClientTitle != nil {
		return *d.ClientTitle
	}
	if d.Generation != nil {
		var g struct {
			Draft struct {
				Title string `json:"title"`
			} `json:"draft"`
		}
		if json.Unmarshal([]byte(*d.Generation), &g) == nil && strings.TrimSpace(g.Draft.Title) != "" {
			return truncateRunes(oneLine(g.Draft.Title), domain.MaxTitleChars)
		}
	}
	if d.Kind == DraftCapture && d.Request != nil {
		var r struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(*d.Request), &r) == nil {
			if t := jobTitle(domain.NormalizeText(r.Text)); t != "" {
				return t
			}
		}
	}
	if d.Kind == DraftVariant && d.VariantOf != nil {
		if it, err := tx.GetItem(*d.VariantOf); err == nil {
			return truncateRunes("Variant of "+it.Title, domain.MaxTitleChars)
		}
		return "Variant"
	}
	return "Untitled draft"
}

// DraftQuery filters the draft list.
type DraftQuery struct {
	Kind      string
	VariantOf string
}

// ListDrafts lists drafts, most recently changed first.
func (a *App) ListDrafts(ctx context.Context, q DraftQuery) (List[DraftSummary], error) {
	if q.Kind != "" && q.Kind != DraftCapture && q.Kind != DraftVariant {
		return List[DraftSummary]{}, errBadRequest("kind must be capture or variant")
	}
	out := List[DraftSummary]{Items: []DraftSummary{}}
	err := a.store.Read(ctx, func(tx store.Tx) error {
		drafts, err := tx.ListDrafts(store.DraftFilter{Kind: q.Kind, VariantOf: q.VariantOf})
		if err != nil {
			return err
		}
		jobs, err := tx.ListAIJobs(store.AIJobFilter{})
		if err != nil {
			return err
		}
		byID := map[string]*store.AIJob{}
		for i := range jobs {
			byID[jobs[i].ID] = &jobs[i]
		}
		for _, d := range drafts {
			var job *store.AIJob
			if d.JobID != nil {
				job = byID[*d.JobID]
			}
			out.Items = append(out.Items, draftSummary(d, job))
		}
		return nil
	})
	return out, err
}

// GetDraft returns a draft with its documents.
func (a *App) GetDraft(ctx context.Context, id string) (Draft, error) {
	var out Draft
	err := a.store.Read(ctx, func(tx store.Tx) error {
		d, err := tx.GetDraft(id)
		if err != nil {
			return notFoundAs(err, "draft")
		}
		out, err = a.draftView(tx, d)
		return err
	})
	return out, err
}

// NewDraftInput is the body of POST /drafts.
type NewDraftInput struct {
	Kind      domain.Opt[string]          `json:"kind"`
	VariantOf domain.Opt[string]          `json:"variantOf"`
	Title     domain.Opt[string]          `json:"title"`
	Content   domain.Opt[json.RawMessage] `json:"content"`
	Generate  domain.Opt[json.RawMessage] `json:"generate"`
}

// DraftPatch is the body of PATCH /drafts/{id}.
type DraftPatch struct {
	Content          domain.Opt[json.RawMessage] `json:"content"`
	BasedOn          domain.Opt[int]             `json:"basedOn"`
	Edited           domain.Opt[bool]            `json:"edited"`
	Title            domain.Opt[string]          `json:"title"`
	ExpectedRevision domain.Opt[int]             `json:"expectedRevision"`
}

// draftContent checks a draft's content: a JSON object, or null.
func draftContent(o domain.Opt[json.RawMessage]) (*string, error) {
	if !o.HasValue() {
		return nil, nil
	}
	raw := bytes.TrimSpace(o.Val)
	if len(raw) == 0 || raw[0] != '{' || !json.Valid(raw) {
		return nil, errField("content", "must be a JSON object or null")
	}
	s := string(raw)
	return &s, nil
}

// draftClientTitle checks the title a client sets: a single line, or
// null or empty for none.
func draftClientTitle(o domain.Opt[string]) (*string, error) {
	if !o.HasValue() {
		return nil, nil
	}
	t := strings.TrimSpace(domain.NormalizeText(o.Val))
	switch {
	case t == "":
		return nil, nil
	case utf8.RuneCountInString(t) > domain.MaxTitleChars:
		return nil, errField("title", fmt.Sprintf("must be at most %d characters", domain.MaxTitleChars))
	case !domain.IsSingleLine(t):
		return nil, errField("title", "must be a single line")
	}
	return &t, nil
}

// jobKindOf is the kind of a draft's generation jobs.
func jobKindOf(draftKind string) string {
	if draftKind == DraftVariant {
		return JobVariant
	}
	return JobDraft
}

// newDraftJob validates a draft's generation request and builds its job.
func (a *App) newDraftJob(ctx context.Context, d store.Draft, raw json.RawMessage) (store.AIJob, error) {
	raw = requestBody(raw)
	origin, err := jobOrigin(raw)
	if err != nil {
		return store.AIJob{}, err
	}
	kind := jobKindOf(d.Kind)
	t, err := a.prepareAITask(ctx, kind, derefOr(d.VariantOf), raw)
	if err != nil {
		return store.AIJob{}, err
	}
	id := d.ID
	return store.AIJob{ID: newID(), CreatedAt: a.clock(), Kind: kind, ItemID: t.itemID, DraftID: &id, Title: t.title,
		Status: store.JobQueued, Origin: origin, Request: string(raw)}, nil
}

// CreateDraft creates a draft, and with Generate starts its first
// generation (started reports that).
func (a *App) CreateDraft(ctx context.Context, in NewDraftInput) (out Draft, started bool, err error) {
	kind := optText(in.Kind)
	fe := domain.FieldErrors{}
	switch kind {
	case DraftCapture:
		if in.VariantOf.HasValue() {
			fe.Add("variantOf", "applies to a variant draft only")
		}
	case DraftVariant:
		if !in.VariantOf.HasValue() {
			fe.Add("variantOf", "is required for a variant draft")
		}
	case "":
		fe.Add("kind", "is required")
	default:
		fe.Add("kind", "must be capture or variant")
	}
	if err := errValidation(fe); err != nil {
		return Draft{}, false, err
	}
	content, err := draftContent(in.Content)
	if err != nil {
		return Draft{}, false, err
	}
	title, err := draftClientTitle(in.Title)
	if err != nil {
		return Draft{}, false, err
	}
	now := a.clock()
	d := store.Draft{ID: newID(), CreatedAt: now, UpdatedAt: now, Kind: kind, ClientTitle: title, Revision: 1,
		Content: content, Edited: content != nil && !in.Generate.HasValue()}
	if kind == DraftVariant {
		v := in.VariantOf.Val
		d.VariantOf = &v
		if _, err := a.GetItem(ctx, v); err != nil {
			if AsError(err).Code == CodeNotFound {
				return Draft{}, false, errField("variantOf", "item does not exist")
			}
			return Draft{}, false, err
		}
	}
	var job store.AIJob
	if in.Generate.HasValue() {
		if job, err = a.newDraftJob(ctx, d, in.Generate.Val); err != nil {
			return Draft{}, false, err
		}
		req := job.Request
		d.Request, d.JobID = &req, &job.ID
	}
	err = a.store.Write(ctx, func(tx store.Tx) error {
		existing, err := tx.ListDrafts(store.DraftFilter{})
		if err != nil {
			return err
		}
		if len(existing) >= MaxDrafts {
			return errConflict(fmt.Sprintf("there are already %d drafts; save or delete some first", len(existing)), nil)
		}
		d.Title = draftLabel(tx, d)
		if d.JobID != nil {
			if err := insertJob(tx, &job); err != nil {
				return err
			}
		}
		if err := tx.InsertDraft(&d); err != nil {
			return err
		}
		out, err = a.draftView(tx, d)
		return err
	})
	if err != nil {
		return Draft{}, false, err
	}
	if d.JobID != nil {
		a.aiQueue.Push(job.ID)
	}
	return out, d.JobID != nil, nil
}

// checkDraftRevision refuses a change based on another revision of the draft.
func checkDraftRevision(d store.Draft, expected domain.Opt[int]) error {
	if expected.HasValue() && expected.Val != d.Revision {
		return errConflict(fmt.Sprintf("the draft has changed since revision %d; it is at revision %d", expected.Val,
			d.Revision), map[string]any{"revision": d.Revision})
	}
	return nil
}

// touch records a change to a draft.
func (a *App) touchDraft(d *store.Draft) {
	d.Revision++
	d.UpdatedAt = a.clock()
}

// pickUpJob marks a finished job picked up, if it is not yet.
func (a *App) pickUpJob(tx store.Tx, id *string) error {
	if id == nil {
		return nil
	}
	j, err := tx.GetAIJob(*id)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil || activeJob(j.Status) || j.PickedUpAt != nil {
		return err
	}
	now := a.clock()
	j.PickedUpAt = &now
	return tx.UpdateAIJob(&j)
}

// UpdateDraft applies a merge update to a draft.
func (a *App) UpdateDraft(ctx context.Context, id string, in DraftPatch) (Draft, error) {
	content, err := draftContent(in.Content)
	if err != nil {
		return Draft{}, err
	}
	title, err := draftClientTitle(in.Title)
	if err != nil {
		return Draft{}, err
	}
	if in.Edited.Set && in.Edited.Null {
		return Draft{}, errField("edited", "must be true or false")
	}
	if in.BasedOn.Set && in.BasedOn.Null {
		return Draft{}, errField("basedOn", "must be an integer")
	}
	var out Draft
	err = a.store.Write(ctx, func(tx store.Tx) error {
		d, err := tx.GetDraft(id)
		if err != nil {
			return notFoundAs(err, "draft")
		}
		if err := checkDraftRevision(d, in.ExpectedRevision); err != nil {
			return err
		}
		if in.Content.Set {
			d.Content, d.Error = content, nil
		}
		if in.BasedOn.Set {
			if in.BasedOn.Val < 0 || in.BasedOn.Val > d.GenerationSeq {
				return errField("basedOn", fmt.Sprintf("must be between 0 and %d", d.GenerationSeq))
			}
			if in.BasedOn.Val == d.GenerationSeq && d.GenerationSeq > 0 {
				if err := a.pickUpJob(tx, d.JobID); err != nil {
					return err
				}
			}
			d.BasedOn = in.BasedOn.Val
		}
		if in.Edited.Set {
			d.Edited = in.Edited.Val
		}
		if in.Title.Set {
			d.ClientTitle = title
			d.Title = draftLabel(tx, d)
		}
		a.touchDraft(&d)
		if err := tx.UpdateDraft(&d); err != nil {
			return err
		}
		out, err = a.draftView(tx, d)
		return err
	})
	return out, err
}

// GenerateDraft starts a generation of a draft with the request body raw
// (a draft or a variant request; a revision carries previousDraft and an
// instruction).
func (a *App) GenerateDraft(ctx context.Context, id string, raw json.RawMessage) (Draft, error) {
	var d store.Draft
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { d, err = tx.GetDraft(id); return notFoundAs(err, "draft") }); err != nil {
		return Draft{}, err
	}
	return a.startDraftGeneration(ctx, d, raw)
}

// RetryDraft starts a generation with the draft's latest request again.
func (a *App) RetryDraft(ctx context.Context, id string) (Draft, error) {
	var d store.Draft
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { d, err = tx.GetDraft(id); return notFoundAs(err, "draft") }); err != nil {
		return Draft{}, err
	}
	if d.Request == nil {
		return Draft{}, errField("request", "the draft has no generation to retry")
	}
	return a.startDraftGeneration(ctx, d, json.RawMessage(*d.Request))
}

func (a *App) startDraftGeneration(ctx context.Context, d store.Draft, raw json.RawMessage) (Draft, error) {
	job, err := a.newDraftJob(ctx, d, raw)
	if err != nil {
		return Draft{}, err
	}
	var out Draft
	err = a.store.Write(ctx, func(tx store.Tx) error {
		cur, err := tx.GetDraft(d.ID)
		if err != nil {
			return notFoundAs(err, "draft")
		}
		prev, err := draftJob(tx, cur)
		if err != nil {
			return err
		}
		if prev != nil && activeJob(prev.Status) {
			return errConflict("the draft is already being generated; wait for it or cancel it", nil)
		}
		if err := a.pickUpJob(tx, cur.JobID); err != nil {
			return err
		}
		if err := insertJob(tx, &job); err != nil {
			return err
		}
		req := job.Request
		cur.Request, cur.JobID, cur.Error = &req, &job.ID, nil
		if cur.ClientTitle == nil && cur.GenerationSeq == 0 {
			cur.Title = draftLabel(tx, cur)
		}
		a.touchDraft(&cur)
		if err := tx.UpdateDraft(&cur); err != nil {
			return err
		}
		out, err = a.draftView(tx, cur)
		return err
	})
	if err != nil {
		return Draft{}, err
	}
	a.aiQueue.Push(job.ID)
	return out, nil
}

// completeDraftJob writes a finished generation's outcome into its draft,
// in the transaction that finished the job: the result into generation, or
// the error. A job that is no longer the draft's latest, or whose draft is
// gone, changes nothing.
func (a *App) completeDraftJob(tx store.Tx, j *store.AIJob) error {
	if j.DraftID == nil {
		return nil
	}
	d, err := tx.GetDraft(*j.DraftID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if d.JobID == nil || *d.JobID != j.ID {
		return nil
	}
	switch j.Status {
	case store.JobSucceeded:
		d.Generation, d.Error = j.Result, nil
		d.GenerationSeq++
		if d.ClientTitle == nil {
			d.Title = draftLabel(tx, d)
		}
	case store.JobFailed:
		d.Error = j.Error
	default:
		return nil
	}
	a.touchDraft(&d)
	return tx.UpdateDraft(&d)
}

// DraftSaveInput is the body of POST /drafts/{id}/save.
type DraftSaveInput struct {
	Item             domain.ItemInput `json:"item"`
	ExpectedRevision domain.Opt[int]  `json:"expectedRevision"`
}

// SaveDraft creates the item from the draft's form and deletes the draft,
// in one transaction. A generation still running is cancelled.
func (a *App) SaveDraft(ctx context.Context, id string, in DraftSaveInput) (domain.Item, error) {
	var d store.Draft
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { d, err = tx.GetDraft(id); return notFoundAs(err, "draft") }); err != nil {
		return domain.Item{}, err
	}
	item := in.Item
	if d.VariantOf != nil && !item.VariantOf.Set {
		item.VariantOf = domain.Some(*d.VariantOf)
	}
	n, err := a.newItem(item)
	if err != nil {
		return domain.Item{}, err
	}
	var out domain.Item
	var cancelled *string
	err = a.store.Write(ctx, func(tx store.Tx) error {
		cur, err := tx.GetDraft(id)
		if err != nil {
			return notFoundAs(err, "draft")
		}
		if err := checkDraftRevision(cur, in.ExpectedRevision); err != nil {
			return err
		}
		if out, err = a.insertNewItem(tx, n); err != nil {
			return err
		}
		if cancelled, err = a.endDraft(tx, cur); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return domain.Item{}, err
	}
	if cancelled != nil {
		a.aiQueue.Cancel(*cancelled)
	}
	return out, nil
}

// endDraft deletes a draft, cancelling its job if it is active (whose id it
// returns) and otherwise marking it picked up.
func (a *App) endDraft(tx store.Tx, d store.Draft) (*string, error) {
	var cancelled *string
	if d.JobID != nil {
		j, err := tx.GetAIJob(*d.JobID)
		switch {
		case errors.Is(err, store.ErrNotFound):
		case err != nil:
			return nil, err
		case activeJob(j.Status):
			now := a.clock()
			j.Status, j.FinishedAt, j.PickedUpAt = store.JobCancelled, &now, &now
			if err := tx.UpdateAIJob(&j); err != nil {
				return nil, err
			}
			cancelled = &j.ID
		default:
			if err := a.pickUpJob(tx, &j.ID); err != nil {
				return nil, err
			}
		}
	}
	_, err := tx.DeleteDraft(d.ID)
	return cancelled, err
}

// DeleteDraft discards a draft, cancelling its generation if one is
// running.
func (a *App) DeleteDraft(ctx context.Context, id string) error {
	var cancelled *string
	err := a.store.Write(ctx, func(tx store.Tx) error {
		d, err := tx.GetDraft(id)
		if err != nil {
			return notFoundAs(err, "draft")
		}
		cancelled, err = a.endDraft(tx, d)
		return err
	})
	if err != nil {
		return err
	}
	if cancelled != nil {
		a.aiQueue.Cancel(*cancelled)
	}
	return nil
}
