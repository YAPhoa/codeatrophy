package app_test

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/storetest"
)

func wcIn(t *testing.T, js string) domain.WorkingCopyInput {
	return decodeInto[domain.WorkingCopyInput](t, js)
}

// A problem keeps one working copy per language, most recently written
// first, with the server's time; writing them leaves the item alone.
func TestWorkingCopies(t *testing.T) {
	clock := time.Date(2026, 11, 22, 9, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	e := newEnv(t, func(o *app.Options) {
		o.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	})
	tick := func() { mu.Lock(); clock = clock.Add(time.Minute); mu.Unlock() }
	it := e.problem(t, "")
	if l := must(e.app.ListWorkingCopies(e.ctx, it.ID)); l.Items == nil || len(l.Items) != 0 {
		t.Fatalf("a new problem: %#v", l.Items)
	}

	tick()
	py := must(e.app.PutWorkingCopy(e.ctx, it.ID, "python", wcIn(t, `{"source":"a = 1\r\nb = 2\r"}`)))
	if py.Language != "python" || py.Source != "a = 1\nb = 2\n" || !py.UpdatedAt.Equal(clock) {
		t.Errorf("put: %+v", py)
	}
	tick()
	cpp := must(e.app.PutWorkingCopy(e.ctx, it.ID, "cpp", wcIn(t, `{"source":""}`)))
	if cpp.Source != "" || !cpp.UpdatedAt.Equal(clock) {
		t.Errorf("an emptied editor: %+v", cpp)
	}
	// Written again in the same second, python is the latest.
	py = must(e.app.PutWorkingCopy(e.ctx, it.ID, "python", wcIn(t, `{"source":"print(3)"}`)))
	got := must(e.app.ListWorkingCopies(e.ctx, it.ID)).Items
	want := []domain.WorkingCopy{{ItemID: it.ID, Language: "python", Source: "print(3)", UpdatedAt: clock},
		{ItemID: it.ID, Language: "cpp", Source: "", UpdatedAt: clock}}
	if !slices.Equal(got, want) {
		t.Errorf("list\n  %+v\nwant\n  %+v", got, want)
	}
	if after := must(e.app.GetItem(e.ctx, it.ID)); after.Revision != it.Revision || !after.UpdatedAt.Equal(it.UpdatedAt) {
		t.Errorf("writing working copies changed the item: revision %d, updated %v", after.Revision, after.UpdatedAt)
	}

	// Validation.
	for js, field := range map[string]string{
		`{}`:              "source",
		`{"source":null}`: "source",
		`{"source":"` + strings.Repeat("x", 64<<10+1) + `"}`: "source",
	} {
		_, err := e.app.PutWorkingCopy(e.ctx, it.ID, "python", wcIn(t, js))
		if ae := wantCode(t, err, app.CodeValidation); ae.Fields[field] == nil {
			t.Errorf("%.40s: fields %v", js, ae.Fields)
		}
	}
	must(e.app.PutWorkingCopy(e.ctx, it.ID, "go", wcIn(t, `{"source":"`+strings.Repeat("x", 64<<10)+`"}`)))
	for _, lang := range []string{"Python", "py", "", "brainfuck"} {
		_, err := e.app.PutWorkingCopy(e.ctx, it.ID, lang, wcIn(t, `{"source":"x"}`))
		if ae := wantCode(t, err, app.CodeValidation); ae.Fields["language"] == nil {
			t.Errorf("put %q: fields %v", lang, ae.Fields)
		}
		wantCode(t, e.app.DeleteWorkingCopy(e.ctx, it.ID, lang), app.CodeValidation)
	}

	// Readings and missing items.
	r := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	_, err := e.app.ListWorkingCopies(e.ctx, r.ID)
	wantCode(t, err, app.CodeValidation)
	_, err = e.app.PutWorkingCopy(e.ctx, r.ID, "python", wcIn(t, `{"source":"x"}`))
	wantCode(t, err, app.CodeValidation)
	wantCode(t, e.app.DeleteWorkingCopy(e.ctx, r.ID, "python"), app.CodeValidation)
	missing := "00000000-0000-4000-8000-000000000000"
	_, err = e.app.ListWorkingCopies(e.ctx, missing)
	wantCode(t, err, app.CodeNotFound)
	_, err = e.app.PutWorkingCopy(e.ctx, missing, "python", wcIn(t, `{"source":"x"}`))
	wantCode(t, err, app.CodeNotFound)
	wantCode(t, e.app.DeleteWorkingCopy(e.ctx, missing, "python"), app.CodeNotFound)

	// Deleting is idempotent.
	must(struct{}{}, e.app.DeleteWorkingCopy(e.ctx, it.ID, "python"))
	must(struct{}{}, e.app.DeleteWorkingCopy(e.ctx, it.ID, "python"))
	must(struct{}{}, e.app.DeleteWorkingCopy(e.ctx, it.ID, "java"))
	if got := must(e.app.ListWorkingCopies(e.ctx, it.ID)).Items; len(got) != 2 || got[0].Language != "go" || got[1].Language != "cpp" {
		t.Errorf("after deleting python: %+v", got)
	}

	// Working copies go with their item, also through the bulk delete.
	must(struct{}{}, e.app.DeleteItem(e.ctx, it.ID))
	other := e.problem(t, "")
	must(e.app.PutWorkingCopy(e.ctx, other.ID, "python", wcIn(t, `{"source":"x"}`)))
	must(e.app.BulkItems(e.ctx, app.BulkInput{IDs: []string{other.ID}, Action: "delete"}))
	for _, id := range []string{it.ID, other.ID} {
		if err := e.db.Read(e.ctx, func(tx store.Tx) error {
			ws, err := tx.ListWorkingCopies("", id)
			if err == nil && len(ws) != 0 {
				t.Errorf("a deleted item keeps working copies %+v", ws)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
}

// Bundles never carry working copies.
func TestExportLeavesOutWorkingCopies(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	must(e.app.PutWorkingCopy(e.ctx, it.ID, "python", wcIn(t, `{"source":"WORKING-COPY-SOURCE"}`)))
	for _, js := range []string{`{"scope":"all"}`, `{"scope":"items","itemIds":["` + it.ID + `"]}`} {
		if text := zipText(t, e.export(t, js)); strings.Contains(text, "WORKING-COPY-SOURCE") {
			t.Errorf("%s: the bundle holds the working copy", js)
		}
	}
}

// Concurrent writes of one working copy each succeed and leave one whole
// write.
func TestWorkingCopyConcurrentWrites(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	const n = 30
	sources := make([]string, n)
	for i := range sources {
		sources[i] = strings.Repeat(fmt.Sprint(i%10), 10000) + fmt.Sprint(i)
	}
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Go(func() {
			_, errs[i] = e.app.PutWorkingCopy(e.ctx, it.ID, "python", domain.WorkingCopyInput{Source: domain.Some(sources[i])})
		})
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("write %d: %v", i, err)
		}
	}
	got := must(e.app.ListWorkingCopies(e.ctx, it.ID)).Items
	if len(got) != 1 || !slices.Contains(sources, got[0].Source) {
		t.Errorf("%d working copies; the first is one of the writes: %v", len(got), len(got) > 0 && slices.Contains(sources, got[0].Source))
	}
}

// Writes racing with the deletion of their item succeed or find no item,
// never fail otherwise, and leave nothing behind.
func TestWorkingCopyWritesRaceDeletion(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		ok, gone int
		started  = make(chan struct{}, 64)
	)
	for w := range 6 {
		wg.Go(func() {
			for i := range 300 {
				_, err := e.app.PutWorkingCopy(e.ctx, it.ID, []string{"python", "cpp"}[w%2],
					domain.WorkingCopyInput{Source: domain.Some(fmt.Sprint(w, i))})
				switch {
				case err == nil:
					mu.Lock()
					ok++
					mu.Unlock()
					select {
					case started <- struct{}{}:
					default:
					}
				case app.AsError(err).Code == app.CodeNotFound:
					mu.Lock()
					gone++
					mu.Unlock()
					return
				default:
					t.Errorf("writer %d: %v", w, err)
					return
				}
			}
		})
	}
	for range 6 {
		<-started
	}
	must(struct{}{}, e.app.DeleteItem(e.ctx, it.ID))
	wg.Wait()
	if gone != 6 {
		t.Errorf("%d writes succeeded, %d writers found no item, want 6", ok, gone)
	}
	if err := e.db.Read(e.ctx, func(tx store.Tx) error {
		ws, err := tx.ListWorkingCopies("", it.ID)
		if err == nil && len(ws) != 0 {
			t.Errorf("the deleted item keeps working copies %+v", ws)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

// An import that overwrites a problem keeps its working copies: they are
// not content. A bundle item of another type never replaces the local one
// (it is imported as a copy), so a problem never turns into a reading that
// keeps working copies.
func TestImportKeepsWorkingCopies(t *testing.T) {
	src, dst := newEnv(t), newEnv(t)
	p := src.problem(t, "")
	first := src.export(t, `{"scope":"all"}`)
	must(src.app.UpdateItem(src.ctx, p.ID, input(t, `{"title":"Upstream title","body":"new body"}`)))
	second := src.export(t, `{"scope":"all"}`)

	must(dst.app.Import(dst.ctx, first, ""))
	must(dst.app.PutWorkingCopy(dst.ctx, p.ID, "python", wcIn(t, `{"source":"MINE"}`)))
	for _, strategy := range []string{"skip", "duplicate", "overwrite"} {
		must(dst.app.Import(dst.ctx, second, strategy))
	}
	if got := must(dst.app.GetItem(dst.ctx, p.ID)); got.Title != "Upstream title" {
		t.Fatalf("the overwrite did not happen: %q", got.Title)
	}
	if ws := must(dst.app.ListWorkingCopies(dst.ctx, p.ID)).Items; len(ws) != 1 || ws[0].Source != "MINE" {
		t.Errorf("after overwriting the problem: %+v", ws)
	}

	// A reading in the bundle with the id of a local problem.
	r := must(src.app.CreateItem(src.ctx, input(t, `{"type":"reading","title":"Notes"}`)))
	reading := src.export(t, `{"scope":"items","itemIds":["`+r.ID+`"]}`)
	local := storetest.Item(r.ID, "My problem", domain.TypeProblem)
	if err := dst.db.Write(dst.ctx, func(tx store.Tx) error { return tx.InsertItem(&local) }); err != nil {
		t.Fatal(err)
	}
	must(dst.app.PutWorkingCopy(dst.ctx, r.ID, "cpp", wcIn(t, `{"source":"KEPT"}`)))
	res := must(dst.app.Import(dst.ctx, reading, "overwrite"))
	if res.Duplicated != 1 || res.Updated != 0 {
		t.Errorf("import of a reading over a problem: %+v", res)
	}
	if got := must(dst.app.GetItem(dst.ctx, r.ID)); got.Type != domain.TypeProblem || got.Title != "My problem" {
		t.Errorf("the local problem was replaced: %+v", got.ItemSummary)
	}
	if ws := must(dst.app.ListWorkingCopies(dst.ctx, r.ID)).Items; len(ws) != 1 || ws[0].Source != "KEPT" {
		t.Errorf("the local problem's working copies: %+v", ws)
	}
}
