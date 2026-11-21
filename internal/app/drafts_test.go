package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

func (e *env) newDraft(t *testing.T, js string) (app.Draft, bool) {
	t.Helper()
	d, started, err := e.app.CreateDraft(e.ctx, decodeInto[app.NewDraftInput](t, js))
	if err != nil {
		t.Fatal(err)
	}
	return d, started
}

// waitDraft waits for a draft's generation to finish and returns the draft.
func (e *env) waitDraft(t *testing.T, id string) app.Draft {
	t.Helper()
	var d app.Draft
	waitFor(t, "the draft's generation", func() bool {
		d = must(e.app.GetDraft(e.ctx, id))
		return d.State != app.DraftDrafting
	})
	return d
}

func patch(t *testing.T, js string) app.DraftPatch { return decodeInto[app.DraftPatch](t, js) }

// A capture draft started with a generation receives its outcome with no
// client watching, and the client adopts it later.
func TestDraftGenerationArrivesWithoutAClient(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	ctx, cancel := context.WithCancel(e.ctx)
	d, started, err := e.app.CreateDraft(ctx, decodeInto[app.NewDraftInput](t,
		`{"kind":"capture","generate":{"text":"two sum, array + target","origin":"/drafts/x"}}`))
	cancel()
	if err != nil || !started || d.State != app.DraftDrafting || d.Job == nil || *d.Job.DraftID != d.ID ||
		d.Job.Kind != app.JobDraft || d.Title != "two sum, array + target" || d.Revision != 1 || d.Edited {
		t.Fatalf("started: %+v %v", d, err)
	}
	if !strings.Contains(string(d.Request), "two sum") || d.Generation != nil || d.Content != nil {
		t.Errorf("documents: %s %s %s", d.Request, d.Generation, d.Content)
	}
	done := e.waitDraft(t, d.ID)
	var gen app.DraftResponse
	if err := json.Unmarshal(done.Generation, &gen); err != nil || gen.Draft.Title != "Two Sum" {
		t.Fatalf("generation: %s %v", done.Generation, err)
	}
	if done.State != app.DraftReady || done.GenerationSeq != 1 || done.BasedOn != 0 || done.Title != "Two Sum" ||
		done.Revision != 2 || done.Job.Status != store.JobSucceeded || done.Job.PickedUp || done.Error != nil {
		t.Errorf("finished: %+v", done.DraftSummary)
	}
	// The job is listed as a notification until the draft adopts it.
	if l := must(e.app.ListAIJobs(e.ctx, app.AIJobQuery{DraftID: d.ID})); len(l.Items) != 1 {
		t.Errorf("notifications: %+v", l)
	}
	adopted := must(e.app.UpdateDraft(e.ctx, d.ID, patch(t,
		`{"content":{"form":{"title":"Two Sum"}},"basedOn":1,"expectedRevision":2}`)))
	if adopted.State != app.DraftReady || adopted.BasedOn != 1 || !adopted.Job.PickedUp ||
		adopted.Revision != 3 || string(adopted.Content) != `{"form":{"title":"Two Sum"}}` {
		t.Errorf("adopted: %+v %s", adopted.DraftSummary, adopted.Content)
	}
	if l := must(e.app.ListAIJobs(e.ctx, app.AIJobQuery{})); len(l.Items) != 0 {
		t.Errorf("an adopted job is still a notification: %+v", l)
	}
	edited := must(e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"edited":true}`)))
	if edited.State != app.DraftEdited {
		t.Errorf("edited: %+v", edited.DraftSummary)
	}
	l := must(e.app.ListDrafts(e.ctx, app.DraftQuery{}))
	if len(l.Items) != 1 || l.Items[0].State != app.DraftEdited || l.Items[0].Job == nil {
		t.Errorf("list: %+v", l)
	}
}

// A generation's request is kept on the draft as sent, test case count
// included, and a revision may ask for one too.
func TestDraftKeepsTheTestCaseCount(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	d, _ := e.newDraft(t, `{"kind":"capture","generate":{"text":"two sum","testCaseCount":8}}`)
	var req map[string]any
	if json.Unmarshal(d.Request, &req) != nil || req["testCaseCount"] != float64(8) {
		t.Errorf("request: %s", d.Request)
	}
	e.waitDraft(t, d.ID)
	if !strings.Contains(e.ai.Last().System, "holds at least 8 test cases:") {
		t.Errorf("the generation did not ask for 8:\n%s", e.ai.Last().System)
	}
	revised := must(e.app.GenerateDraft(e.ctx, d.ID, json.RawMessage(
		`{"text":"two sum","testCaseCount":12,"instruction":"harder","previousDraft":{"title":"Two Sum"}}`)))
	if json.Unmarshal(revised.Request, &req) != nil || req["testCaseCount"] != float64(12) {
		t.Errorf("revision request: %s", revised.Request)
	}
	e.waitDraft(t, d.ID)
	if s := e.ai.Last(); !strings.Contains(s.System, "holds at least 12 test cases:") || !strings.Contains(s.User, "This is a revision") {
		t.Errorf("revision:\n%s\n%s", s.System, s.User)
	}
}

// Autosaves name the revision they were based on; a stale one is refused
// with the current revision.
func TestDraftRevisions(t *testing.T) {
	e := newEnv(t)
	d, started := e.newDraft(t, `{"kind":"capture","content":{"form":{}}}`)
	if started || d.State != app.DraftEdited || !d.Edited || d.Title != "Untitled draft" || d.Job != nil {
		t.Errorf("hand-written: %+v", d.DraftSummary)
	}
	must(e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"content":{"form":{"a":1}},"expectedRevision":1}`)))
	_, err := e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"content":{"form":{"a":2}},"expectedRevision":1}`))
	if e := wantCode(t, err, app.CodeConflict); e.Fields["revision"] != 2 {
		t.Errorf("conflict fields: %+v", e.Fields)
	}
	if got := must(e.app.GetDraft(e.ctx, d.ID)); string(got.Content) != `{"form":{"a":1}}` {
		t.Errorf("a refused update was written: %s", got.Content)
	}
	titled := must(e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"title":"  My problem "}`)))
	if titled.Title != "My problem" {
		t.Errorf("title: %q", titled.Title)
	}
	if untitled := must(e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"title":null}`))); untitled.Title != "Untitled draft" {
		t.Errorf("title cleared: %q", untitled.Title)
	}
	for _, bad := range []string{`{"content":[1]}`, `{"content":"x"}`, `{"title":"a\nb"}`, `{"basedOn":1}`,
		`{"basedOn":-1}`, `{"edited":null}`, `{"title":"` + strings.Repeat("t", domain.MaxTitleChars+1) + `"}`} {
		if _, err := e.app.UpdateDraft(e.ctx, d.ID, patch(t, bad)); code(err) != app.CodeValidation {
			t.Errorf("%s: %v", bad, err)
		}
	}
	_, err = e.app.UpdateDraft(e.ctx, "nope", patch(t, `{}`))
	wantCode(t, err, app.CodeNotFound)
	_, err = e.app.RetryDraft(e.ctx, d.ID)
	wantCode(t, err, app.CodeValidation)
	empty, _ := e.newDraft(t, `{"kind":"capture"}`)
	if empty.State != app.DraftNew || empty.Edited {
		t.Errorf("empty draft: %+v", empty.DraftSummary)
	}
}

func TestDraftCreateValidation(t *testing.T) {
	e := newEnv(t)
	p := e.problem(t, "")
	for _, c := range []struct {
		js   string
		want app.Code
	}{
		{`{}`, app.CodeValidation},
		{`{"kind":"note"}`, app.CodeValidation},
		{`{"kind":"variant"}`, app.CodeValidation},
		{`{"kind":"variant","variantOf":"nope"}`, app.CodeValidation},
		{`{"kind":"capture","variantOf":"` + p.ID + `"}`, app.CodeValidation},
		{`{"kind":"capture","content":[]}`, app.CodeValidation},
		// AI features are off.
		{`{"kind":"capture","generate":{"text":"x"}}`, app.CodeAIUnavailable},
	} {
		if _, _, err := e.app.CreateDraft(e.ctx, decodeInto[app.NewDraftInput](t, c.js)); code(err) != c.want {
			t.Errorf("%s: %v, want %s", c.js, err, c.want)
		}
	}
	e.enableAI(t)
	_, _, err := e.app.CreateDraft(e.ctx, decodeInto[app.NewDraftInput](t, `{"kind":"capture","generate":{"text":""}}`))
	if e := wantCode(t, err, app.CodeValidation); e.Fields["text"] == nil {
		t.Errorf("a generate request's fields are unprefixed: %+v", e.Fields)
	}
	if l := must(e.app.ListDrafts(e.ctx, app.DraftQuery{})); len(l.Items) != 0 {
		t.Errorf("refused drafts were created: %+v", l)
	}
	_, err = e.app.ListDrafts(e.ctx, app.DraftQuery{Kind: "note"})
	wantCode(t, err, app.CodeBadRequest)
	_, err = e.app.GenerateDraft(e.ctx, "nope", json.RawMessage(`{"text":"x"}`))
	wantCode(t, err, app.CodeNotFound)
	_, err = e.app.RetryDraft(e.ctx, "nope")
	wantCode(t, err, app.CodeNotFound)
	_, err = e.app.SaveDraft(e.ctx, "nope", decodeInto[app.DraftSaveInput](t, `{"item":{"type":"reading","title":"T"}}`))
	wantCode(t, err, app.CodeNotFound)
}

// A generation of an existing draft is refused, leaving the draft as it
// was, when its request is invalid, AI features are off or too many jobs
// are active.
func TestGenerateDraftRefusals(t *testing.T) {
	e := newEnv(t)
	d, _ := e.newDraft(t, `{"kind":"capture","content":{"form":{}}}`)
	_, err := e.app.GenerateDraft(e.ctx, d.ID, json.RawMessage(`{"text":"x"}`))
	wantCode(t, err, app.CodeAIUnavailable)
	e.enableAI(t)
	_, err = e.app.GenerateDraft(e.ctx, d.ID, json.RawMessage(`{"text":""}`))
	wantField(t, err, "text")
	_, err = e.app.GenerateDraft(e.ctx, d.ID, json.RawMessage(`{"text":"x","origin":7}`))
	wantField(t, err, "origin")
	release, _ := e.hold()
	defer close(release)
	for range app.MaxActiveJobs {
		must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody)))
	}
	_, err = e.app.GenerateDraft(e.ctx, d.ID, json.RawMessage(`{"text":"x"}`))
	wantCode(t, err, app.CodeConflict)
	if got := must(e.app.GetDraft(e.ctx, d.ID)); got.Revision != d.Revision || got.Job != nil || got.Request != nil {
		t.Errorf("a refused generation changed the draft: %+v %s", got.DraftSummary, got.Request)
	}
}

// A failed generation leaves its error on the draft until it is retried;
// a revision replaces the generation.
func TestDraftFailureRetryAndRevise(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	fail := true
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		if fail {
			return nil, ai.Errorf(500, "provider exploded")
		}
		return draftJSON(), nil
	}
	d, _ := e.newDraft(t, `{"kind":"capture","generate":{"text":"two sum"}}`)
	failed := e.waitDraft(t, d.ID)
	if failed.State != app.DraftFailed || failed.Error == nil || failed.Error.Code != app.CodeUpstream ||
		failed.Generation != nil || failed.Title != "two sum" {
		t.Fatalf("failed: %+v", failed.DraftSummary)
	}
	// Writing content over a failed generation clears its error.
	edited := must(e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"content":{"form":{}}}`)))
	if edited.State != app.DraftEdited || edited.Error != nil {
		t.Errorf("content over a failure: %+v", edited.DraftSummary)
	}
	fail = false
	retried := must(e.app.RetryDraft(e.ctx, d.ID))
	if retried.State != app.DraftDrafting || retried.Error != nil || retried.Job.ID == failed.Job.ID {
		t.Errorf("retried: %+v", retried.DraftSummary)
	}
	if prev := must(e.app.GetAIJob(e.ctx, failed.Job.ID)); !prev.PickedUp {
		t.Error("the failed job should be picked up by the retry")
	}
	ready := e.waitDraft(t, d.ID)
	if ready.State != app.DraftReady || ready.GenerationSeq != 1 {
		t.Fatalf("ready: %+v", ready.DraftSummary)
	}
	must(e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"basedOn":1,"content":{"form":1},"edited":true}`)))
	revised := draftJSON()
	revised["title"] = "Two Sum, revised"
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return revised, nil }
	must(e.app.GenerateDraft(e.ctx, d.ID, json.RawMessage(
		`{"text":"two sum","previousDraft":{"type":"problem","title":"Two Sum"},"instruction":"harder"}`)))
	done := e.waitDraft(t, d.ID)
	if done.State != app.DraftReady || done.GenerationSeq != 2 || done.BasedOn != 1 || done.Title != "Two Sum, revised" ||
		!strings.Contains(string(done.Request), "harder") || string(done.Content) != `{"form":1}` {
		t.Errorf("revised: %+v %s", done.DraftSummary, done.Request)
	}
	if !strings.Contains(e.ai.Last().User, "harder") {
		t.Error("the revision's instruction was not sent")
	}
	// A dismissed job leaves the draft without one; it can still go.
	if err := e.app.DismissAIJob(e.ctx, done.Job.ID); err != nil {
		t.Fatal(err)
	}
	if got := must(e.app.GetDraft(e.ctx, d.ID)); got.Job != nil || got.State != app.DraftReady {
		t.Errorf("after dismissing its job: %+v", got.DraftSummary)
	}
	if err := e.app.DeleteDraft(e.ctx, d.ID); err != nil {
		t.Errorf("deleting a draft whose job was dismissed: %v", err)
	}
}

// One generation at a time; deleting a draft cancels its generation, whose
// outcome then goes nowhere.
func TestDraftCancelAndDelete(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	release, running := e.hold()
	d, _ := e.newDraft(t, `{"kind":"capture","generate":{"text":"x"}}`)
	waitFor(t, "the generation to run", func() bool { return running.Load() == 1 })
	_, err := e.app.GenerateDraft(e.ctx, d.ID, json.RawMessage(`{"text":"y"}`))
	wantCode(t, err, app.CodeConflict)
	_, err = e.app.RetryDraft(e.ctx, d.ID)
	wantCode(t, err, app.CodeConflict)
	// Cancelling through the job leaves the draft as it was.
	must(e.app.CancelAIJob(e.ctx, d.Job.ID))
	waitFor(t, "the request to end", func() bool { return running.Load() == 0 })
	if got := must(e.app.GetDraft(e.ctx, d.ID)); got.State != app.DraftNew || got.Error != nil || got.Job.Status != store.JobCancelled {
		t.Errorf("cancelled: %+v", got.DraftSummary)
	}
	again := must(e.app.RetryDraft(e.ctx, d.ID))
	waitFor(t, "the retry to run", func() bool { return running.Load() == 1 })
	if err := e.app.DeleteDraft(e.ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the request to end", func() bool { return running.Load() == 0 })
	if j := must(e.app.GetAIJob(e.ctx, again.Job.ID)); j.Status != store.JobCancelled || !j.PickedUp {
		t.Errorf("job of a deleted draft: %+v", j.AIJob)
	}
	wantCode(t, e.app.DeleteDraft(e.ctx, d.ID), app.CodeNotFound)
	_, err = e.app.GetDraft(e.ctx, d.ID)
	wantCode(t, err, app.CodeNotFound)
	close(release)
}

// Saving creates the item and removes the draft together; a variant
// draft's item is a variant of its original.
func TestDraftSave(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	orig := e.problem(t, "")
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	v, _ := e.newDraft(t, `{"kind":"variant","variantOf":"`+orig.ID+`","generate":{"mode":"similar"}}`)
	if v.Title != "Variant of A plus B" || v.Job.Kind != app.JobVariant || *v.Job.ItemID != orig.ID || *v.VariantOf != orig.ID {
		t.Errorf("variant draft: %+v %+v", v.DraftSummary, v.Job)
	}
	v = e.waitDraft(t, v.ID)
	if v.State != app.DraftReady {
		t.Fatalf("variant: %+v", v.DraftSummary)
	}
	if l := must(e.app.ListDrafts(e.ctx, app.DraftQuery{VariantOf: orig.ID})); len(l.Items) != 1 {
		t.Errorf("variants of the original: %+v", l)
	}
	// An invalid item leaves the draft.
	_, err := e.app.SaveDraft(e.ctx, v.ID, decodeInto[app.DraftSaveInput](t, `{"item":{"type":"problem"}}`))
	wantCode(t, err, app.CodeValidation)
	_, err = e.app.SaveDraft(e.ctx, v.ID, decodeInto[app.DraftSaveInput](t,
		`{"item":{"type":"reading","title":"T"},"expectedRevision":1}`))
	wantCode(t, err, app.CodeConflict)
	it := must(e.app.SaveDraft(e.ctx, v.ID, decodeInto[app.DraftSaveInput](t,
		fmt.Sprintf(`{"item":{"type":"reading","title":"Saved"},"expectedRevision":%d}`, v.Revision))))
	if it.Title != "Saved" || it.VariantOf == nil || *it.VariantOf != orig.ID {
		t.Errorf("saved: %+v", it)
	}
	_, err = e.app.GetDraft(e.ctx, v.ID)
	wantCode(t, err, app.CodeNotFound)
	if j := must(e.app.GetAIJob(e.ctx, v.Job.ID)); !j.PickedUp {
		t.Error("saving picks the job up")
	}
	// A failed insert (a collection that does not exist) keeps the draft.
	c, _ := e.newDraft(t, `{"kind":"capture","content":{}}`)
	_, err = e.app.SaveDraft(e.ctx, c.ID, decodeInto[app.DraftSaveInput](t,
		`{"item":{"type":"reading","title":"T","collectionIds":["nope"]}}`))
	if err == nil {
		t.Fatal("saved into a collection that does not exist")
	}
	must(e.app.GetDraft(e.ctx, c.ID))
	saved := must(e.app.SaveDraft(e.ctx, c.ID, decodeInto[app.DraftSaveInput](t, `{"item":{"type":"reading","title":"Mine"}}`)))
	if saved.VariantOf != nil {
		t.Errorf("a capture draft saved as a variant: %+v", saved)
	}
	if l := must(e.app.ListDrafts(e.ctx, app.DraftQuery{})); len(l.Items) != 0 {
		t.Errorf("drafts left: %+v", l)
	}
}

// Saving a draft whose generation is still running cancels it.
func TestDraftSaveCancelsItsGeneration(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	release, running := e.hold()
	defer close(release)
	d, _ := e.newDraft(t, `{"kind":"capture","generate":{"text":"x"}}`)
	waitFor(t, "the generation to run", func() bool { return running.Load() == 1 })
	must(e.app.SaveDraft(e.ctx, d.ID, decodeInto[app.DraftSaveInput](t, `{"item":{"type":"reading","title":"T"}}`)))
	waitFor(t, "the request to end", func() bool { return running.Load() == 0 })
	if j := must(e.app.GetAIJob(e.ctx, d.Job.ID)); j.Status != store.JobCancelled {
		t.Errorf("job: %+v", j.AIJob)
	}
}

// An instance keeps at most MaxDrafts drafts.
func TestDraftLimit(t *testing.T) {
	e := newEnv(t)
	now := time.Now().UTC()
	if err := e.db.Write(e.ctx, func(tx store.Tx) error {
		for i := range app.MaxDrafts {
			d := store.Draft{ID: fmt.Sprintf("d%03d", i), CreatedAt: now, UpdatedAt: now, Kind: "capture", Title: "x", Revision: 1}
			if err := tx.InsertDraft(&d); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, _, err := e.app.CreateDraft(e.ctx, decodeInto[app.NewDraftInput](t, `{"kind":"capture"}`))
	wantCode(t, err, app.CodeConflict)
}
