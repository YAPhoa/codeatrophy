package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/ai/aitest"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/judge/judgetest"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/teststore"
)

type env struct {
	app    *app.App
	engine *judgetest.Engine
	ai     *aitest.Provider
	db     store.Store
	ctx    context.Context
}

type option func(*app.Options)

func withoutEngine() option { return func(o *app.Options) { o.Engine = nil } }

func withAIEnv(e app.AIEnv) option { return func(o *app.Options) { o.AIEnv = e } }

func newEnv(t *testing.T, opts ...option) *env {
	t.Helper()
	ctx := context.Background()
	db := teststore.Open(t)
	box, _ := secrets.NewBox(bytes.Repeat([]byte{3}, 32))
	engine := judgetest.New("python", "cpp")
	fake := &aitest.Provider{}
	model := "default-model"
	o := app.Options{
		Store:  db,
		Engine: engine,
		Providers: map[string]ai.Factory{
			ai.ProviderAnthropic:        fake.Factory(),
			ai.ProviderGemini:           fake.Factory(),
			ai.ProviderOpenAICompatible: fake.Factory(),
		},
		ProviderDefaults: map[string]app.ProviderDefaults{
			ai.ProviderAnthropic:        {Model: &model, BaseURL: "https://api.anthropic.com"},
			ai.ProviderGemini:           {BaseURL: "https://generativelanguage.googleapis.com/v1beta"},
			ai.ProviderOpenAICompatible: {BaseURL: "https://api.openai.com/v1"},
		},
		Secrets:          box,
		Limits:           domain.Limits{MaxImportBytes: 10 << 20, MaxSourceBytes: 64 << 10},
		JudgeWorkers:     2,
		JudgeConcurrency: 2,
		Version:          "test",
		HealthInterval:   time.Hour,
	}
	for _, opt := range opts {
		opt(&o)
	}
	a := app.New(o)
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if o.Store == db {
		// Tests start without the built-in style presets, which have tests of
		// their own in the store.
		for _, p := range must(a.ListStylePresets(ctx)).Items {
			if err := a.DeleteStylePreset(ctx, p.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Cleanup(a.Stop) // before the store closes
	e := &env{app: a, ai: fake, db: db, ctx: ctx}
	if o.Engine != nil {
		e.engine = engine
	}
	return e
}

// input decodes a JSON literal into an ItemInput, as the transports do.
func input(t *testing.T, js string) domain.ItemInput {
	t.Helper()
	var in domain.ItemInput
	if err := domain.DecodeJSON([]byte(js), &in); err != nil {
		t.Fatal(err)
	}
	return in
}

func decodeInto[T any](t *testing.T, js string) T {
	t.Helper()
	var v T
	if err := domain.DecodeJSON([]byte(js), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func code(err error) app.Code {
	if err == nil {
		return ""
	}
	return app.AsError(err).Code
}

func wantCode(t *testing.T, err error, want app.Code) *app.Error {
	t.Helper()
	if code(err) != want {
		t.Fatalf("got error %v (code %q), want %q", err, code(err), want)
	}
	return app.AsError(err)
}

// must returns v, failing the test (by panicking) on error. It takes the
// two results of a call directly: must(f()).
func must[T any](v T, err error) T {
	if err != nil {
		panic(fmt.Sprintf("unexpected error: %v", err))
	}
	return v
}

func (e *env) problem(t *testing.T, extra string) domain.Item {
	t.Helper()
	js := `{"type":"problem","title":"A plus B","testCases":[
		{"name":"s1","stdin":"1 2","expectedStdout":"3","isSample":true},
		{"name":"h1","stdin":"5 5","expectedStdout":"10"}]` + extra + `}`
	return must(e.app.CreateItem(e.ctx, input(t, js)))
}

func TestCreateItemDefaultsAndValidation(t *testing.T) {
	e := newEnv(t)
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"  CAP theorem  ","tags":["Distributed"," cap "]}`)))
	if it.Title != "CAP theorem" || it.Status != domain.StatusTodo || it.Revision != 1 || it.Problem != nil ||
		strings.Join(it.Tags, ",") != "cap,distributed" || it.RawInput != nil || it.Difficulty != nil {
		t.Errorf("defaults: %+v", it)
	}
	p := e.problem(t, "")
	if p.Problem == nil || p.Problem.TimeLimitMs != domain.DefaultTimeLimitMs || p.Problem.Compare != domain.CompareTokens ||
		p.TestCaseCount != 2 {
		t.Errorf("problem defaults: %+v %+v", p.ItemSummary, p.Problem)
	}

	ae := wantCode(t, must2(e.app.CreateItem(e.ctx, input(t, `{"title":"x"}`))), app.CodeValidation)
	if ae.Fields["type"] == nil {
		t.Errorf("fields: %v", ae.Fields)
	}
	ae = wantCode(t, must2(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"x","problem":{"timeLimitMs":50,"memoryLimitKb":1}}`))), app.CodeValidation)
	if ae.Fields["problem.timeLimitMs"] == nil || ae.Fields["problem.memoryLimitKb"] == nil {
		t.Errorf("fields: %v", ae.Fields)
	}
	wantCode(t, must2(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"x","testCases":[{"expectedStdout":""}]}`))), app.CodeValidation)
	wantCode(t, must2(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"x","variantOf":"nope"}`))), app.CodeValidation)
	wantCode(t, must2(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"x","collectionIds":["nope"]}`))), app.CodeValidation)
	wantCode(t, must2(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"x","testCases":[{"stdin":"1"}]}`))), app.CodeValidation)
}

