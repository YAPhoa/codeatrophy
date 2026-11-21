package app_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

// withTickingClock gives the app a clock that moves one second each time
// it is read, so that every write moves updatedAt.
func withTickingClock() option {
	var mu sync.Mutex
	t := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	return func(o *app.Options) {
		o.Now = func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			t = t.Add(time.Second)
			return t
		}
	}
}

// sourceText shows a change source as "via client model", "-" for a
// missing one, or "nobody".
func sourceText(c *domain.ChangeSource) string {
	if c == nil {
		return "nobody"
	}
	opt := func(p *string) string {
		if p == nil {
			return "-"
		}
		return *p
	}
	return c.Via + " " + opt(c.Client) + " " + opt(c.Model)
}

func mcpCtx(ctx context.Context, model string) context.Context {
	return app.WithChangeSource(ctx, domain.ViaMCP, "claude-code", model)
}

// provenance reads an item and shows who created it and who last changed
// it, with whether updatedAt moved since before.
func (e *env) provenance(t *testing.T, id string, before domain.Item) (string, domain.Item) {
	t.Helper()
	it := must(e.app.GetItem(e.ctx, id))
	moved := "same"
	if !it.UpdatedAt.Equal(before.UpdatedAt) {
		moved = "moved"
	}
	return sourceText(it.CreatedBy) + " / " + sourceText(it.LastUpdatedBy) + " / " + moved, it
}

