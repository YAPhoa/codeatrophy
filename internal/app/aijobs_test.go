package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/teststore"
)

func codeAnswer(ai.GenerateRequest) (any, error) {
	return map[string]any{"code": []map[string]string{{"language": "python", "starterCode": "sum", "prefix": "", "suffix": ""}}}, nil
}

const codeBody = `{"title":"A plus B","body":"Add two numbers.","languages":["python"],"origin":"/items/x/edit"}`

// waitJob polls a job until it has finished.
func (e *env) waitJob(t *testing.T, id string) app.AIJobDetail {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		j := must(e.app.GetAIJob(e.ctx, id))
		if j.Status != store.JobQueued && j.Status != store.JobRunning {
			return j
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s is still %s", id, j.Status)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// hold keeps every provider request running until release is closed or
// the request is cancelled, and counts the requests under way.
func (e *env) hold() (release chan struct{}, running *atomic.Int32) {
	release, running = make(chan struct{}), &atomic.Int32{}
	e.ai.Hold = func(ctx context.Context) error {
		running.Add(1)
		defer running.Add(-1)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return release, running
}

// A job outlives the request that started it, and its result is the body
// the synchronous endpoint used to answer with.
func TestAIJobRunsInTheBackground(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	p := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "sum"},
			"cases": []map[string]any{{"name": "n", "rationale": "r", "stdin": "7 7", "predictedStdout": "14"}}}, nil
	}
	ctx, cancel := context.WithCancel(e.ctx)
	job := must(e.app.StartAIJob(ctx, app.JobTestCases, p.ID, json.RawMessage(`{"count":1,"origin":"/items/`+p.ID+`/tests/generate"}`)))
	cancel() // the client goes away at once
	if job.Status != store.JobQueued || job.Kind != app.JobTestCases || *job.ItemID != p.ID || job.Title != "A plus B" ||
		*job.Origin != "/items/"+p.ID+"/tests/generate" || job.DraftID != nil {
		t.Errorf("started: %+v", job)
	}
	done := e.waitJob(t, job.ID)
	var res app.GenerateTestCasesResponse
	if err := json.Unmarshal(done.Result, &res); err != nil || done.Status != store.JobSucceeded || len(res.Cases) != 1 ||
		!res.Cases[0].Verified || res.Usage.LogID == nil || done.StartedAt == nil || done.FinishedAt == nil {
		t.Fatalf("finished: %+v %s %v", done.AIJob, done.Result, err)
	}
	if !strings.Contains(string(done.Request), `"count":1`) {
		t.Errorf("request: %s", done.Request)
	}
	if l := must(e.app.ListAIJobs(e.ctx, app.AIJobQuery{})); len(l.Items) != 1 || l.Items[0].PickedUp {
		t.Errorf("listed: %+v", l)
	}
	picked := must(e.app.PickUpAIJob(e.ctx, job.ID))
	if !picked.PickedUp || string(picked.Result) != string(done.Result) {
		t.Errorf("picked up: %+v", picked.AIJob)
	}
	must(e.app.PickUpAIJob(e.ctx, job.ID))
	if l := must(e.app.ListAIJobs(e.ctx, app.AIJobQuery{})); len(l.Items) != 0 {
		t.Errorf("a picked-up job is listed: %+v", l)
	}
	if l := must(e.app.ListAIJobs(e.ctx, app.AIJobQuery{PickedUp: true, ItemID: p.ID, Kind: app.JobTestCases})); len(l.Items) != 1 {
		t.Errorf("picked-up jobs: %+v", l)
	}
	if err := e.app.DismissAIJob(e.ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	_, err := e.app.GetAIJob(e.ctx, job.ID)
	wantCode(t, err, app.CodeNotFound)
	wantCode(t, e.app.DismissAIJob(e.ctx, job.ID), app.CodeNotFound)
}

// What the endpoints refused up front is still refused before a job
// exists; what can only fail while generating fails the job.
func TestAIJobErrors(t *testing.T) {
	e := newEnv(t)
	_, err := e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody))
	wantCode(t, err, app.CodeAIUnavailable)
	e.enableAI(t)
	for _, c := range []struct {
		kind, item, body string
		want             app.Code
	}{
		{app.JobCode, "", `{"body":"x","languages":["cobol"]}`, app.CodeValidation},
		{app.JobCode, "", `{"body":"x","languages":"python"}`, app.CodeValidation},
		{app.JobCode, "", `{"body":"x","languages":["python"],"origin":7}`, app.CodeValidation},
		{app.JobCode, "", `{"body":"x","languages":["python"],"origin":"a\nb"}`, app.CodeValidation},
		{app.JobCode, "", `{"body":"x","languages":["python"],"origin":"` + strings.Repeat("o", 2001) + `"}`, app.CodeValidation},
		{app.JobCode, "", `[1]`, app.CodeBadRequest},
		{app.JobCode, "", `{"body":`, app.CodeBadRequest},
		{app.JobTestCases, "nope", `{}`, app.CodeNotFound},
		{app.JobDraft, "", `{"text":"x"}`, app.CodeBadRequest},
	} {
		if _, err := e.app.StartAIJob(e.ctx, c.kind, c.item, json.RawMessage(c.body)); code(err) != c.want {
			t.Errorf("%s %s: %v, want %s", c.kind, c.body, err, c.want)
		}
	}
	if l := must(e.app.ListAIJobs(e.ctx, app.AIJobQuery{})); len(l.Items) != 0 {
		t.Errorf("refused requests made jobs: %+v", l)
	}
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return nil, ai.Errorf(500, "provider exploded") }
	job := must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody)))
	done := e.waitJob(t, job.ID)
	if done.Status != store.JobFailed || done.Error == nil || done.Error.Code != app.CodeUpstream || done.Result != nil {
		t.Errorf("failed job: %+v", done.AIJob)
	}
	// The item goes away while the job waits.
	p := e.problem(t, "")
	release, running := e.hold()
	blockers := []string{must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody))).ID,
		must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody))).ID}
	waitFor(t, "two running jobs", func() bool { return running.Load() == 2 })
	waiting := must(e.app.StartAIJob(e.ctx, app.JobTestCases, p.ID, json.RawMessage(`{}`)))
	if err := e.app.DeleteItem(e.ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	close(release)
	for _, id := range blockers {
		e.waitJob(t, id)
	}
	if done := e.waitJob(t, waiting.ID); done.Status != store.JobFailed || done.Error.Code != app.CodeNotFound {
		t.Errorf("a job whose item was deleted: %+v", done.AIJob)
	}
	if _, err := e.app.ListAIJobs(e.ctx, app.AIJobQuery{Kind: "chat"}); code(err) != app.CodeBadRequest {
		t.Errorf("unknown kind: %v", err)
	}
}

