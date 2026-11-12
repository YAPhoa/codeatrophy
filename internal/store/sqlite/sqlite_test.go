package sqlite

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

func openTest(t *testing.T) *DB {
	t.Helper()
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

var now = time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)

func item(id, title string, typ domain.ItemType, tags ...string) domain.Item {
	it := domain.Item{ItemSummary: domain.ItemSummary{ID: id, Type: typ, Title: title, Tags: tags,
		Status: domain.StatusTodo, Revision: 1, CreatedAt: now, UpdatedAt: now}}
	if typ == domain.TypeProblem {
		it.Problem = domain.DefaultProblemSpec()
	}
	return it
}

func write(t *testing.T, db *DB, fn func(store.Tx) error) {
	t.Helper()
	if err := db.Write(context.Background(), fn); err != nil {
		t.Fatal(err)
	}
}

func read[T any](t *testing.T, db *DB, fn func(store.Tx) (T, error)) T {
	t.Helper()
	var out T
	if err := db.Read(context.Background(), func(tx store.Tx) error {
		var err error
		out, err = fn(tx)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestItemRoundTrip(t *testing.T) {
	db := openTest(t)
	it := item("i1", "Two Sum", domain.TypeProblem, "array", "hash-map")
	d := domain.DifficultyEasy
	url, raw := "https://x.test", "raw text"
	it.Difficulty, it.Source.URL, it.RawInput, it.Notes, it.Favorite = &d, &url, &raw, "notes", true
	it.Problem.StarterCode = map[string]string{"python": "print()"}
	write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		return tx.InsertSolution(&domain.ItemSolution{ID: "s1", ItemID: "i1", Name: "Reference solution",
			Language: "python", Source: "print(1)", IsReference: true, CreatedAt: now, UpdatedAt: now})
	})
	got := read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("i1") })
	if got.Title != "Two Sum" || *got.Difficulty != d || *got.Source.URL != url || *got.RawInput != raw ||
		!got.Favorite || got.Notes != "notes" || got.Problem.StarterCode["python"] != "print()" ||
		got.Problem.ReferenceSolution.Source != "print(1)" || len(got.Tags) != 2 || !got.CreatedAt.Equal(now) {
		t.Errorf("round trip mismatch: %+v", got)
	}
	reading := item("r1", "Notes", domain.TypeReading)
	write(t, db, func(tx store.Tx) error { return tx.InsertItem(&reading) })
	got = read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("r1") })
	if got.Problem != nil || got.Tags == nil || got.CollectionIDs == nil {
		t.Errorf("reading: %+v", got)
	}
	err := db.Read(context.Background(), func(tx store.Tx) error { _, err := tx.GetItem("nope"); return err })
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing item: %v", err)
	}
}

func TestSearchAndFilters(t *testing.T) {
	db := openTest(t)
	write(t, db, func(tx store.Tx) error {
		items := []domain.Item{
			item("a", "Longest increasing subsequence", domain.TypeProblem, "dp"),
			item("b", "Knapsack", domain.TypeProblem, "dp", "classic"),
			item("c", "Raft consensus", domain.TypeReading, "distributed"),
		}
		items[1].Body = "A dynamic programming classic about subsequence choices."
		hard := domain.DifficultyHard
		items[1].Difficulty = &hard
		items[2].Status = domain.StatusDone
		for i := range items {
			items[i].UpdatedAt = now.Add(time.Duration(i) * time.Minute)
			if err := tx.InsertItem(&items[i]); err != nil {
				return err
			}
		}
		return nil
	})
	ids := func(f store.ItemFilter) string {
		list := read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
			l, _, err := tx.ListItems(f)
			return l, err
		})
		var out []string
		for _, s := range list {
			out = append(out, s.ID)
		}
		return strings.Join(out, ",")
	}
	cases := []struct {
		f    store.ItemFilter
		want string
	}{
		{store.ItemFilter{Sort: store.SortUpdated, Desc: true}, "c,b,a"},
		{store.ItemFilter{Query: "subseq", Sort: store.SortRelevance, Desc: true}, "a,b"}, // best match first
		{store.ItemFilter{Query: "subseq", Sort: store.SortRelevance}, "b,a"},
		{store.ItemFilter{IDs: []string{"c", "a", "zzz"}, Sort: store.SortTitle}, "a,c"},
		{store.ItemFilter{Query: "DP"}, "a,b"}, // tags are searched
		{store.ItemFilter{Query: "raft consensus"}, "c"},
		{store.ItemFilter{Query: `"); DROP TABLE items; --`}, ""},
		{store.ItemFilter{Type: domain.TypeReading}, "c"},
		{store.ItemFilter{Statuses: []domain.ItemStatus{domain.StatusTodo}}, "a,b"},
		{store.ItemFilter{Difficulties: []string{"none"}}, "a,c"},
		{store.ItemFilter{Difficulties: []string{"hard", "easy"}}, "b"},
		{store.ItemFilter{Tags: []string{"dp", "classic"}}, "b"},
		{store.ItemFilter{Sort: store.SortTitle}, "b,a,c"},
		{store.ItemFilter{Sort: store.SortDifficulty}, "b,a,c"},
		{store.ItemFilter{Sort: store.SortUpdated, Desc: true, Limit: 1, Offset: 1}, "b"},
	}
	for _, c := range cases {
		if got := ids(c.f); got != c.want {
			t.Errorf("%+v: got %q, want %q", c.f, got, c.want)
		}
	}
	_, total, err := func() ([]domain.ItemSummary, int, error) {
		var l []domain.ItemSummary
		var n int
		err := db.Read(context.Background(), func(tx store.Tx) error {
			var err error
			l, n, err = tx.ListItems(store.ItemFilter{Limit: 1})
			return err
		})
		return l, n, err
	}()
	if err != nil || total != 3 {
		t.Errorf("total before pagination = %d, %v", total, err)
	}
	// The index follows updates.
	write(t, db, func(tx store.Tx) error {
		it, _ := tx.GetItem("c")
		it.Title = "Paxos"
		return tx.UpdateItem(&it)
	})
	if got := ids(store.ItemFilter{Query: "raft"}); got != "" {
		t.Errorf("stale index: %q", got)
	}
	if got := ids(store.ItemFilter{Query: "paxos"}); got != "c" {
		t.Errorf("updated index: %q", got)
	}
}