func must2[T any](_ T, err error) error { return err }

func TestUpdateItemMergeAndRevision(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"summary":"s","source":{"url":"https://a.test","note":"n"}`)

	// Personal state does not change the revision.
	up := must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"status":"done","favorite":true,"notes":"mine","expectedRevision":1}`)))
	if up.Revision != 1 || up.Status != domain.StatusDone || !up.Favorite || up.Notes != "mine" {
		t.Errorf("personal update: rev %d %+v", up.Revision, up.ItemSummary)
	}
	// Content does; nested objects merge field by field; null clears.
	up = must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"title":"New","source":{"note":null},"problem":{"timeLimitMs":500},"difficulty":"hard"}`)))
	if up.Revision != 2 || up.Title != "New" || up.Source.Note != nil || up.Source.URL == nil || *up.Source.URL != "https://a.test" ||
		up.Problem.TimeLimitMs != 500 || up.Problem.MemoryLimitKb != domain.DefaultMemoryLimitKb || *up.Difficulty != domain.DifficultyHard {
		t.Errorf("merge: %+v %+v %+v", up.ItemSummary, up.Source, up.Problem)
	}
	// Stale expectedRevision is a conflict carrying the current revision.
	ae := wantCode(t, must2(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"title":"Stale","expectedRevision":1}`))), app.CodeConflict)
	if ae.Fields["revision"] != 2 {
		t.Errorf("conflict fields: %v", ae.Fields)
	}
	if cur := must(e.app.GetItem(e.ctx, it.ID)); cur.Title != "New" {
		t.Error("a conflicting write must not be applied")
	}
	wantCode(t, must2(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"type":"reading"}`))), app.CodeValidation)
	wantCode(t, must2(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"testCases":[]}`))), app.CodeValidation)
	wantCode(t, must2(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"title":null}`))), app.CodeValidation)
	wantCode(t, must2(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"variantOf":"`+it.ID+`"}`))), app.CodeValidation)
	wantCode(t, must2(e.app.UpdateItem(e.ctx, "missing", input(t, `{}`))), app.CodeNotFound)
}

