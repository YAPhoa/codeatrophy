package dbcopy_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/dbcopy"
	"codeatrophy/internal/store/storetest"
	"codeatrophy/internal/store/teststore"
)

type backend struct {
	name string
	open func(t *testing.T) teststore.DB
}

var backends = []backend{
	{"SQLite", func(t *testing.T) teststore.DB { return teststore.OpenSQLite(t) }},
	{"PostgreSQL", func(t *testing.T) teststore.DB { return teststore.OpenPostgres(t) }},
}

// A library copied from SQLite to another backend and back is unchanged,
// down to ids, timestamps, revisions and insertion order, and every view of
// it through the store is the same.
func TestCopyRoundTrip(t *testing.T) {
	for _, via := range backends {
		t.Run("SQLite to "+via.name+" and back", func(t *testing.T) {
			ctx := context.Background()
			src := teststore.OpenSQLite(t)
			storetest.Populate(t, src)
			want := storetest.Dump(t, src)
			if len(want["style_presets"]) != 3 || len(want["submission_results"]) != 4 || len(want["settings"]) != 2 {
				t.Fatalf("the fixture does not use every table as meant: %d presets, %d results, %d settings",
					len(want["style_presets"]), len(want["submission_results"]), len(want["settings"]))
			}
			mid := via.open(t)
			counts, err := dbcopy.Copy(ctx, src, mid, dbcopy.Options{})
			if err != nil {
				t.Fatal(err)
			}
			for _, c := range counts {
				if int(c.Rows) != len(want[c.Table]) {
					t.Errorf("%s: %d copied, %d in the source", c.Table, c.Rows, len(want[c.Table]))
				}
			}
			storetest.SameDump(t, "after the first copy", want, storetest.Dump(t, mid))
			back := teststore.OpenSQLite(t)
			if _, err := dbcopy.Copy(ctx, mid, back, dbcopy.Options{}); err != nil {
				t.Fatal(err)
			}
			storetest.SameDump(t, "after the copy back", want, storetest.Dump(t, back))
			for _, db := range []teststore.DB{mid, back} {
				sameViews(t, src, db)
			}
			// The copy keeps working as a store: new rows follow the copied ones.
			storetest.Write(t, mid, func(tx store.Tx) error {
				it := storetest.Item("new", "New", domain.TypeReading)
				return tx.InsertItem(&it)
			})
			all := storetest.Read(t, mid, func(tx store.Tx) ([]string, error) { return tx.AllItemIDs() })
			if all[len(all)-1] != "new" {
				t.Errorf("a new item is not last: %v", all)
			}
		})
	}
}