func TestCollectionsMembershipAndComputedFields(t *testing.T) {
	db := openTest(t)
	parent := "c1"
	write(t, db, func(tx store.Tx) error {
		for _, it := range []domain.Item{item("a", "A", domain.TypeProblem), item("b", "B", domain.TypeProblem), item("v", "V", domain.TypeProblem)} {
			if err := tx.InsertItem(&it); err != nil {
				return err
			}
		}
		v, _ := tx.GetItem("v")
		a := "a"
		v.VariantOf = &a
		if err := tx.UpdateItem(&v); err != nil {
			return err
		}
		for _, c := range []domain.Collection{{ID: "c1", Name: "Root", CreatedAt: now, UpdatedAt: now},
			{ID: "c2", Name: "Child", ParentID: &parent, CreatedAt: now, UpdatedAt: now}} {
			if err := tx.InsertCollection(&c); err != nil {
				return err
			}
		}
		if err := tx.AddCollectionItems("c1", []string{"b", "a", "b"}); err != nil {
			return err
		}
		if err := tx.AddCollectionItems("c2", []string{"v"}); err != nil {
			return err
		}
		tc := domain.TestCase{ID: "t1", ItemID: "a", Origin: domain.OriginManual, CreatedAt: now, UpdatedAt: now}
		if err := tx.InsertTestCase(&tc); err != nil {
			return err
		}
		v1, v2 := domain.VerdictWrongAnswer, domain.VerdictAccepted
		for i, v := range []*domain.Verdict{&v1, &v2, nil} {
			s := domain.Submission{ID: fmt.Sprint("s", i), ItemID: "a", Mode: domain.ModeSubmit, Language: "python",
				Source: "x", Status: domain.SubmissionCompleted, Verdict: v, CreatedAt: now}
			if v == nil {
				s.Status = domain.SubmissionRunning
			}
			if err := tx.InsertSubmission(&s); err != nil {
				return err
			}
		}
		return nil
	})
	order := read(t, db, func(tx store.Tx) ([]string, error) { return tx.CollectionItemIDs("c1") })
	if strings.Join(order, ",") != "b,a" {
		t.Errorf("membership order %v", order)
	}
	a := read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("a") })
	if a.VariantCount != 1 || a.TestCaseCount != 1 || a.LastVerdict == nil || *a.LastVerdict != domain.VerdictAccepted ||
		strings.Join(a.CollectionIDs, ",") != "c1" {
		t.Errorf("computed fields: %+v", a.ItemSummary)
	}
	recursive := read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
		l, _, err := tx.ListItems(store.ItemFilter{CollectionID: "c1", Recursive: true})
		return l, err
	})
	if len(recursive) != 3 {
		t.Errorf("recursive membership: %d items", len(recursive))
	}
	positional := read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
		l, _, err := tx.ListItems(store.ItemFilter{CollectionID: "c1", Sort: store.SortPosition})
		return l, err
	})
	if len(positional) != 2 || positional[0].ID != "b" {
		t.Errorf("position sort: %+v", positional)
	}
	// Deleting an item clears variantOf on its variants and cascades.
	write(t, db, func(tx store.Tx) error {
		ok, err := tx.DeleteItem("a")
		if !ok || err != nil {
			return fmt.Errorf("delete: %v %v", ok, err)
		}
		return nil
	})
	v := read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("v") })
	if v.VariantOf != nil {
		t.Error("variantOf should be cleared")
	}
	if n := read(t, db, func(tx store.Tx) (domain.Stats, error) { return tx.Stats() }).Submissions.Total; n != 0 {
		t.Errorf("submissions not deleted with the item: %d", n)
	}
}