func TestConcurrentEditorsConflict(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"body":"line one\nline two"`)
	// Two writers read revision 1.
	must(e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t,
		`{"field":"body","expectedRevision":1,"edits":[{"oldText":"one","newText":"1"}]}`)))
	_, err := e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t,
		`{"field":"body","expectedRevision":1,"edits":[{"oldText":"two","newText":"2"}]}`))
	wantCode(t, err, app.CodeConflict)
}

func TestRevisionAndUpdatedAtSemantics(t *testing.T) {
	clock := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	e := newEnv(t, func(o *app.Options) { o.Now = func() time.Time { return clock } })
	tick := func() { clock = clock.Add(time.Minute) }
	it := e.problem(t, `,"body":"text"`)
	created := it.UpdatedAt
	check := func(label string, wantRev int, wantMoved bool) {
		t.Helper()
		cur := must(e.app.GetItem(e.ctx, it.ID))
		if cur.Revision != wantRev {
			t.Errorf("%s: revision %d, want %d", label, cur.Revision, wantRev)
		}
		if moved := !cur.UpdatedAt.Equal(created); moved != wantMoved {
			t.Errorf("%s: updatedAt moved=%v, want %v", label, moved, wantMoved)
		}
		created = cur.UpdatedAt
	}
	tick()
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"status":"done","favorite":true,"notes":"n","rawInput":"r"}`)))
	check("personal state", 1, false)
	tick()
	col := must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"C"}`)))
	must(e.app.AddCollectionItems(e.ctx, col.ID, []string{it.ID}))
	check("membership", 1, false)
	tick()
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"body":"text","title":"A plus B"}`)))
	check("no-op update", 1, false)
	tick()
	must(e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t, `{"field":"notes","edits":[{"oldText":"n","newText":"m"}]}`)))
	check("notes edit", 1, false)
	tick()
	tc := must(e.app.AddTestCase(e.ctx, it.ID, decodeInto[domain.TestCaseInput](t, `{"expectedStdout":"x"}`)))
	check("test case added", 1, true)
	tick()
	must(e.app.UpdateTestCase(e.ctx, tc.ID, decodeInto[domain.TestCaseInput](t, `{"name":"renamed"}`)))
	check("test case updated", 1, true)
	tick()
	if err := e.app.DeleteTestCase(e.ctx, tc.ID); err != nil {
		t.Fatal(err)
	}
	check("test case deleted", 1, true)
	tick()
	must(e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t, `{"cases":[],"referenceSolution":{"language":"python","source":"sum"}}`)))
	check("reference solution via bulk", 2, true)
	tick()
	must(e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t, `{"cases":[],"referenceSolution":{"language":"python","source":"sum"}}`)))
	check("same reference solution again", 2, false)
	tick()
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"tags":["new"]}`)))
	check("content", 3, true)
	tick()
	e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"submit"}`)
	check("submission status side effects", 3, false)
	// The editor's revision survives its own test-case edits.
	cases := must(e.app.ListTestCases(e.ctx, it.ID))
	must(e.app.UpdateTestCase(e.ctx, cases.Items[0].ID, decodeInto[domain.TestCaseInput](t, `{"name":"x"}`)))
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"title":"Edited","expectedRevision":3}`)))
}

func TestTextNormalisation(t *testing.T) {
	e := newEnv(t)
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"T\r\n","body":"a\r\nb\rc","notes":"n\r\n",
		"testCases":[{"name":"x\r\ny","stdin":"1\r\n2\r","expectedStdout":"3\r\n"}]}`)))
	if it.Title != "T" || it.Body != "a\nb\nc" || it.Notes != "n\n" {
		t.Errorf("item text: %q %q %q", it.Title, it.Body, it.Notes)
	}
	tc := must(e.app.ListTestCases(e.ctx, it.ID)).Items[0]
	if tc.Name != "x\ny" || tc.Stdin != "1\r\n2\r" || tc.ExpectedStdout != "3\r\n" {
		t.Errorf("test case: %+v", tc)
	}
	// Edits match against the normalised text.
	got := must(e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t, `{"field":"body","edits":[{"oldText":"a\r\nb","newText":"x\r\ny"}]}`)))
	if got.Body != "x\ny\nc" {
		t.Errorf("edit: %q", got.Body)
	}
	p := must(e.app.CreateStylePreset(e.ctx, decodeInto[domain.StylePresetInput](t, `{"name":"S","instructions":"one\r\ntwo"}`)))
	if p.Instructions != "one\ntwo" {
		t.Errorf("preset: %q", p.Instructions)
	}
	c := must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"N","description":"d\r\ne"}`)))
	if c.Description != "d\ne" {
		t.Errorf("collection: %q", c.Description)
	}
}

func TestEditItemText(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"body":"1 ≤ n ≤ 100 and 1 ≤ k ≤ 100","notes":"todo"`)
	edit := func(js string) (domain.Item, error) {
		return e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t, js))
	}
	got := must(edit(`{"field":"body","edits":[{"oldText":"n ≤ 100","newText":"n ≤ 10^5"},{"oldText":"10^5 and","newText":"10^5, and"}]}`))
	if got.Body != "1 ≤ n ≤ 10^5, and 1 ≤ k ≤ 100" || got.Revision != 2 {
		t.Errorf("body %q rev %d", got.Body, got.Revision)
	}
	_, err := edit(`{"field":"body","edits":[{"oldText":"10^5","newText":"x"},{"oldText":"≤ 100x","newText":"y"}]}`)
	ae := wantCode(t, err, app.CodeValidation)
	if ae.Fields["edits.1"] == nil {
		t.Errorf("failing edit index not named: %v", ae.Fields)
	}
	_, err = edit(`{"field":"body","edits":[{"oldText":"≤","newText":"<="}]}`)
	ae = wantCode(t, err, app.CodeValidation)
	if !strings.Contains(ae.Fields["edits.0"].(string), "occurs") {
		t.Errorf("ambiguous edit: %v", ae.Fields)
	}
	if cur := must(e.app.GetItem(e.ctx, it.ID)); cur.Body != got.Body {
		t.Error("a failed edit must not write anything")
	}
	notes := must(edit(`{"field":"notes","edits":[{"oldText":"todo","newText":"done"}]}`))
	if notes.Notes != "done" {
		t.Errorf("notes edit: %q", notes.Notes)
	}
	_, err = edit(`{"field":"title","edits":[{"oldText":"a","newText":"b"}]}`)
	wantCode(t, err, app.CodeValidation)
}