// sameViews compares what the application sees through the store.
func sameViews(t *testing.T, want, got store.Store) {
	t.Helper()
	ctx := context.Background()
	view := func(db store.Store) string {
		var b strings.Builder
		// JSON follows pointers; raw bytes are compared by the dumps.
		j := func(vs ...any) {
			for _, v := range vs {
				bs, err := json.Marshal(v)
				if err != nil {
					t.Fatal(err)
				}
				b.Write(bs)
				b.WriteByte('\n')
			}
		}
		if err := db.Read(ctx, func(tx store.Tx) error {
			// The AI log, bodies decompressed and system texts joined back.
			entries, _, err := tx.ListAILog(store.AILogFilter{})
			if err != nil {
				return err
			}
			for _, e := range entries {
				full, body, err := tx.GetAILogEntry(e.ID)
				if err != nil {
					return err
				}
				j(full, body)
			}
			usage, err := tx.AIUsage(0)
			if err != nil {
				return err
			}
			j(usage)
			items, _, err := tx.ListItems(store.ItemFilter{Sort: store.SortTitle})
			if err != nil {
				return err
			}
			for _, s := range items {
				it, err := tx.GetItem(s.ID)
				if err != nil {
					return err
				}
				tcs, _ := tx.ListTestCases(s.ID)
				sols, _ := tx.ListSolutions(s.ID)
				subs, _, _ := tx.ListSubmissions(s.ID, "", 0, 0)
				j(it, tcs, sols, subs)
				for _, sub := range subs {
					full, _ := tx.GetSubmission(sub.ID)
					j(full)
				}
			}
			cols, _ := tx.ListCollections()
			tags, _ := tx.ListTags()
			presets, _ := tx.ListStylePresets()
			provs, _ := tx.ListAIProviders()
			stats, _ := tx.Stats()
			def, _, _ := tx.GetSetting("ai.default_provider")
			j(cols, tags, presets, provs, stats, def)
			for _, q := range storetest.SearchQueries {
				for _, sort := range []string{store.SortUpdated, store.SortTitle} {
					l, n, err := tx.ListItems(store.ItemFilter{Query: q, Sort: sort})
					if err != nil {
						return err
					}
					fmt.Fprintf(&b, "q=%q %d:", q, n)
					for _, s := range l {
						b.WriteString(" " + s.ID)
					}
					b.WriteString("\n")
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return b.String()
	}
	if w, g := view(want), view(got); w != g {
		wl, gl := strings.Split(w, "\n"), strings.Split(g, "\n")
		for i := range min(len(wl), len(gl)) {
			if wl[i] != gl[i] {
				t.Errorf("views differ at line %d:\nwant %s\ngot  %s", i, wl[i], gl[i])
				return
			}
		}
		t.Errorf("views differ in length: %d and %d lines", len(wl), len(gl))
	}
	// The API key still decrypts: the provider is ready and shows its hint.
	a := app.New(app.Options{Store: got, Secrets: storetest.FixtureSecrets})
	s, err := a.GetAISettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Providers) != 1 || !s.Providers[0].APIKeySet || s.Providers[0].APIKeyHint == nil ||
		*s.Providers[0].APIKeyHint != "…1234" || !s.Providers[0].IsDefault {
		t.Errorf("AI settings after the copy: %+v", s.Providers)
	}
}

// Search returns the same items on both backends, in the same order.
func TestSearchMatchesAcrossBackends(t *testing.T) {
	lite := teststore.OpenSQLite(t)
	storetest.Populate(t, lite)
	pg := teststore.OpenPostgres(t)
	if _, err := dbcopy.Copy(context.Background(), lite, pg, dbcopy.Options{}); err != nil {
		t.Fatal(err)
	}
	// Index rows written by the store itself, not only by the copy.
	for _, db := range []store.Store{lite, pg} {
		storetest.Write(t, db, func(tx store.Tx) error {
			it, err := tx.GetItem("s2")
			if err != nil {
				return err
			}
			it.Body += " Ünïcode-aware two-sum variant"
			return tx.UpdateItem(&it)
		})
	}
	for _, q := range storetest.SearchQueries {
		for _, f := range []store.ItemFilter{
			{Query: q, Sort: store.SortCreated, Desc: true},
			{Query: q, Sort: store.SortRelevance, Desc: true}, // the same bm25 scores
			{Query: q, Sort: store.SortRelevance},
			{Query: q, Sort: store.SortTitle, Limit: 2, Offset: 1},
		} {
			got := map[string]string{}
			for name, db := range map[string]store.Store{"SQLite": lite, "PostgreSQL": pg} {
				l := storetest.Read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
					l, _, err := tx.ListItems(f)
					return l, err
				})
				var ids []string
				for _, s := range l {
					ids = append(ids, s.ID)
				}
				got[name] = strings.Join(ids, ",")
			}
			if got["SQLite"] != got["PostgreSQL"] {
				t.Errorf("%+v: SQLite %q, PostgreSQL %q", f, got["SQLite"], got["PostgreSQL"])
			}
		}
	}
}

func TestCopyRefusesADestinationWithData(t *testing.T) {
	for _, dstBackend := range backends {
		t.Run(dstBackend.name, func(t *testing.T) {
			ctx := context.Background()
			src := teststore.OpenSQLite(t)
			storetest.Populate(t, src)
			dst := dstBackend.open(t)
			// Only the built-in presets: empty.
			if empty, err := dbcopy.Empty(ctx, dst); err != nil || !empty {
				t.Fatalf("a new database is not empty: %v", err)
			}
			storetest.Write(t, dst, func(tx store.Tx) error { return tx.SetSetting("preferences", "{}") })
			if empty, _ := dbcopy.Empty(ctx, dst); empty {
				t.Error("a database with a setting is empty")
			}
			before := storetest.Dump(t, dst)
			if _, err := dbcopy.Copy(ctx, src, dst, dbcopy.Options{}); !errors.Is(err, dbcopy.ErrNotEmpty) {
				t.Fatalf("copy into a database with data: %v", err)
			}
			storetest.SameDump(t, "after the refused copy", before, storetest.Dump(t, dst))
			if _, err := dbcopy.Copy(ctx, src, dst, dbcopy.Options{Replace: true}); err != nil {
				t.Fatal(err)
			}
			storetest.SameDump(t, "after replacing", storetest.Dump(t, src), storetest.Dump(t, dst))
		})
	}
}

// An edited built-in preset is the user's data.
func TestEditedBuiltinPresetIsData(t *testing.T) {
	for _, b := range backends {
		t.Run(b.name, func(t *testing.T) {
			db := b.open(t)
			storetest.Write(t, db, func(tx store.Tx) error {
				list, err := tx.ListStylePresets()
				if err != nil {
					return err
				}
				p := list[0]
				p.Instructions += " More."
				p.UpdatedAt = time.Now()
				return tx.UpdateStylePreset(&p)
			})
			if empty, err := dbcopy.Empty(context.Background(), db); err != nil || empty {
				t.Errorf("empty = %v, %v", empty, err)
			}
			storetest.ClearStylePresets(t, db)
			if empty, err := dbcopy.Empty(context.Background(), db); err != nil || !empty {
				t.Errorf("without presets: empty = %v, %v", empty, err)
			}
		})
	}
}

// failingBulk fails the copy after some rows have been written.
type failingBulk struct {
	store.Bulk
	after int
}

func (f failingBulk) Import(ctx context.Context, fn func(store.Load) error) error {
	return f.Bulk.Import(ctx, func(l store.Load) error { return fn(&failingLoad{Load: l, left: f.after}) })
}

type failingLoad struct {
	store.Load
	left int
}

func (l *failingLoad) Insert(t store.Table, row []any) error {
	if l.left--; l.left < 0 {
		return errors.New("disk on fire")
	}
	return l.Load.Insert(t, row)
}

// A copy that fails part-way leaves the destination as it was.
func TestFailedCopyChangesNothing(t *testing.T) {
	for _, dstBackend := range backends {
		t.Run(dstBackend.name, func(t *testing.T) {
			ctx := context.Background()
			src := teststore.OpenSQLite(t)
			storetest.Populate(t, src)
			dst := dstBackend.open(t)
			before := storetest.Dump(t, dst)
			_, err := dbcopy.Copy(ctx, src, failingBulk{Bulk: dst, after: 20}, dbcopy.Options{})
			if err == nil || !strings.Contains(err.Error(), "disk on fire") {
				t.Fatalf("copy: %v", err)
			}
			storetest.SameDump(t, "after the failed copy", before, storetest.Dump(t, dst))
			if empty, _ := dbcopy.Empty(ctx, dst); !empty {
				t.Error("the destination is no longer empty")
			}
		})
	}
}

func TestSummary(t *testing.T) {
	got := dbcopy.Summary([]store.TableCount{{Table: "items", Rows: 2}, {Table: "settings", Rows: 1}, {Table: "solutions"}})
	if got != "2 items, 1 setting" {
		t.Errorf("summary: %q", got)
	}
	if got := dbcopy.Summary(nil); got != "nothing" {
		t.Errorf("empty summary: %q", got)
	}
}