func TestSubmissionResultsAndUnfinished(t *testing.T) {
	db := openTest(t)
	it := item("a", "A", domain.TypeProblem)
	write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		in := "custom"
		s := domain.Submission{ID: "s1", ItemID: "a", Mode: domain.ModeRun, Language: "python", Source: "x",
			Status: domain.SubmissionQueued, TotalCount: 2, Stdin: &in, CreatedAt: now}
		if err := tx.InsertSubmission(&s); err != nil {
			return err
		}
		ms := 5
		for _, i := range []int{1, 0} {
			if err := tx.AddSubmissionResult("s1", i, domain.SubmissionResult{Name: fmt.Sprint(i),
				Verdict: domain.VerdictAccepted, TimeMs: &ms}); err != nil {
				return err
			}
		}
		return nil
	})
	s := read(t, db, func(tx store.Tx) (domain.Submission, error) { return tx.GetSubmission("s1") })
	if len(s.Results) != 2 || s.Results[0].Name != "0" || *s.Stdin != "custom" || s.Verdict != nil {
		t.Errorf("submission: %+v", s)
	}
	ids := read(t, db, func(tx store.Tx) ([]string, error) { return tx.UnfinishedSubmissionIDs() })
	if len(ids) != 1 {
		t.Errorf("unfinished: %v", ids)
	}
}

func TestStylePresetConstraints(t *testing.T) {
	db := openTest(t)
	insert := func(id, name string, def bool) error {
		return db.Write(context.Background(), func(tx store.Tx) error {
			return tx.InsertStylePreset(&domain.StylePreset{ID: id, Name: name, Instructions: "x", IsDefault: def, CreatedAt: now, UpdatedAt: now})
		})
	}
	if err := insert("p1", "LeetCode", true); err != nil {
		t.Fatal(err)
	}
	if err := insert("p2", "leetcode", false); err == nil {
		t.Error("the database should reject a case-insensitive duplicate name")
	}
	if err := insert("p3", "Other", true); err == nil {
		t.Error("the database should reject a second default")
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		return tx.InsertStylePreset(&domain.StylePreset{ID: "p4", Name: strings.Repeat("n", 61), Instructions: "x", CreatedAt: now, UpdatedAt: now})
	}); err == nil {
		t.Error("the database should reject a 61-character name")
	}
	for _, name := range []string{"two\nlines", "tab\tname"} {
		if err := insert("p5", name, false); err == nil {
			t.Errorf("the database should reject the multi-line name %q", name)
		}
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		p, _ := tx.GetStylePreset("p1")
		p.Name = "re\nnamed"
		return tx.UpdateStylePreset(&p)
	}); err == nil {
		t.Error("the database should reject renaming to a multi-line name")
	}
	for i := 2; i <= 20; i++ {
		if err := insert(fmt.Sprint("q", i), fmt.Sprint("name ", i), false); err != nil {
			t.Fatalf("preset %d: %v", i, err)
		}
	}
	if err := insert("q21", "one too many", false); err == nil {
		t.Error("the database should reject a 21st preset")
	}
	list := read(t, db, func(tx store.Tx) ([]domain.StylePreset, error) { return tx.ListStylePresets() })
	if len(list) != 20 || !list[0].IsDefault {
		t.Errorf("list: %d presets, first default=%v", len(list), list[0].IsDefault)
	}
}

func TestMigrationsAreIdempotentAndForwardOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.db")
	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(context.Background(), path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if _, err := db.writer.Exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', 0)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := Open(context.Background(), path); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Errorf("opening a newer schema: %v", err)
	}
}

func TestRollbackOnError(t *testing.T) {
	db := openTest(t)
	it := item("a", "A", domain.TypeReading)
	err := db.Write(context.Background(), func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		return errors.New("abort")
	})
	if err == nil {
		t.Fatal("expected the error back")
	}
	err = db.Read(context.Background(), func(tx store.Tx) error { _, err := tx.GetItem("a"); return err })
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("write was not rolled back: %v", err)
	}
}