func TestNotesLimit(t *testing.T) {
	e := newEnv(t, func(o *app.Options) { o.Limits.MaxNotesChars = 10 })
	if got := must(e.app.Meta(e.ctx)).Limits.MaxNotesChars; got != 10 {
		t.Errorf("meta maxNotesChars = %d, want the configured 10", got)
	}
	notesErr := func(err error) string {
		t.Helper()
		msg, _ := wantCode(t, err, app.CodeValidation).Fields["notes"].(string)
		return msg
	}
	const want = "must be at most 10 characters"

	// Characters, not bytes, counted after line endings are normalised.
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R","body":"x","notes":"ééééé\r\néééé"}`)))
	if it.Notes != "ééééé\néééé" {
		t.Errorf("notes: %q", it.Notes)
	}
	_, err := e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R","notes":"12345678901"}`))
	if msg := notesErr(err); msg != want {
		t.Errorf("create: %q", msg)
	}
	_, err = e.app.UpdateItem(e.ctx, it.ID, input(t, `{"notes":"12345678901"}`))
	if msg := notesErr(err); msg != want {
		t.Errorf("update: %q", msg)
	}
	_, err = e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t,
		`{"field":"notes","edits":[{"oldText":"é\né","newText":"é\n\né"}]}`))
	if msg := notesErr(err); msg != want {
		t.Errorf("edit: %q", msg)
	}
	if cur := must(e.app.GetItem(e.ctx, it.ID)); cur.Notes != it.Notes {
		t.Error("a refused save must not write anything")
	}
	// The body is not bound by the notes limit.
	must(e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t, `{"field":"body","edits":[{"oldText":"x","newText":"y"}]}`)))
}

func TestNotesOverALoweredLimit(t *testing.T) {
	e := newEnv(t, func(o *app.Options) { o.Limits.MaxNotesChars = 10 })
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R","body":"b"}`)))
	// Notes written while the limit was higher.
	long := strings.Repeat("n", 20)
	if err := e.db.Write(e.ctx, func(tx store.Tx) error {
		cur, err := tx.GetItem(it.ID)
		if err != nil {
			return err
		}
		cur.Notes = long
		return tx.UpdateItem(&cur)
	}); err != nil {
		t.Fatal(err)
	}
	if got := must(e.app.GetItem(e.ctx, it.ID)); got.Notes != long {
		t.Fatalf("existing notes must still load: %q", got.Notes)
	}
	// Other fields still save, and so do the unchanged notes sent back.
	up := must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"title":"Renamed","status":"done","notes":"`+long+`"}`)))
	if up.Title != "Renamed" || up.Notes != long {
		t.Errorf("update: %q %q", up.Title, up.Notes)
	}
	must(e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t, `{"field":"body","edits":[{"oldText":"b","newText":"c"}]}`)))
	// Changed notes still over the limit are refused, shorter or not.
	_, err := e.app.UpdateItem(e.ctx, it.ID, input(t, `{"notes":"`+long[1:]+`"}`))
	wantCode(t, err, app.CodeValidation)
	_, err = e.app.EditItemText(e.ctx, it.ID, decodeInto[app.EditTextInput](t, `{"field":"notes","edits":[{"oldText":"nnnnn","newText":"n"}]}`))
	wantCode(t, err, app.CodeValidation)
	// Within the limit again, they save.
	if got := must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"notes":"short"}`))); got.Notes != "short" {
		t.Errorf("notes: %q", got.Notes)
	}
}