// At most AIWorkers jobs run at once, the others wait in order; at most
// MaxActiveJobs may be active.
func TestAIJobWorkerLimitAndActiveCap(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.Respond = codeAnswer
	release, running := e.hold()
	var ids []string
	for range app.MaxActiveJobs {
		ids = append(ids, must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody))).ID)
	}
	waitFor(t, "two running jobs", func() bool { return running.Load() == 2 })
	time.Sleep(20 * time.Millisecond)
	if n := running.Load(); n != 2 {
		t.Fatalf("%d requests under way with two workers", n)
	}
	active := must(e.app.ListAIJobs(e.ctx, app.AIJobQuery{Active: true}))
	queued := 0
	for _, j := range active.Items {
		if j.Status == store.JobQueued {
			queued++
		}
	}
	if len(active.Items) != app.MaxActiveJobs || queued != app.MaxActiveJobs-2 {
		t.Errorf("%d active, %d queued", len(active.Items), queued)
	}
	_, err := e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody))
	wantCode(t, err, app.CodeConflict)
	close(release)
	var last time.Time
	for _, id := range ids {
		j := e.waitJob(t, id)
		if j.Status != store.JobSucceeded {
			t.Fatalf("job %s: %+v", id, j.AIJob)
		}
		if j.StartedAt.Before(last) {
			t.Errorf("job %s started out of order", id)
		}
		last = *j.StartedAt
	}
}

// Cancelling a running job aborts its provider request, which the AI log
// records as cancelled; a queued one never runs; a finished one stays.
func TestAIJobCancel(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.Respond = codeAnswer
	release, running := e.hold()
	defer close(release)
	a := must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody)))
	b := must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody)))
	waitFor(t, "two running jobs", func() bool { return running.Load() == 2 })
	c := must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody)))
	if got := must(e.app.CancelAIJob(e.ctx, c.ID)); got.Status != store.JobCancelled || got.FinishedAt == nil {
		t.Errorf("cancelled while queued: %+v", got)
	}
	if got := must(e.app.CancelAIJob(e.ctx, a.ID)); got.Status != store.JobCancelled {
		t.Errorf("cancelled while running: %+v", got)
	}
	waitFor(t, "the cancelled request to end", func() bool { return running.Load() == 1 })
	waitFor(t, "a cancelled log entry", func() bool {
		return e.logPage(t, app.AILogQuery{Status: "cancelled"}).Total == 1
	})
	// Dismissing a running job cancels it too.
	if err := e.app.DismissAIJob(e.ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the dismissed request to end", func() bool { return running.Load() == 0 })
	time.Sleep(20 * time.Millisecond)
	for _, id := range []string{a.ID, c.ID} {
		if j := must(e.app.GetAIJob(e.ctx, id)); j.Status != store.JobCancelled || j.Result != nil {
			t.Errorf("job %s: %+v", id, j.AIJob)
		}
	}
	if n := len(e.ai.Requests()); n != 2 {
		t.Errorf("%d provider requests; the queued job ran", n)
	}
	_, err := e.app.PickUpAIJob(e.ctx, "nope")
	wantCode(t, err, app.CodeNotFound)
	e.ai.Hold = nil
	d := must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody)))
	if j := must(e.app.CancelAIJob(e.ctx, d.ID)); j.Status == store.JobCancelled {
		// Cancelled before it finished, which is allowed; nothing more to see.
		return
	}
	done := e.waitJob(t, d.ID)
	if got := must(e.app.CancelAIJob(e.ctx, d.ID)); got.Status != done.Status {
		t.Errorf("cancelling a finished job changed it: %+v", got)
	}
}