// An item records who created it, never again, and who made the change
// that last moved updatedAt: content, test case and solution changes do;
// personal state, collections and links do not, and neither does a verify
// run that only marks cases verified.
func TestChangeSourceFollowsUpdatedAt(t *testing.T) {
	e := newEnv(t, withTickingClock())
	httpCtx := app.WithChangeSource(e.ctx, domain.ViaHTTP, "", "")
	created := must(e.app.CreateItem(mcpCtx(e.ctx, "m1"), input(t, `{"type":"problem","title":"A plus B","testCases":[
		{"name":"s1","stdin":"1 2","expectedStdout":"3","isSample":true},
		{"name":"h1","stdin":"5 5","expectedStdout":"11"}]}`)))
	const by = "mcp claude-code m1"
	if got := sourceText(created.CreatedBy) + " / " + sourceText(created.LastUpdatedBy); got != by+" / "+by {
		t.Fatalf("created: %s", got)
	}
	other := must(e.app.CreateItem(httpCtx, input(t, `{"type":"reading","title":"R"}`)))
	coll := must(e.app.CreateCollection(httpCtx, domain.CollectionInput{Name: domain.Some("C")}))
	cur := created
	step := func(what, want string, change func() error) {
		t.Helper()
		if err := change(); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		var got string
		got, cur = e.provenance(t, created.ID, cur)
		if got != want {
			t.Errorf("%s: %s, want %s", what, got, want)
		}
	}
	ignore := func(_ any, err error) error { return err }

	// Personal state, collections and links change neither.
	step("status", by+" / "+by+" / same", func() error {
		return ignore(e.app.UpdateItem(httpCtx, created.ID, input(t, `{"status":"done","favorite":true,"notes":"n"}`)))
	})
	step("collections", by+" / "+by+" / same", func() error {
		return ignore(e.app.UpdateItem(httpCtx, created.ID, input(t, `{"collectionIds":["`+coll.ID+`"]}`)))
	})
	step("links", by+" / "+by+" / same", func() error { return ignore(e.app.LinkItem(httpCtx, created.ID, other.ID)) })
	step("an update that changes nothing", by+" / "+by+" / same", func() error {
		return ignore(e.app.UpdateItem(httpCtx, created.ID, input(t, `{"title":"A plus B"}`)))
	})
	// Content changes record their source.
	step("title", by+" / http - - / moved", func() error {
		return ignore(e.app.UpdateItem(httpCtx, created.ID, input(t, `{"title":"Sum"}`)))
	})
	step("body", by+" / http - - / moved", func() error {
		return ignore(e.app.UpdateItem(httpCtx, created.ID, input(t, `{"body":"abc"}`)))
	})
	step("text edit", by+" / mcp claude-code m2 / moved", func() error {
		return ignore(e.app.EditItemText(mcpCtx(e.ctx, "m2"), created.ID, app.EditTextInput{Field: "body",
			Edits: []app.TextEdit{{OldText: "b", NewText: "x"}}}))
	})
	step("tags", by+" / mcp claude-code - / moved", func() error {
		return ignore(e.app.BulkItems(mcpCtx(e.ctx, ""), app.BulkInput{IDs: []string{created.ID}, Action: "addTags", Tags: []string{"math"}}))
	})
	step("a renamed tag", by+" / http - - / moved", func() error { return ignore(e.app.RenameTag(httpCtx, "math", "arith")) })
	step("a test case added", by+" / mcp claude-code m3 / moved", func() error {
		return ignore(e.app.AddTestCase(mcpCtx(e.ctx, "m3"), created.ID, domain.TestCaseInput{
			Name: domain.Some("h2"), Stdin: domain.Some("2 2"), ExpectedStdout: domain.Some("4")}))
	})
	step("a solution", by+" / mcp claude-code m4 / moved", func() error {
		return ignore(e.app.CreateSolution(mcpCtx(e.ctx, "m4"), created.ID, decodeInto[domain.ItemSolutionInput](t,
			`{"name":"Ref","language":"python","source":"sum","isReference":true}`)))
	})
	// A verify run that only marks cases verified moves updatedAt and
	// leaves who last changed the item; one that rewrites an expected output
	// records its source.
	step("verify, flags only", by+" / mcp claude-code m4 / moved", func() error {
		return ignore(e.app.VerifyTestCases(mcpCtx(e.ctx, "m5"), created.ID, false, ""))
	})
	step("verify, nothing to change", by+" / mcp claude-code m4 / same", func() error {
		return ignore(e.app.VerifyTestCases(mcpCtx(e.ctx, "m5"), created.ID, false, ""))
	})
	step("verify, expected rewritten", by+" / mcp claude-code m6 / moved", func() error {
		return ignore(e.app.VerifyTestCases(mcpCtx(e.ctx, "m6"), created.ID, true, ""))
	})
	cases := must(e.app.ListTestCases(e.ctx, created.ID)).Items
	step("a test case changed", by+" / http - - / moved", func() error {
		return ignore(e.app.UpdateTestCase(httpCtx, cases[2].ID, domain.TestCaseInput{Name: domain.Some("renamed")}))
	})
	step("a test case deleted", by+" / mcp claude-code m7 / moved", func() error {
		return e.app.DeleteTestCase(mcpCtx(e.ctx, "m7"), cases[2].ID)
	})
	// A change made with no source (as by a background worker) is recorded
	// as unknown.
	step("unknown", by+" / nobody / moved", func() error {
		return ignore(e.app.UpdateItem(e.ctx, created.ID, input(t, `{"summary":"s"}`)))
	})
	// A submission's status side effect is personal state.
	step("submission", by+" / nobody / same", func() error {
		return ignore(e.app.CreateSubmission(httpCtx, created.ID, decodeInto[app.SubmissionInput](t,
			`{"language":"python","source":"sum","mode":"run"}`)))
	})
}

// The client and model a caller reports are made fit to keep, and never
// refuse a change: control characters and runs of white space become one
// space, the ends are trimmed, the text is cut to 200 code points, and
// empty text is unknown.
func TestChangeSourceIsSanitised(t *testing.T) {
	e := newEnv(t)
	long := strings.Repeat("é", 150) + " " + strings.Repeat("x", 100)
	ctx := app.WithChangeSource(e.ctx, domain.ViaMCP, " Claude\tCode\r\n\x00   v2 ", long)
	it := must(e.app.CreateItem(ctx, input(t, `{"type":"reading","title":"R"}`)))
	want := strings.Repeat("é", 150) + " " + strings.Repeat("x", 49)
	if c := it.CreatedBy; c == nil || c.Client == nil || *c.Client != "Claude Code v2" || c.Model == nil || *c.Model != want {
		t.Errorf("created by %s", sourceText(c))
	}
	ctx = app.WithChangeSource(e.ctx, domain.ViaMCP, " \n\t ", "\x01")
	it = must(e.app.CreateItem(ctx, input(t, `{"type":"reading","title":"R"}`)))
	if got := sourceText(it.CreatedBy) + " / " + sourceText(it.LastUpdatedBy); got != "mcp - - / mcp - -" {
		t.Errorf("empty values: %s", got)
	}
}