func TestBulkActionsAndTags(t *testing.T) {
	e := newEnv(t)
	a := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"A","tags":["x"]}`)))
	b := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"B","tags":["y"]}`)))
	col := must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"C"}`)))
	bulk := func(js string) app.BulkResult {
		return must(e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t, js)))
	}
	ids := `"ids":["` + a.ID + `","` + b.ID + `","unknown"]`
	if r := bulk(`{` + ids + `,"action":"addTags","tags":["DP"]}`); r.Affected != 2 {
		t.Errorf("affected %d", r.Affected)
	}
	bulk(`{` + ids + `,"action":"setStatus","status":"in_progress"}`)
	bulk(`{` + ids + `,"action":"setFavorite","favorite":true}`)
	bulk(`{` + ids + `,"action":"addToCollection","collectionId":"` + col.ID + `"}`)
	got := must(e.app.GetItem(e.ctx, a.ID))
	if strings.Join(got.Tags, ",") != "dp,x" || got.Status != domain.StatusInProgress || !got.Favorite || len(got.CollectionIDs) != 1 || got.Revision != 2 {
		t.Errorf("after bulk: %+v", got.ItemSummary)
	}
	_, err := e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t, `{`+ids+`,"action":"explode"}`))
	wantCode(t, err, app.CodeValidation)
	_, err = e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t, `{`+ids+`,"action":"addToCollection","collectionId":"nope"}`))
	wantCode(t, err, app.CodeNotFound)

	tags := must(e.app.ListTags(e.ctx))
	if len(tags.Items) != 3 || tags.Items[0].Name != "dp" || tags.Items[0].Count != 2 {
		t.Errorf("tags: %+v", tags.Items)
	}
	// Renaming onto an existing tag merges.
	tg := must(e.app.RenameTag(e.ctx, "x", "Y"))
	if tg.Name != "y" || tg.Count != 2 {
		t.Errorf("rename merge: %+v", tg)
	}
	if r := bulk(`{` + ids + `,"action":"delete"}`); r.Affected != 2 {
		t.Errorf("delete affected %d", r.Affected)
	}
	if st := must(e.app.Stats(e.ctx)); st.Items.Total != 0 || st.Tags != 0 {
		t.Errorf("stats after delete: %+v", st)
	}
}

// A tag stays when its last item drops it or is deleted, and can still be
// renamed, merged and deleted; only deleting it removes it for good.
func TestTagsOutliveTheirItems(t *testing.T) {
	e := newEnv(t)
	a := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"A","tags":["solo","shared"]}`)))
	must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"B","tags":["shared"]}`)))
	c := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"C","tags":["gone"]}`)))
	list := func() string {
		var out []string
		for _, tg := range must(e.app.ListTags(e.ctx)).Items {
			out = append(out, fmt.Sprintf("%s=%d", tg.Name, tg.Count))
		}
		return strings.Join(out, ",")
	}
	must(e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t, `{"ids":["`+a.ID+`"],"action":"removeTags","tags":["solo"]}`)))
	if err := e.app.DeleteItem(e.ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	if got := list(); got != "gone=0,shared=2,solo=0" {
		t.Errorf("after the last items dropped them: %s", got)
	}
	if st := must(e.app.Stats(e.ctx)); st.Tags != 1 {
		t.Errorf("stats count %d tags, want the one items carry", st.Tags)
	}
	if ov := must(e.app.Overview(e.ctx)); len(ov.Tags) != 3 {
		t.Errorf("overview tags: %+v", ov.Tags)
	}
	// An empty tag is renamed, then merged into a tag items carry.
	if tg := must(e.app.RenameTag(e.ctx, "solo", "lonely")); tg.Name != "lonely" || tg.Count != 0 {
		t.Errorf("rename of an empty tag: %+v", tg)
	}
	if got := list(); got != "gone=0,lonely=0,shared=2" {
		t.Errorf("after renaming an empty tag: %s", got)
	}
	if tg := must(e.app.RenameTag(e.ctx, "lonely", "shared")); tg.Name != "shared" || tg.Count != 2 {
		t.Errorf("merge of an empty tag: %+v", tg)
	}
	// A tag items carry is merged into an empty one.
	if tg := must(e.app.RenameTag(e.ctx, "shared", "gone")); tg.Name != "gone" || tg.Count != 2 {
		t.Errorf("merge into an empty tag: %+v", tg)
	}
	if got := list(); got != "gone=2" {
		t.Errorf("after merging: %s", got)
	}
	if got := must(e.app.GetItem(e.ctx, a.ID)); strings.Join(got.Tags, ",") != "gone" {
		t.Errorf("item tags after merging: %v", got.Tags)
	}
	// Deleting removes it from its items and for good; an empty one too.
	if err := e.app.DeleteTag(e.ctx, "gone"); err != nil {
		t.Fatal(err)
	}
	if got := list(); got != "" {
		t.Errorf("after deleting: %s", got)
	}
	if got := must(e.app.GetItem(e.ctx, a.ID)); len(got.Tags) != 0 {
		t.Errorf("item tags after deleting: %v", got.Tags)
	}
	wantCode(t, e.app.DeleteTag(e.ctx, "gone"), app.CodeNotFound)
	wantCode(t, must2(e.app.RenameTag(e.ctx, "gone", "back")), app.CodeNotFound)
	must(e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t, `{"ids":["`+a.ID+`"],"action":"addTags","tags":["empty"]}`)))
	must(e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t, `{"ids":["`+a.ID+`"],"action":"removeTags","tags":["empty"]}`)))
	if err := e.app.DeleteTag(e.ctx, "empty"); err != nil {
		t.Errorf("deleting an empty tag: %v", err)
	}
	if got := list(); got != "" {
		t.Errorf("after deleting an empty tag: %s", got)
	}
}