// A job that is active cannot be picked up.
func TestAIJobPickUpWhileActive(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.Respond = codeAnswer
	release, running := e.hold()
	defer close(release)
	j := must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody)))
	waitFor(t, "the job to run", func() bool { return running.Load() == 1 })
	_, err := e.app.PickUpAIJob(e.ctx, j.ID)
	wantCode(t, err, app.CodeConflict)
}

// On start, jobs left running by a previous process fail as interrupted,
// queued ones run, and old finished jobs are pruned.
func TestAIJobsAfterARestart(t *testing.T) {
	db := teststore.Open(t)
	now := time.Now().UTC().Truncate(time.Second)
	ago := func(d time.Duration) *time.Time { v := now.Add(-d); return &v }
	jobs := []store.AIJob{
		{ID: "running", CreatedAt: now, Kind: app.JobCode, Status: store.JobRunning, Request: codeBody, StartedAt: &now},
		{ID: "queued", CreatedAt: now, Kind: app.JobCode, Status: store.JobQueued, Request: codeBody},
		{ID: "old", CreatedAt: *ago(80 * time.Hour), Kind: app.JobCode, Status: store.JobSucceeded, Request: "{}",
			FinishedAt: ago(73 * time.Hour)},
		{ID: "recent", CreatedAt: *ago(70 * time.Hour), Kind: app.JobCode, Status: store.JobFailed, Request: "{}",
			FinishedAt: ago(70 * time.Hour)},
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		for i := range jobs {
			if err := tx.InsertAIJob(&jobs[i]); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, func(o *app.Options) { o.Store = db })
	e.enableAI(t)
	e.ai.Respond = codeAnswer
	if j := must(e.app.GetAIJob(e.ctx, "running")); j.Status != store.JobFailed || j.Error.Code != app.CodeInterrupted ||
		!strings.Contains(j.Error.Message, "restarted") || j.FinishedAt == nil {
		t.Errorf("interrupted job: %+v", j.AIJob)
	}
	// The queued job ran (with AI off it fails; what matters is that it ran).
	if j := e.waitJob(t, "queued"); j.StartedAt == nil {
		t.Errorf("queued job: %+v", j.AIJob)
	}
	_, err := e.app.GetAIJob(e.ctx, "old")
	wantCode(t, err, app.CodeNotFound)
	must(e.app.GetAIJob(e.ctx, "recent"))
}

// The server keeps the newest MaxKeptJobs jobs, and any older one still
// active.
func TestAIJobsAreCapped(t *testing.T) {
	db := teststore.Open(t)
	now := time.Now().UTC().Truncate(time.Second)
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		for i := range app.MaxKeptJobs + 5 {
			at := now.Add(time.Duration(i-app.MaxKeptJobs-5) * time.Second)
			j := store.AIJob{ID: fmt.Sprintf("job%03d", i), CreatedAt: at, Kind: app.JobCode, Status: store.JobSucceeded,
				Request: "{}", FinishedAt: &at}
			if i == 0 {
				j.Status, j.FinishedAt = store.JobQueued, nil
			}
			if err := tx.InsertAIJob(&j); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, func(o *app.Options) { o.Store = db })
	// job001–job004 fall outside the newest 200; job000 is too, but it is
	// still queued.
	for _, id := range []string{"job001", "job004"} {
		if _, err := e.app.GetAIJob(e.ctx, id); code(err) != app.CodeNotFound {
			t.Errorf("%s kept: %v", id, err)
		}
	}
	must(e.app.GetAIJob(e.ctx, "job000"))
	must(e.app.GetAIJob(e.ctx, "job005"))
}

// Stopping the server ends running jobs without finishing them, so the
// next start reports them as interrupted.
func TestAIJobStopLeavesRunningJobs(t *testing.T) {
	db := teststore.Open(t)
	e := newEnv(t, func(o *app.Options) { o.Store = db })
	e.enableAI(t)
	e.ai.Respond = codeAnswer
	_, running := e.hold()
	j := must(e.app.StartAIJob(e.ctx, app.JobCode, "", json.RawMessage(codeBody)))
	waitFor(t, "the job to run", func() bool { return running.Load() == 1 })
	e.app.Stop()
	var got store.AIJob
	if err := db.Read(context.Background(), func(tx store.Tx) (err error) { got, err = tx.GetAIJob(j.ID); return err }); err != nil {
		t.Fatal(err)
	}
	if got.Status != store.JobRunning {
		t.Errorf("after stopping: %s", got.Status)
	}
	next := app.New(app.Options{Store: db})
	if err := next.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer next.Stop()
	if d := must(next.GetAIJob(context.Background(), j.ID)); d.Status != store.JobFailed || d.Error.Code != app.CodeInterrupted {
		t.Errorf("after the restart: %+v", d.AIJob)
	}
}

var _ = domain.Some[string]