// A saved draft records the model of the generation its form was built
// from; one written by hand records none.
func TestDraftSaveRecordsTheGenerationModel(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.ModelValue = "claude-haiku-5-5"
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	httpCtx := app.WithChangeSource(e.ctx, domain.ViaHTTP, "", "")
	save := func(d app.Draft) domain.Item {
		t.Helper()
		return must(e.app.SaveDraft(httpCtx, d.ID, decodeInto[app.DraftSaveInput](t, `{"item":{"type":"reading","title":"Saved"}}`)))
	}
	for _, tc := range []struct {
		name    string
		adopted bool
		want    string
	}{
		{"built from the generation", true, "http - claude-haiku-5-5"},
		{"generated, then written by hand", false, "http - -"},
	} {
		d, _ := e.newDraft(t, `{"kind":"capture","generate":{"text":"two sum"}}`)
		d = e.waitDraft(t, d.ID)
		if tc.adopted {
			d = must(e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"content":{"form":{}},"basedOn":1}`)))
		} else {
			d = must(e.app.UpdateDraft(e.ctx, d.ID, patch(t, `{"content":{"form":{}},"edited":true}`)))
		}
		it := save(d)
		if got := sourceText(it.CreatedBy) + " / " + sourceText(it.LastUpdatedBy); got != tc.want+" / "+tc.want {
			t.Errorf("%s: %s", tc.name, got)
		}
	}
	d, _ := e.newDraft(t, `{"kind":"capture","content":{}}`)
	if it := save(d); sourceText(it.CreatedBy) != "http - -" {
		t.Errorf("written by hand: %s", sourceText(it.CreatedBy))
	}
}

// An imported item is recorded as made by the import; overwriting a
// changed item records the import as its last change and keeps who
// created it, and an unchanged one is left alone.
func TestImportRecordsItsChanges(t *testing.T) {
	e := newEnv(t)
	httpCtx := app.WithChangeSource(e.ctx, domain.ViaHTTP, "", "")
	mine := must(e.app.CreateItem(mcpCtx(e.ctx, "m1"), input(t, `{"type":"reading","title":"Mine"}`)))
	data := e.export(t, `{"scope":"all"}`)

	other := newEnv(t)
	must(other.app.Import(httpCtx, data, ""))
	if it := must(other.app.GetItem(other.ctx, mine.ID)); sourceText(it.CreatedBy)+" / "+sourceText(it.LastUpdatedBy) != "import - - / import - -" {
		t.Errorf("a new item: %s / %s", sourceText(it.CreatedBy), sourceText(it.LastUpdatedBy))
	}

	res := must(e.app.Import(httpCtx, data, app.StrategyOverwrite))
	if it := must(e.app.GetItem(e.ctx, mine.ID)); res.Unchanged != 1 || sourceText(it.LastUpdatedBy) != "mcp claude-code m1" {
		t.Errorf("an unchanged item: %+v, %s", res, sourceText(it.LastUpdatedBy))
	}
	must(e.app.UpdateItem(httpCtx, mine.ID, input(t, `{"title":"Changed here"}`)))
	res = must(e.app.Import(httpCtx, data, app.StrategyOverwrite))
	it := must(e.app.GetItem(e.ctx, mine.ID))
	if got := sourceText(it.CreatedBy) + " / " + sourceText(it.LastUpdatedBy); res.Updated != 1 || it.Title != "Mine" ||
		got != "mcp claude-code m1 / import - -" {
		t.Errorf("an overwritten item: %+v, %s", res, got)
	}
}

// Items written before the record existed, or by a path that has no
// source, read as unknown and never fail.
func TestChangeSourceMayBeUnknown(t *testing.T) {
	e := newEnv(t)
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	if it.CreatedBy != nil || it.LastUpdatedBy != nil {
		t.Errorf("without a source: %s / %s", sourceText(it.CreatedBy), sourceText(it.LastUpdatedBy))
	}
	upd := must(e.app.UpdateItem(mcpCtx(e.ctx, ""), it.ID, input(t, `{"title":"S"}`)))
	if upd.CreatedBy != nil || sourceText(upd.LastUpdatedBy) != "mcp claude-code -" {
		t.Errorf("updated: %s / %s", sourceText(upd.CreatedBy), sourceText(upd.LastUpdatedBy))
	}
}