func TestListItemsQueryValidation(t *testing.T) {
	e := newEnv(t)
	e.problem(t, `,"tags":["dp"]`)
	bad := []app.ItemQuery{
		{Sort: "position"},
		{Sort: "relevance"},
		{Sort: "bogus"},
		{Status: []string{"lost"}},
		{Difficulty: []string{"brutal"}},
		{Order: "sideways"},
		{Type: "video"},
	}
	for _, q := range bad {
		_, err := e.app.ListItems(e.ctx, q)
		wantCode(t, err, app.CodeBadRequest)
	}
	big, zero := 201, 0
	_, err := e.app.ListItems(e.ctx, app.ItemQuery{Limit: &big})
	wantCode(t, err, app.CodeBadRequest)
	_, err = e.app.ListItems(e.ctx, app.ItemQuery{Limit: &zero})
	wantCode(t, err, app.CodeBadRequest)
	_, err = e.app.ListItems(e.ctx, app.ItemQuery{Offset: -1})
	wantCode(t, err, app.CodeBadRequest)
	page := must(e.app.ListItems(e.ctx, app.ItemQuery{Tag: []string{"DP"}}))
	if page.Total != 1 || len(page.Items) != 1 {
		t.Errorf("page: %+v", page)
	}
}

func TestItemFacets(t *testing.T) {
	e := newEnv(t)
	col := must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"C"}`)))
	in := `,"collectionIds":["` + col.ID + `"]`
	must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"A","status":"done","tags":["x"]`+in+`}`)))
	must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"B","difficulty":"hard","tags":["x","y"]`+in+`}`)))
	must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"C","status":"done","difficulty":"hard"}`)))
	must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"D","status":"done","tags":["x"]`+in+`}`)))

	// Each dimension ignores its own filter but keeps the others; tags keep
	// every filter, theirs too.
	f := must(e.app.ItemFacets(e.ctx, app.ItemQuery{CollectionID: col.ID, Type: "reading", Status: []string{"done"}, Difficulty: []string{"none"}, Tag: []string{"X"}}))
	want := domain.ItemFacets{
		ByType:       map[string]int{"problem": 1, "reading": 1},
		ByStatus:     map[string]int{"todo": 0, "in_progress": 0, "done": 1},
		ByDifficulty: map[string]int{"easy": 0, "medium": 0, "hard": 0, "none": 1},
		ByTag:        map[string]int{"x": 1},
	}
	if fmt.Sprint(f) != fmt.Sprint(want) {
		t.Errorf("facets %v, want %v", f, want)
	}
	f = must(e.app.ItemFacets(e.ctx, app.ItemQuery{CollectionID: col.ID}))
	want = domain.ItemFacets{
		ByType:       map[string]int{"problem": 1, "reading": 2},
		ByStatus:     map[string]int{"todo": 1, "in_progress": 0, "done": 2},
		ByDifficulty: map[string]int{"easy": 0, "medium": 0, "hard": 1, "none": 2},
		ByTag:        map[string]int{"x": 3, "y": 1},
	}
	if fmt.Sprint(f) != fmt.Sprint(want) {
		t.Errorf("collection facets %v, want %v", f, want)
	}
	// The order and page are not facets' business; bad filters are.
	big := 999
	must(e.app.ItemFacets(e.ctx, app.ItemQuery{Sort: "bogus", Limit: &big}))
	_, err := e.app.ItemFacets(e.ctx, app.ItemQuery{Status: []string{"lost"}})
	wantCode(t, err, app.CodeBadRequest)
}

func TestTestCaseOperations(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	tc := must(e.app.AddTestCase(e.ctx, it.ID, decodeInto[domain.TestCaseInput](t, `{"stdin":"2 2","expectedStdout":"4"}`)))
	if tc.Position != 2 || tc.Origin != domain.OriginManual || tc.Verified {
		t.Errorf("added: %+v", tc)
	}
	list := must(e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t,
		`{"cases":[{"stdin":"0 0","expectedStdout":"0","origin":"ai","verified":true}],"referenceSolution":{"language":"python","source":"sum"}}`)))
	if len(list.Items) != 4 || list.Items[3].Origin != domain.OriginAI {
		t.Errorf("bulk append: %+v", list.Items)
	}
	cur := must(e.app.GetItem(e.ctx, it.ID))
	if cur.Problem.ReferenceSolution == nil || cur.Problem.ReferenceSolution.Source != "sum" {
		t.Error("reference solution should be stored with the bulk cases")
	}
	ids := make([]string, len(list.Items))
	for i, c := range list.Items {
		ids[len(ids)-1-i] = c.ID
	}
	reordered := must(e.app.ReorderTestCases(e.ctx, it.ID, ids))
	if reordered.Items[0].ID != ids[0] || reordered.Items[0].Position != 0 {
		t.Errorf("reorder: %+v", reordered.Items)
	}
	_, err := e.app.ReorderTestCases(e.ctx, it.ID, ids[:2])
	wantCode(t, err, app.CodeValidation)
	if err := e.app.DeleteTestCase(e.ctx, ids[0]); err != nil {
		t.Fatal(err)
	}
	rest := must(e.app.ListTestCases(e.ctx, it.ID))
	if len(rest.Items) != 3 || rest.Items[0].Position != 0 || rest.Items[2].Position != 2 {
		t.Errorf("positions after delete: %+v", rest.Items)
	}
	// Replacing keeps the sample cases, in their order, and puts the new cases after them.
	var samples []string
	for _, c := range rest.Items {
		if c.IsSample {
			samples = append(samples, c.ID)
		}
	}
	if len(samples) == 0 || len(samples) == len(rest.Items) {
		t.Fatalf("the replace check needs samples and other cases: %+v", rest.Items)
	}
	replaced := must(e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t, `{"cases":[{"expectedStdout":"x"}],"replace":true}`)))
	if len(replaced.Items) != len(samples)+1 {
		t.Fatalf("replace: %+v", replaced.Items)
	}
	for i, c := range replaced.Items {
		if c.Position != i {
			t.Errorf("replace: case %d at position %d", i, c.Position)
		}
		if i < len(samples) && c.ID != samples[i] {
			t.Errorf("replace: sample %d is %s, want %s", i, c.ID, samples[i])
		}
	}
	if last := replaced.Items[len(samples)]; last.IsSample || last.ExpectedStdout != "x" {
		t.Errorf("replace: the new case should follow the samples: %+v", last)
	}
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	_, err = e.app.ListTestCases(e.ctx, reading.ID)
	wantCode(t, err, app.CodeValidation)
	_, err = e.app.AddTestCase(e.ctx, reading.ID, decodeInto[domain.TestCaseInput](t, `{"expectedStdout":""}`))
	wantCode(t, err, app.CodeValidation)
}

func TestDeleteItemClearsVariantLinks(t *testing.T) {
	clock := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	e := newEnv(t, func(o *app.Options) { o.Now = func() time.Time { return clock } })
	orig := e.problem(t, "")
	v := must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"Variant","variantOf":"`+orig.ID+`"}`)))
	if got := must(e.app.GetItem(e.ctx, orig.ID)); got.VariantCount != 1 {
		t.Errorf("variantCount = %d", got.VariantCount)
	}
	page := must(e.app.ListItems(e.ctx, app.ItemQuery{VariantOf: orig.ID}))
	if page.Total != 1 || page.Items[0].ID != v.ID {
		t.Errorf("variantOf filter: %+v", page)
	}
	clock = clock.Add(time.Minute)
	if err := e.app.DeleteItem(e.ctx, orig.ID); err != nil {
		t.Fatal(err)
	}
	// Losing the link is a content change for the variant.
	if got := must(e.app.GetItem(e.ctx, v.ID)); got.VariantOf != nil || got.Revision != v.Revision+1 || !got.UpdatedAt.Equal(clock) {
		t.Errorf("variant after its original was deleted: variantOf %v, revision %d -> %d, updatedAt %v",
			got.VariantOf, v.Revision, got.Revision, got.UpdatedAt)
	}
	wantCode(t, e.app.DeleteItem(e.ctx, orig.ID), app.CodeNotFound)
}

func TestItemJSONShape(t *testing.T) {
	e := newEnv(t)
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	b, _ := json.Marshal(it)
	var m map[string]any
	json.Unmarshal(b, &m)
	for _, k := range []string{"difficulty", "variantOf", "lastVerdict", "rawInput", "problem"} {
		if v, ok := m[k]; !ok || v != nil {
			t.Errorf("%s should be present and null, got %v (present %v)", k, v, ok)
		}
	}
	for _, k := range []string{"tags", "collectionIds"} {
		if arr, ok := m[k].([]any); !ok || len(arr) != 0 {
			t.Errorf("%s should be [], got %v", k, m[k])
		}
	}
	if !strings.HasSuffix(m["createdAt"].(string), "Z") || strings.Contains(m["createdAt"].(string), ".") {
		t.Errorf("timestamp format: %v", m["createdAt"])
	}
}

// wantField fails unless err is a validation error naming field.
func wantField(t *testing.T, err error, field string) {
	t.Helper()
	e := wantCode(t, err, app.CodeValidation)
	if _, ok := e.Fields[field]; !ok {
		t.Fatalf("validation error %v does not name %q", err, field)
	}
}

// Bulk parameters are checked before anything is written, and an action
// that fails on one item writes nothing.
func TestBulkItemsValidation(t *testing.T) {
	e := newEnv(t)
	tags := make([]string, domain.MaxTags-1)
	for i := range tags {
		tags[i] = fmt.Sprintf(`"t%02d"`, i)
	}
	empty := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"Empty"}`)))
	full := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"Full","tags":[`+strings.Join(tags, ",")+`]}`)))
	ids := `"ids":["` + empty.ID + `","` + full.ID + `"]`
	for _, c := range []struct{ js, field string }{
		{`"action":"addTags"`, "tags"},
		{`"action":"removeTags","tags":["  "]`, "tags"},
		{`"action":"addTags","tags":["a/b"]`, "tags"},
		{`"action":"setStatus","status":"lost"`, "status"},
		{`"action":"setFavorite"`, "favorite"},
		{`"action":"addToCollection"`, "collectionId"},
		{`"action":"removeFromCollection"`, "collectionId"},
		{`"action":"explode"`, "action"},
	} {
		_, err := e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t, `{`+ids+`,`+c.js+`}`))
		wantField(t, err, c.field)
	}
	// The first item could take two more tags; the second cannot.
	_, err := e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t, `{`+ids+`,"action":"addTags","tags":["new1","new2"]}`))
	wantField(t, err, "tags")
	if got := must(e.app.GetItem(e.ctx, empty.ID)); len(got.Tags) != 0 || got.Revision != 1 {
		t.Errorf("the first item was written: %v, revision %d", got.Tags, got.Revision)
	}
	if got := must(e.app.GetItem(e.ctx, full.ID)); len(got.Tags) != domain.MaxTags-1 {
		t.Errorf("the second item has %d tags", len(got.Tags))
	}
	if n := len(must(e.app.ListTags(e.ctx)).Items); n != domain.MaxTags-1 {
		t.Errorf("%d tags exist after a refused bulk action", n)
	}
}

func TestListItemsOrder(t *testing.T) {
	e := newEnv(t)
	for _, title := range []string{"B", "A", "C"} {
		must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"`+title+`"}`)))
	}
	titles := func(q app.ItemQuery) string {
		var out []string
		for _, it := range must(e.app.ListItems(e.ctx, q)).Items {
			out = append(out, it.Title)
		}
		return strings.Join(out, "")
	}
	if got := titles(app.ItemQuery{Sort: "title"}); got != "ABC" {
		t.Errorf("title, default order: %s", got)
	}
	if got := titles(app.ItemQuery{Sort: "title", Order: "desc"}); got != "CBA" {
		t.Errorf("title, desc: %s", got)
	}
	one := 1
	if got := titles(app.ItemQuery{Sort: "title", Order: "desc", Limit: &one, Offset: 1}); got != "B" {
		t.Errorf("title, desc, second page of one: %s", got)
	}
}
