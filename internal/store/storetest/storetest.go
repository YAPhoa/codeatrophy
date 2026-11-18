// Package storetest is the conformance suite of store.Store: every backend
// runs it, so each behaviour the application relies on is asserted on each
// backend.
package storetest

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Opener opens a new database, as its migrations leave it, and closes it
// when the test ends.
type Opener func(t *testing.T) store.Store

// Run runs the whole suite against the backend that open creates.
func Run(t *testing.T, open Opener) {
	tests := []struct {
		name string
		fn   func(*testing.T, store.Store)
	}{
		{"ItemRoundTrip", testItemRoundTrip},
		{"FunctionProblemRoundTrip", testFunctionProblemRoundTrip},
		{"SearchAndFilters", testSearchAndFilters},
		{"SearchRules", testSearchRules},
		{"TitleOrder", testTitleOrder},
		{"CollectionsMembershipAndComputedFields", testCollectionsMembershipAndComputedFields},
		{"Collections", testCollections},
		{"TestCases", testTestCases},
		{"TagsStatsSettings", testTagsStatsSettings},
		{"StatsMatchListFilters", testStatsMatchListFilters},
		{"SubmissionResultsAndUnfinished", testSubmissionResultsAndUnfinished},
		{"Submissions", testSubmissions},
		{"DeleteCompletedRuns", testDeleteCompletedRuns},
		{"ArbitraryText", testArbitraryText},
		{"StylePresetConstraints", testStylePresetConstraints},
		{"BuiltinStylePresetsOnANewDatabase", testBuiltinStylePresets},
		{"SolutionConstraints", testSolutionConstraints},
		{"AIProviderConstraints", testAIProviderConstraints},
		{"AIUsage", testAIUsage},
		{"AILog", testAILog},
		{"RollbackOnError", testRollbackOnError},
		{"ReadIsReadOnly", testReadIsReadOnly},
		{"WritesAreSerialised", testWritesAreSerialised},
		{"CancelledContext", testCancelledContext},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { tc.fn(t, open(t)) })
	}
}

var now = time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)

// Item returns a minimal valid item.
func Item(id, title string, typ domain.ItemType, tags ...string) domain.Item {
	it := domain.Item{ItemSummary: domain.ItemSummary{ID: id, Type: typ, Title: title, Tags: tags,
		Status: domain.StatusTodo, Revision: 1, CreatedAt: now, UpdatedAt: now}}
	if typ == domain.TypeProblem {
		it.Problem = domain.DefaultProblemSpec()
	}
	return it
}

// Write runs fn in a write transaction, failing the test on error.
func Write(t *testing.T, db store.Store, fn func(store.Tx) error) {
	t.Helper()
	if err := db.Write(context.Background(), fn); err != nil {
		t.Fatal(err)
	}
}

// Read runs fn in a read transaction, failing the test on error.
func Read[T any](t *testing.T, db store.Store, fn func(store.Tx) (T, error)) T {
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

// ClearStylePresets removes the built-in presets a new database starts with.
func ClearStylePresets(t *testing.T, db store.Store) {
	t.Helper()
	Write(t, db, func(tx store.Tx) error {
		list, err := tx.ListStylePresets()
		if err != nil {
			return err
		}
		for _, p := range list {
			if err := tx.DeleteStylePreset(p.ID); err != nil {
				return err
			}
		}
		return nil
	})
}

func ids(t *testing.T, db store.Store, f store.ItemFilter) string {
	t.Helper()
	list := Read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
		l, _, err := tx.ListItems(f)
		return l, err
	})
	var out []string
	for _, s := range list {
		out = append(out, s.ID)
	}
	return strings.Join(out, ",")
}

// A solution-only problem keeps its interface and its per-language
// harness, including text a backend could mangle, and the database rejects
// an unknown interface. A submission keeps the harness it ran in and its
// line offset.
func testFunctionProblemRoundTrip(t *testing.T, db store.Store) {
	// Harness text arrives as JSON, so it is valid UTF-8, but may hold
	// any character.
	const odd = "a\x00b\x01\r\n\t\ufeff \U0001F642 end"
	it := Item("fn", "Merge k sorted lists", domain.TypeProblem)
	it.Problem.Interface = domain.InterfaceFunction
	it.Problem.StarterCode = map[string]string{"python": "class Solution:\n    def f(self):\n        "}
	it.Problem.Harness = map[string]domain.HarnessCode{
		"python": {Prefix: "from __future__ import annotations\n", Suffix: "\nprint(Solution().f())\n"},
		"java":   {Prefix: "", Suffix: odd},
	}
	Write(t, db, func(tx store.Tx) error { return tx.InsertItem(&it) })
	got := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("fn") })
	if got.Problem.Interface != domain.InterfaceFunction || len(got.Problem.Harness) != 2 ||
		got.Problem.Harness["python"] != it.Problem.Harness["python"] || got.Problem.Harness["java"].Suffix != odd {
		t.Errorf("function problem: %+v", got.Problem)
	}
	listed := Read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
		l, _, err := tx.ListItems(store.ItemFilter{Query: "merge"})
		return l, err
	})
	if len(listed) != 1 {
		t.Errorf("search: %+v", listed)
	}

	// Back to a program: the harness is replaced, not merged.
	got.Problem.Interface, got.Problem.Harness = domain.InterfaceProgram, map[string]domain.HarnessCode{}
	Write(t, db, func(tx store.Tx) error { return tx.UpdateItem(&got) })
	got = Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("fn") })
	if got.Problem.Interface != domain.InterfaceProgram || got.Problem.Harness == nil || len(got.Problem.Harness) != 0 {
		t.Errorf("program again: %+v", got.Problem)
	}
	plain := Item("plain", "Plain", domain.TypeProblem)
	Write(t, db, func(tx store.Tx) error { return tx.InsertItem(&plain) })
	if p := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("plain") }).Problem; p.Interface != domain.InterfaceProgram || p.Harness == nil {
		t.Errorf("default problem: %+v", p)
	}
	bad := Item("bad", "Bad", domain.TypeProblem)
	bad.Problem.Interface = "procedure"
	if err := db.Write(context.Background(), func(tx store.Tx) error { return tx.InsertItem(&bad) }); err == nil {
		t.Error("an unknown interface was stored")
	}

	h := &domain.HarnessCode{Prefix: "import json\n", Suffix: odd}
	sub := domain.Submission{ID: "fs", ItemID: "fn", Mode: domain.ModeRun, Language: "python", Source: "class S: pass",
		LineOffset: 3, Harness: h, Status: domain.SubmissionQueued, CreatedAt: now}
	plainSub := domain.Submission{ID: "ps", ItemID: "fn", Mode: domain.ModeRun, Language: "python", Source: "print(1)",
		Status: domain.SubmissionQueued, CreatedAt: now}
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertSubmission(&sub); err != nil {
			return err
		}
		return tx.InsertSubmission(&plainSub)
	})
	gs := Read(t, db, func(tx store.Tx) (domain.Submission, error) { return tx.GetSubmission("fs") })
	if gs.LineOffset != 3 || gs.Harness == nil || *gs.Harness != *h {
		t.Errorf("submission harness: %+v %+v", gs, gs.Harness)
	}
	if gp := Read(t, db, func(tx store.Tx) (domain.Submission, error) { return tx.GetSubmission("ps") }); gp.Harness != nil || gp.LineOffset != 0 {
		t.Errorf("plain submission: %+v", gp)
	}
	sums := Read(t, db, func(tx store.Tx) ([]domain.SubmissionSummary, error) {
		l, _, err := tx.ListSubmissions("fn", "", 10, 0)
		return l, err
	})
	if len(sums) != 2 || sums[1].LineOffset != 3 || sums[0].LineOffset != 0 {
		t.Errorf("summaries: %+v", sums)
	}
}

func testItemRoundTrip(t *testing.T, db store.Store) {
	it := Item("i1", "Two Sum", domain.TypeProblem, "array", "hash-map")
	d := domain.DifficultyEasy
	url, raw, note := "https://x.test", "raw text", "from a book"
	it.Difficulty, it.Source.URL, it.Source.Note, it.RawInput, it.Notes, it.Favorite = &d, &url, &note, &raw, "notes", true
	it.Summary, it.Body = "sum", "body"
	it.Problem.StarterCode = map[string]string{"python": "print()"}
	it.Problem.TimeLimitMs, it.Problem.MemoryLimitKb, it.Problem.Compare = 1500, 131072, domain.CompareExact
	it.Revision = 7
	it.UpdatedAt = now.Add(time.Hour)
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		return tx.InsertSolution(&domain.ItemSolution{ID: "s1", ItemID: "i1", Name: "Reference solution",
			Language: "python", Source: "print(1)", IsReference: true, CreatedAt: now, UpdatedAt: now})
	})
	got := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("i1") })
	if got.Title != "Two Sum" || *got.Difficulty != d || *got.Source.URL != url || *got.Source.Note != note ||
		*got.RawInput != raw || !got.Favorite || got.Notes != "notes" || got.Summary != "sum" || got.Body != "body" ||
		got.Problem.StarterCode["python"] != "print()" || got.Problem.TimeLimitMs != 1500 ||
		got.Problem.MemoryLimitKb != 131072 || got.Problem.Compare != domain.CompareExact ||
		got.Problem.ReferenceSolution.Source != "print(1)" || strings.Join(got.Tags, ",") != "array,hash-map" ||
		!got.CreatedAt.Equal(now) || !got.UpdatedAt.Equal(now.Add(time.Hour)) || got.Revision != 7 ||
		got.SolutionCount != 1 || got.CreatedAt.Location() != time.UTC {
		t.Errorf("round trip mismatch: %+v", got)
	}
	reading := Item("r1", "Notes", domain.TypeReading)
	Write(t, db, func(tx store.Tx) error { return tx.InsertItem(&reading) })
	got = Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("r1") })
	if got.Problem != nil || got.Tags == nil || got.CollectionIDs == nil || got.Difficulty != nil || got.RawInput != nil ||
		got.Source.URL != nil {
		t.Errorf("reading: %+v", got)
	}
	err := db.Read(context.Background(), func(tx store.Tx) error { _, err := tx.GetItem("nope"); return err })
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing item: %v", err)
	}
	missing := Item("nope", "x", domain.TypeReading)
	if err := db.Write(context.Background(), func(tx store.Tx) error { return tx.UpdateItem(&missing) }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("updating a missing item: %v", err)
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error { return tx.InsertItem(&reading) }); err == nil {
		t.Error("a duplicate id was accepted")
	}
	// Sub-second precision is not kept.
	frac := Item("f", "F", domain.TypeReading)
	frac.CreatedAt = now.Add(1500 * time.Millisecond)
	Write(t, db, func(tx store.Tx) error { return tx.InsertItem(&frac) })
	if got := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("f") }); !got.CreatedAt.Equal(now.Add(time.Second)) {
		t.Errorf("timestamp: %v", got.CreatedAt)
	}
	all := Read(t, db, func(tx store.Tx) ([]string, error) { return tx.AllItemIDs() })
	exist := Read(t, db, func(tx store.Tx) (map[string]bool, error) { return tx.ExistingItemIDs([]string{"i1", "zz", "f"}) })
	if strings.Join(all, ",") != "i1,r1,f" || len(exist) != 2 || !exist["i1"] || !exist["f"] {
		t.Errorf("all %v, existing %v", all, exist)
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		if ok, err := tx.DeleteItem("zz"); ok || err != nil {
			return fmt.Errorf("deleting a missing item: %v %v", ok, err)
		}
		return nil
	}); err != nil {
		t.Error(err)
	}
}

func testSearchAndFilters(t *testing.T, db store.Store) {
	Write(t, db, func(tx store.Tx) error {
		items := []domain.Item{
			Item("a", "Longest increasing subsequence", domain.TypeProblem, "dp"),
			Item("b", "Knapsack", domain.TypeProblem, "dp", "classic"),
			Item("c", "Raft consensus", domain.TypeReading, "distributed"),
		}
		items[1].Body = "A dynamic programming classic about subsequence choices."
		hard := domain.DifficultyHard
		items[1].Difficulty = &hard
		items[2].Status = domain.StatusDone
		items[2].Favorite = true
		for i := range items {
			items[i].UpdatedAt = now.Add(time.Duration(i) * time.Minute)
			items[i].CreatedAt = now.Add(-time.Duration(i) * time.Minute)
			if err := tx.InsertItem(&items[i]); err != nil {
				return err
			}
		}
		return nil
	})
	yes, no := true, false
	cases := []struct {
		f    store.ItemFilter
		want string
	}{
		{store.ItemFilter{Sort: store.SortUpdated, Desc: true}, "c,b,a"},
		{store.ItemFilter{Sort: store.SortCreated}, "c,b,a"},
		{store.ItemFilter{Query: "subseq", Sort: store.SortRelevance, Desc: true}, "a,b"}, // best match first
		{store.ItemFilter{Query: "subseq", Sort: store.SortRelevance}, "b,a"},
		{store.ItemFilter{IDs: []string{"c", "a", "zzz"}, Sort: store.SortTitle}, "a,c"},
		{store.ItemFilter{Query: "DP"}, "a,b"}, // tags are searched
		{store.ItemFilter{Query: "raft consensus"}, "c"},
		{store.ItemFilter{Query: `"); DROP TABLE items; --`}, ""},
		{store.ItemFilter{Query: "---"}, ""},
		{store.ItemFilter{Type: domain.TypeReading}, "c"},
		{store.ItemFilter{Statuses: []domain.ItemStatus{domain.StatusTodo}}, "a,b"},
		{store.ItemFilter{Statuses: []domain.ItemStatus{domain.StatusTodo, domain.StatusDone}}, "a,b,c"},
		{store.ItemFilter{Difficulties: []string{"none"}}, "a,c"},
		{store.ItemFilter{Difficulties: []string{"hard", "easy"}}, "b"},
		{store.ItemFilter{Difficulties: []string{"hard", "none"}}, "a,b,c"},
		{store.ItemFilter{Tags: []string{"dp", "classic"}}, "b"},
		{store.ItemFilter{Favorite: &yes}, "c"},
		{store.ItemFilter{Favorite: &no}, "a,b"},
		{store.ItemFilter{Sort: store.SortTitle}, "b,a,c"},
		{store.ItemFilter{Sort: store.SortTitle, Desc: true}, "c,a,b"},
		{store.ItemFilter{Sort: store.SortDifficulty}, "b,a,c"},
		{store.ItemFilter{Sort: store.SortDifficulty, Desc: true}, "b,a,c"},
		{store.ItemFilter{Sort: store.SortUpdated, Desc: true, Limit: 1, Offset: 1}, "b"},
		{store.ItemFilter{Sort: store.SortUpdated, Offset: 1}, "b,c"},
		{store.ItemFilter{Query: "dp", Tags: []string{"classic"}, Sort: store.SortRelevance, Desc: true}, "b"},
	}
	for _, c := range cases {
		if got := ids(t, db, c.f); got != c.want {
			t.Errorf("%+v: got %q, want %q", c.f, got, c.want)
		}
	}
	var total int
	if err := db.Read(context.Background(), func(tx store.Tx) error {
		var err error
		_, total, err = tx.ListItems(store.ItemFilter{Limit: 1})
		return err
	}); err != nil || total != 3 {
		t.Errorf("total before pagination = %d, %v", total, err)
	}
	// The index follows updates and deletions.
	Write(t, db, func(tx store.Tx) error {
		it, _ := tx.GetItem("c")
		it.Title = "Paxos"
		it.Tags = []string{"consensus"}
		return tx.UpdateItem(&it)
	})
	if got := ids(t, db, store.ItemFilter{Query: "raft"}); got != "" {
		t.Errorf("stale index: %q", got)
	}
	if got := ids(t, db, store.ItemFilter{Query: "paxos"}); got != "c" {
		t.Errorf("updated index: %q", got)
	}
	if got := ids(t, db, store.ItemFilter{Query: "distributed"}); got != "" {
		t.Errorf("stale tags in the index: %q", got)
	}
	Write(t, db, func(tx store.Tx) error { _, err := tx.DeleteItem("c"); return err })
	if got := ids(t, db, store.ItemFilter{Query: "paxos"}); got != "" {
		t.Errorf("deleted item still found: %q", got)
	}
}

// SearchCorpus is a set of items for comparing search between backends.
func SearchCorpus() []domain.Item {
	mk := func(id, title, summary, body string, tags ...string) domain.Item {
		it := Item(id, title, domain.TypeReading, tags...)
		it.Summary, it.Body = summary, body
		return it
	}
	return []domain.Item{
		mk("s1", "Two Sum", "Find two numbers that add up to a target.", "Use a hash map: O(n) time.", "array", "hash-map"),
		mk("s2", "Three sum", "", "Sort first, then two pointers. Harder than two-sum.", "array", "two-pointers"),
		mk("s3", "Café façade naïve", "Ünïcödé text", "Résumé of the CAFÉ problem", "strings"),
		mk("s4", "C++ templates", "", "std::vector<int> and C# generics; x86_64 assembly", "c++", "c#"),
		mk("s5", "Dijkstra's shortest paths", "Graphs", strings.Repeat("filler word ", 20000)+"needle at the end two sum",
			"graphs"),
		mk("s6", "中文 日本語", "Ελληνικά άλφα", "Кириллица ёжик", "unicode"),
		mk("s7", "snake_case and CamelCase", "kebab-case", "1.5e-3 2^31-1 O(n log n)", "naming"),
	}
}

// SearchQueries are queries for comparing search between backends.
var SearchQueries = []string{
	"two", "two sum", "two-sum", "sum two", "tw", "su", "hash", "hash-map", "map", "o(n)", "n",
	"cafe", "CAFÉ", "facade", "naive", "unicode", "resume", "c++", "c#", "c", "x86", "std::vector", "vector<int>",
	"needle", "end two", "at the end", "dijkstra", "dijkstra's", "s", "中文", "日本", "ελληνικα", "αλφα", "ёжик", "ежик",
	"snake", "case", "camelcase", "kebab-case", "1.5e", "2^31", "log", "graphs", "array two", "array graphs", "zzz",
	"filler", "---", `"quoted"`, "two\tsum",
}

func testSearchRules(t *testing.T, db store.Store) {
	Write(t, db, func(tx store.Tx) error {
		for _, it := range SearchCorpus() {
			if err := tx.InsertItem(&it); err != nil {
				return err
			}
		}
		return nil
	})
	cases := map[string]string{
		"two sum":      "s1,s2,s5", // every word, each in any column
		"two-sum":      "s1,s2,s5", // a phrase: adjacent tokens
		"sum two":      "s1,s2,s5",
		"tw":           "s1,s2,s5", // the last token is a prefix
		"um":           "",         // only at a token start
		"cafe":         "s3",       // case and diacritics are folded
		"CAFÉ":         "s3",
		"ünïcödé":      "s3,s6",    // and the tag "unicode"
		"c++":          "s3,s4,s7", // the token "c", a prefix
		"x86":          "s4",
		"needle":       "s5", // at the very end of a long body
		"end two":      "s5",
		"at the end":   "s5",
		"ежик":         "", // ё is not a Latin letter
		"ёжик":         "s6",
		"ελληνικα":     "", // nor is ά
		"中文":           "s6",
		"array graphs": "",
		"zzz":          "",
	}
	for q, want := range cases {
		if got := ids(t, db, store.ItemFilter{Query: q, Sort: store.SortCreated}); got != want {
			t.Errorf("q=%q: got %q, want %q", q, got, want)
		}
	}
	// The best match comes first: the title outweighs the body.
	if got := ids(t, db, store.ItemFilter{Query: "two sum", Sort: store.SortRelevance, Desc: true}); !strings.HasPrefix(got, "s1,") {
		t.Errorf("relevance: %q", got)
	}
}

func testTitleOrder(t *testing.T, db store.Store) {
	// Case is ignored for ASCII letters only, then the byte order decides.
	titles := []string{"zebra", "Äpfel", "apple", "Banana", "éclair", "_under", "10 items", "ant"}
	Write(t, db, func(tx store.Tx) error {
		for i, title := range titles {
			it := Item(fmt.Sprint("t", i), title, domain.TypeReading)
			if err := tx.InsertItem(&it); err != nil {
				return err
			}
		}
		return nil
	})
	list := Read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
		l, _, err := tx.ListItems(store.ItemFilter{Sort: store.SortTitle})
		return l, err
	})
	var got []string
	for _, s := range list {
		got = append(got, s.Title)
	}
	if want := "10 items,_under,ant,apple,Banana,zebra,Äpfel,éclair"; strings.Join(got, ",") != want {
		t.Errorf("title order: %v, want %s", got, want)
	}
}

func testCollectionsMembershipAndComputedFields(t *testing.T, db store.Store) {
	parent := "c1"
	Write(t, db, func(tx store.Tx) error {
		for _, it := range []domain.Item{Item("a", "A", domain.TypeProblem), Item("b", "B", domain.TypeProblem), Item("v", "V", domain.TypeProblem)} {
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
	order := Read(t, db, func(tx store.Tx) ([]string, error) { return tx.CollectionItemIDs("c1") })
	if strings.Join(order, ",") != "b,a" {
		t.Errorf("membership order %v", order)
	}
	a := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("a") })
	if a.VariantCount != 1 || a.TestCaseCount != 1 || a.LastVerdict == nil || *a.LastVerdict != domain.VerdictAccepted ||
		strings.Join(a.CollectionIDs, ",") != "c1" {
		t.Errorf("computed fields: %+v", a.ItemSummary)
	}
	recursive := Read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
		l, _, err := tx.ListItems(store.ItemFilter{CollectionID: "c1", Recursive: true})
		return l, err
	})
	if len(recursive) != 3 {
		t.Errorf("recursive membership: %d items", len(recursive))
	}
	if got := ids(t, db, store.ItemFilter{CollectionID: "c1", Sort: store.SortPosition}); got != "b,a" {
		t.Errorf("position sort: %q", got)
	}
	if got := ids(t, db, store.ItemFilter{CollectionID: "c1", Sort: store.SortPosition, Desc: true}); got != "a,b" {
		t.Errorf("position sort, descending: %q", got)
	}
	if got := ids(t, db, store.ItemFilter{VariantOf: "a"}); got != "v" {
		t.Errorf("variants: %q", got)
	}
	// Deleting an item clears variantOf on its variants and cascades.
	Write(t, db, func(tx store.Tx) error {
		ok, err := tx.DeleteItem("a")
		if !ok || err != nil {
			return fmt.Errorf("delete: %v %v", ok, err)
		}
		return nil
	})
	v := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("v") })
	if v.VariantOf != nil {
		t.Error("variantOf should be cleared")
	}
	if n := Read(t, db, func(tx store.Tx) (domain.Stats, error) { return tx.Stats() }).Submissions.Total; n != 0 {
		t.Errorf("submissions not deleted with the item: %d", n)
	}
	if order := Read(t, db, func(tx store.Tx) ([]string, error) { return tx.CollectionItemIDs("c1") }); strings.Join(order, ",") != "b" {
		t.Errorf("membership not deleted with the item: %v", order)
	}
}

func testCollections(t *testing.T, db store.Store) {
	p := func(s string) *string { return &s }
	Write(t, db, func(tx store.Tx) error {
		for _, id := range []string{"a", "b", "c"} {
			it := Item(id, strings.ToUpper(id), domain.TypeReading)
			if err := tx.InsertItem(&it); err != nil {
				return err
			}
		}
		for _, c := range []domain.Collection{
			{ID: "r2", Name: "Second root", Position: 1, CreatedAt: now, UpdatedAt: now},
			{ID: "r1", Name: "First root", Description: "desc", Position: 0, CreatedAt: now, UpdatedAt: now},
			{ID: "k2", Name: "Kid 2", ParentID: p("r1"), Position: 1, CreatedAt: now, UpdatedAt: now},
			{ID: "k1", Name: "Kid 1", ParentID: p("r1"), Position: 0, CreatedAt: now, UpdatedAt: now},
			{ID: "g1", Name: "Grandkid", ParentID: p("k1"), Position: 0, CreatedAt: now, UpdatedAt: now},
		} {
			if err := tx.InsertCollection(&c); err != nil {
				return err
			}
		}
		if err := tx.SetCollectionItemIDs("r1", []string{"c", "a"}); err != nil {
			return err
		}
		if err := tx.SetItemCollections("b", []string{"g1", "r2"}); err != nil {
			return err
		}
		return tx.SetItemCollections("a", []string{"r2"})
	})
	list := Read(t, db, func(tx store.Tx) ([]domain.Collection, error) { return tx.ListCollections() })
	var got []string
	for _, c := range list {
		got = append(got, fmt.Sprintf("%s:%d", c.ID, c.ItemCount))
	}
	// Roots first, then by parent id, position and creation.
	if strings.Join(got, ",") != "r1:1,r2:2,g1:1,k1:0,k2:0" {
		t.Errorf("collections: %v", got)
	}
	if got := ids(t, db, store.ItemFilter{CollectionID: "r1", Recursive: true, Sort: store.SortTitle}); got != "b,c" {
		t.Errorf("recursive: %q", got)
	}
	if got := ids(t, db, store.ItemFilter{CollectionID: "r2", Sort: store.SortPosition}); got != "b,a" {
		t.Errorf("r2 positions: %q", got)
	}
	Write(t, db, func(tx store.Tx) error {
		c, err := tx.GetCollection("k2")
		if err != nil {
			return err
		}
		c.Name, c.ParentID, c.Description = "Renamed", nil, "new"
		c.UpdatedAt = now.Add(time.Hour)
		if err := tx.UpdateCollection(&c); err != nil {
			return err
		}
		if ok, err := tx.RemoveCollectionItem("r2", "a"); !ok || err != nil {
			return fmt.Errorf("remove: %v %v", ok, err)
		}
		if ok, _ := tx.RemoveCollectionItem("r2", "a"); ok {
			return errors.New("removed twice")
		}
		return tx.DeleteCollection("r1") // children become roots
	})
	k2 := Read(t, db, func(tx store.Tx) (domain.Collection, error) { return tx.GetCollection("k2") })
	k1 := Read(t, db, func(tx store.Tx) (domain.Collection, error) { return tx.GetCollection("k1") })
	if k2.Name != "Renamed" || k2.ParentID != nil || k2.Description != "new" || !k2.UpdatedAt.Equal(now.Add(time.Hour)) ||
		!k2.CreatedAt.Equal(now) || k1.ParentID != nil {
		t.Errorf("after update and delete: %+v %+v", k2, k1)
	}
	if got := ids(t, db, store.ItemFilter{Uncollected: true}); got != "a,c" {
		t.Errorf("uncollected: %q", got)
	}
	for _, fn := range []func(store.Tx) error{
		func(tx store.Tx) error { _, err := tx.GetCollection("r1"); return err },
		func(tx store.Tx) error { return tx.DeleteCollection("r1") },
		func(tx store.Tx) error {
			return tx.UpdateCollection(&domain.Collection{ID: "nope", Name: "x", CreatedAt: now, UpdatedAt: now})
		},
	} {
		if err := db.Write(context.Background(), fn); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("missing collection: %v", err)
		}
	}
}

func testTestCases(t *testing.T, db store.Store) {
	it := Item("p", "P", domain.TypeProblem)
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		for i, id := range []string{"x", "y", "z"} {
			tc := domain.TestCase{ID: id, ItemID: "p", Position: i, Name: "case " + id, Stdin: id + "\n",
				ExpectedStdout: strings.ToUpper(id), IsSample: i == 0, Origin: domain.OriginAI, Verified: i == 1,
				CreatedAt: now, UpdatedAt: now}
			if err := tx.InsertTestCase(&tc); err != nil {
				return err
			}
		}
		return tx.SetTestCasePositions("p", []string{"z", "x", "y"})
	})
	list := Read(t, db, func(tx store.Tx) ([]domain.TestCase, error) { return tx.ListTestCases("p") })
	if len(list) != 3 || list[0].ID != "z" || list[1].ID != "x" || !list[1].IsSample || !list[2].Verified ||
		list[1].Stdin != "x\n" || list[1].ExpectedStdout != "X" || list[1].Origin != domain.OriginAI || list[1].Name != "case x" {
		t.Errorf("test cases: %+v", list)
	}
	Write(t, db, func(tx store.Tx) error {
		tc, err := tx.GetTestCase("x")
		if err != nil {
			return err
		}
		tc.Stdin, tc.Verified, tc.UpdatedAt = "new", true, now.Add(time.Minute)
		if err := tx.UpdateTestCase(&tc); err != nil {
			return err
		}
		return tx.DeleteTestCase("y")
	})
	x := Read(t, db, func(tx store.Tx) (domain.TestCase, error) { return tx.GetTestCase("x") })
	if x.Stdin != "new" || !x.Verified || !x.UpdatedAt.Equal(now.Add(time.Minute)) {
		t.Errorf("updated case: %+v", x)
	}
	for _, fn := range []func(store.Tx) error{
		func(tx store.Tx) error { _, err := tx.GetTestCase("y"); return err },
		func(tx store.Tx) error { return tx.DeleteTestCase("y") },
		func(tx store.Tx) error {
			return tx.UpdateTestCase(&domain.TestCase{ID: "y", ItemID: "p", Origin: domain.OriginManual})
		},
	} {
		if err := db.Write(context.Background(), fn); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("missing test case: %v", err)
		}
	}
	Write(t, db, func(tx store.Tx) error { return tx.DeleteTestCases("p") })
	if n := len(Read(t, db, func(tx store.Tx) ([]domain.TestCase, error) { return tx.ListTestCases("p") })); n != 0 {
		t.Errorf("%d cases left", n)
	}
}

// testStatsMatchListFilters checks that the favorite and uncollected counts
// of Stats are the totals of the list filtered by favorite=true and by
// uncollected alone, so the two definitions cannot drift apart.
func testStatsMatchListFilters(t *testing.T, db store.Store) {
	check := func(step string, favorites, uncollected int) {
		t.Helper()
		yes := true
		var s domain.Stats
		var fav, unc int
		if err := db.Read(context.Background(), func(tx store.Tx) error {
			var err error
			if s, err = tx.Stats(); err != nil {
				return err
			}
			if _, fav, err = tx.ListItems(store.ItemFilter{Favorite: &yes, Limit: 1}); err != nil {
				return err
			}
			_, unc, err = tx.ListItems(store.ItemFilter{Uncollected: true, Limit: 1})
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if s.Items.Favorites != fav || s.Items.Uncollected != unc {
			t.Errorf("%s: stats favorites=%d uncollected=%d, list totals %d and %d",
				step, s.Items.Favorites, s.Items.Uncollected, fav, unc)
		}
		if s.Items.Favorites != favorites || s.Items.Uncollected != uncollected {
			t.Errorf("%s: favorites=%d uncollected=%d, want %d and %d",
				step, s.Items.Favorites, s.Items.Uncollected, favorites, uncollected)
		}
	}
	check("empty", 0, 0)

	parent, child := "top", "nested"
	Write(t, db, func(tx store.Tx) error {
		for _, c := range []domain.Collection{
			{ID: parent, Name: "Top", CreatedAt: now, UpdatedAt: now},
			{ID: child, Name: "Nested", ParentID: &parent, CreatedAt: now, UpdatedAt: now},
			{ID: "empty", Name: "Empty", CreatedAt: now, UpdatedAt: now},
		} {
			if err := tx.InsertCollection(&c); err != nil {
				return err
			}
		}
		base := "fu"
		items := []domain.Item{
			Item("fu", "Favorite, uncollected", domain.TypeProblem),
			Item("ft", "Favorite, in top", domain.TypeReading),
			Item("fn", "Favorite, only in nested", domain.TypeProblem),
			Item("nu", "Plain, uncollected", domain.TypeReading),
			Item("nn", "Plain, only in nested", domain.TypeProblem),
			Item("nb", "Plain, in both", domain.TypeProblem),
			Item("vu", "Favorite variant, uncollected", domain.TypeProblem),
		}
		for _, i := range []int{0, 1, 2, 6} {
			items[i].Favorite = true
		}
		items[3].Status = domain.StatusDone
		items[6].VariantOf = &base
		for i := range items {
			if err := tx.InsertItem(&items[i]); err != nil {
				return err
			}
		}
		if err := tx.SetCollectionItemIDs(parent, []string{"ft", "nb"}); err != nil {
			return err
		}
		return tx.SetCollectionItemIDs(child, []string{"fn", "nn", "nb"})
	})
	// Favorites: fu, ft, fn, vu. Uncollected: fu, nu, vu.
	check("seeded", 4, 3)

	Write(t, db, func(tx store.Tx) error {
		if _, err := tx.RemoveCollectionItem(child, "fn"); err != nil {
			return err
		}
		it, err := tx.GetItem("nu")
		if err != nil {
			return err
		}
		it.Favorite = true
		return tx.UpdateItem(&it)
	})
	// Favorites gain nu; fn leaves its only collection.
	check("after changes", 5, 4)

	Write(t, db, func(tx store.Tx) error { return tx.DeleteCollection(child) })
	// Deleting the nested collection leaves nn uncollected; nb stays in top.
	check("after deleting a collection", 5, 5)
}

func testTagsStatsSettings(t *testing.T, db store.Store) {
	Write(t, db, func(tx store.Tx) error {
		items := []domain.Item{Item("a", "A", domain.TypeProblem, "c++", "c#", "z"), Item("b", "B", domain.TypeReading, "c#"),
			Item("c", "C", domain.TypeProblem, "ä")}
		easy := domain.DifficultyEasy
		items[0].Difficulty = &easy
		items[1].Status = domain.StatusDone
		for i := range items {
			if err := tx.InsertItem(&items[i]); err != nil {
				return err
			}
		}
		if err := tx.InsertCollection(&domain.Collection{ID: "k", Name: "K", CreatedAt: now, UpdatedAt: now}); err != nil {
			return err
		}
		acc := domain.VerdictAccepted
		for i, mode := range []domain.SubmissionMode{domain.ModeSubmit, domain.ModeRun, domain.ModeSubmit} {
			s := domain.Submission{ID: fmt.Sprint("s", i), ItemID: "a", Mode: mode, Language: "python", Source: "x",
				Status: domain.SubmissionCompleted, Verdict: &acc, CreatedAt: now}
			if i == 2 {
				wa := domain.VerdictWrongAnswer
				s.Verdict = &wa
			}
			if err := tx.InsertSubmission(&s); err != nil {
				return err
			}
		}
		return nil
	})
	tags := Read(t, db, func(tx store.Tx) ([]domain.Tag, error) { return tx.ListTags() })
	var got []string
	for _, tg := range tags {
		got = append(got, fmt.Sprintf("%s=%d", tg.Name, tg.Count))
	}
	if strings.Join(got, ",") != "c#=2,c++=1,z=1,ä=1" {
		t.Errorf("tags: %v", got)
	}
	if got := Read(t, db, func(tx store.Tx) ([]string, error) { return tx.ItemIDsWithTag("c#") }); strings.Join(got, ",") != "a,b" {
		t.Errorf("items with tag: %v", got)
	}
	s := Read(t, db, func(tx store.Tx) (domain.Stats, error) { return tx.Stats() })
	if s.Items.Total != 3 || s.Items.ByType["problem"] != 2 || s.Items.ByStatus["done"] != 1 || s.Items.ByDifficulty["easy"] != 1 ||
		s.Items.ByDifficulty["none"] != 2 || s.Collections != 1 || s.Tags != 4 || s.Submissions.Total != 2 || s.Submissions.Accepted != 1 {
		t.Errorf("stats: %+v", s)
	}
	Write(t, db, func(tx store.Tx) error {
		if err := tx.SetSetting("k", "v1"); err != nil {
			return err
		}
		if err := tx.SetSetting("k", "v2"); err != nil {
			return err
		}
		if err := tx.SetSetting("gone", "x"); err != nil {
			return err
		}
		return tx.DeleteSetting("gone")
	})
	v, ok := "", false
	if err := db.Read(context.Background(), func(tx store.Tx) error {
		var err error
		v, ok, err = tx.GetSetting("k")
		if err != nil {
			return err
		}
		if _, found, err := tx.GetSetting("gone"); found || err != nil {
			return fmt.Errorf("deleted setting: %v %v", found, err)
		}
		return nil
	}); err != nil || !ok || v != "v2" {
		t.Errorf("setting: %q %v %v", v, ok, err)
	}
}

func testSubmissionResultsAndUnfinished(t *testing.T, db store.Store) {
	it := Item("a", "A", domain.TypeProblem)
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		in := "custom"
		s := domain.Submission{ID: "s1", ItemID: "a", Mode: domain.ModeRun, Language: "python", Source: "x",
			Status: domain.SubmissionQueued, TotalCount: 2, Stdin: &in, CaseIDs: []string{"t1", "t2"}, CreatedAt: now}
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
		// A result written again replaces the first.
		tcID, exp := "t2", "out"
		return tx.AddSubmissionResult("s1", 1, domain.SubmissionResult{Name: "again", TestCaseID: &tcID, IsSample: true,
			Verdict: domain.VerdictWrongAnswer, Stdin: "in", ExpectedStdout: &exp, Stdout: "o", Stderr: "e"})
	})
	s := Read(t, db, func(tx store.Tx) (domain.Submission, error) { return tx.GetSubmission("s1") })
	if len(s.Results) != 2 || s.Results[0].Name != "0" || *s.Results[0].TimeMs != 5 || *s.Stdin != "custom" || s.Verdict != nil ||
		strings.Join(s.CaseIDs, ",") != "t1,t2" || s.FinishedAt != nil || s.TimeMs != nil {
		t.Errorf("submission: %+v", s)
	}
	if r := s.Results[1]; r.Name != "again" || *r.TestCaseID != "t2" || !r.IsSample || r.Verdict != domain.VerdictWrongAnswer ||
		r.Stdin != "in" || *r.ExpectedStdout != "out" || r.Stdout != "o" || r.Stderr != "e" || r.TimeMs != nil {
		t.Errorf("replaced result: %+v", r)
	}
	ids := Read(t, db, func(tx store.Tx) ([]string, error) { return tx.UnfinishedSubmissionIDs() })
	if len(ids) != 1 {
		t.Errorf("unfinished: %v", ids)
	}
}

func testSubmissions(t *testing.T, db store.Store) {
	it := Item("a", "A", domain.TypeProblem)
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		for i := range 5 {
			mode := domain.ModeSubmit
			if i%2 == 1 {
				mode = domain.ModeRun
			}
			s := domain.Submission{ID: fmt.Sprint("s", i), ItemID: "a", Mode: mode, Language: "cpp", Source: "src",
				Status: domain.SubmissionRunning, CreatedAt: now}
			if err := tx.InsertSubmission(&s); err != nil {
				return err
			}
		}
		s, err := tx.GetSubmission("s0")
		if err != nil {
			return err
		}
		v, ms, kb, msg, fin := domain.VerdictCompileError, 12, 2048, "boom", now.Add(time.Minute)
		s.Status, s.Verdict, s.PassedCount, s.TotalCount, s.TimeMs, s.MemoryKb, s.CompileOutput, s.Error, s.FinishedAt =
			domain.SubmissionCompleted, &v, 1, 3, &ms, &kb, "error: x", &msg, &fin
		return tx.UpdateSubmission(&s)
	})
	s := Read(t, db, func(tx store.Tx) (domain.Submission, error) { return tx.GetSubmission("s0") })
	if s.Status != domain.SubmissionCompleted || *s.Verdict != domain.VerdictCompileError || s.PassedCount != 1 || s.TotalCount != 3 ||
		*s.TimeMs != 12 || *s.MemoryKb != 2048 || s.CompileOutput != "error: x" || *s.Error != "boom" ||
		!s.FinishedAt.Equal(now.Add(time.Minute)) || s.Language != "cpp" || s.Source != "src" || s.CaseIDs == nil {
		t.Errorf("updated submission: %+v", s)
	}
	page := func(mode domain.SubmissionMode, limit, offset int) string {
		var out []string
		var total int
		if err := db.Read(context.Background(), func(tx store.Tx) error {
			list, n, err := tx.ListSubmissions("a", mode, limit, offset)
			for _, s := range list {
				out = append(out, s.ID)
			}
			total = n
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprintf("%d:%s", total, strings.Join(out, ","))
	}
	for _, c := range []struct {
		mode          domain.SubmissionMode
		limit, offset int
		want          string
	}{
		{"", 0, 0, "5:s4,s3,s2,s1,s0"},
		{"", 2, 1, "5:s3,s2"},
		{"", 0, 3, "5:s1,s0"},
		{domain.ModeSubmit, 0, 0, "3:s4,s2,s0"},
		{domain.ModeRun, 1, 0, "2:s3"},
	} {
		if got := page(c.mode, c.limit, c.offset); got != c.want {
			t.Errorf("list %q %d %d: %s, want %s", c.mode, c.limit, c.offset, got, c.want)
		}
	}
	if got := Read(t, db, func(tx store.Tx) ([]string, error) { return tx.UnfinishedSubmissionIDs() }); strings.Join(got, ",") != "s1,s2,s3,s4" {
		t.Errorf("unfinished: %v", got)
	}
	err := db.Write(context.Background(), func(tx store.Tx) error {
		return tx.UpdateSubmission(&domain.Submission{ID: "nope", Status: domain.SubmissionCompleted})
	})
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing submission: %v", err)
	}
	if err := db.Read(context.Background(), func(tx store.Tx) error { _, err := tx.GetSubmission("nope"); return err }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing submission: %v", err)
	}
}

// DeleteCompletedRuns removes only the item's completed runs, with their
// results.
func testDeleteCompletedRuns(t *testing.T, db store.Store) {
	Write(t, db, func(tx store.Tx) error {
		for _, id := range []string{"a", "b"} {
			it := Item(id, id, domain.TypeProblem)
			if err := tx.InsertItem(&it); err != nil {
				return err
			}
		}
		subs := []struct {
			id, item string
			mode     domain.SubmissionMode
			status   domain.SubmissionStatus
		}{
			{"run-done", "a", domain.ModeRun, domain.SubmissionCompleted},
			{"run-queued", "a", domain.ModeRun, domain.SubmissionQueued},
			{"run-running", "a", domain.ModeRun, domain.SubmissionRunning},
			{"submit-done", "a", domain.ModeSubmit, domain.SubmissionCompleted},
			{"other-run", "b", domain.ModeRun, domain.SubmissionCompleted},
		}
		for _, c := range subs {
			s := domain.Submission{ID: c.id, ItemID: c.item, Mode: c.mode, Language: "python", Source: "x",
				Status: c.status, TotalCount: 1, CreatedAt: now}
			if err := tx.InsertSubmission(&s); err != nil {
				return err
			}
			if err := tx.AddSubmissionResult(c.id, 0, domain.SubmissionResult{Name: "1", Verdict: domain.VerdictAccepted}); err != nil {
				return err
			}
		}
		return tx.DeleteCompletedRuns("a")
	})
	list := func(item string) string {
		var out []string
		if err := db.Read(context.Background(), func(tx store.Tx) error {
			l, _, err := tx.ListSubmissions(item, "", 0, 0)
			for _, s := range l {
				out = append(out, s.ID)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return strings.Join(out, ",")
	}
	if got := list("a"); got != "submit-done,run-running,run-queued" {
		t.Errorf("item a after pruning: %s", got)
	}
	if got := list("b"); got != "other-run" {
		t.Errorf("another item's runs: %s", got)
	}
	if err := db.Read(context.Background(), func(tx store.Tx) error { _, err := tx.GetSubmission("run-done"); return err }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("pruned run: %v", err)
	}
	if s := Read(t, db, func(tx store.Tx) (domain.Submission, error) { return tx.GetSubmission("submit-done") }); len(s.Results) != 1 {
		t.Errorf("kept submission results: %+v", s.Results)
	}
}

// ArbitraryText holds the characters a backend could mangle: NUL, other
// control characters, invalid UTF-8, a byte order mark and non-BMP text.
const ArbitraryText = "a\x00b\x01\r\n\t\xff\xfe\ufeff \U0001F642 \U0010FFFD end"

func testArbitraryText(t *testing.T, db store.Store) {
	x := ArbitraryText
	it := Item("p", "Title", domain.TypeProblem)
	it.Summary, it.Body, it.Notes, it.RawInput, it.Source.Note = x, x, x, &x, &x
	it.Problem.StarterCode = map[string]string{"python": "print('\x00')"}
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		if err := tx.InsertCollection(&domain.Collection{ID: "c", Name: "C", Description: x, CreatedAt: now, UpdatedAt: now}); err != nil {
			return err
		}
		tc := domain.TestCase{ID: "t", ItemID: "p", Name: x, Stdin: x, ExpectedStdout: x, Origin: domain.OriginImport,
			CreatedAt: now, UpdatedAt: now}
		if err := tx.InsertTestCase(&tc); err != nil {
			return err
		}
		if err := tx.InsertSolution(&domain.ItemSolution{ID: "sol", ItemID: "p", Name: "n", Language: "c", Source: x,
			Notes: x, CreatedAt: now, UpdatedAt: now}); err != nil {
			return err
		}
		s := domain.Submission{ID: "s", ItemID: "p", Mode: domain.ModeRun, Language: "c", Source: x, Stdin: &x,
			Status: domain.SubmissionCompleted, CompileOutput: x, Error: &x, CreatedAt: now}
		if err := tx.InsertSubmission(&s); err != nil {
			return err
		}
		return tx.AddSubmissionResult("s", 0, domain.SubmissionResult{Name: x, Verdict: domain.VerdictExecuted, Stdin: x,
			ExpectedStdout: &x, Stdout: x, Stderr: x})
	})
	got := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("p") })
	if got.Summary != x || got.Body != x || got.Notes != x || *got.RawInput != x || *got.Source.Note != x ||
		got.Problem.StarterCode["python"] != "print('\x00')" {
		t.Errorf("item text: %q %q %q", got.Summary, got.Body, got.Notes)
	}
	c := Read(t, db, func(tx store.Tx) (domain.Collection, error) { return tx.GetCollection("c") })
	tc := Read(t, db, func(tx store.Tx) (domain.TestCase, error) { return tx.GetTestCase("t") })
	sol := Read(t, db, func(tx store.Tx) (domain.ItemSolution, error) { return tx.GetSolution("sol") })
	s := Read(t, db, func(tx store.Tx) (domain.Submission, error) { return tx.GetSubmission("s") })
	if c.Description != x || tc.Name != x || tc.Stdin != x || tc.ExpectedStdout != x || sol.Source != x || sol.Notes != x ||
		s.Source != x || *s.Stdin != x || s.CompileOutput != x || *s.Error != x {
		t.Error("text was changed on the way through the store")
	}
	if r := s.Results[0]; r.Name != x || r.Stdin != x || *r.ExpectedStdout != x || r.Stdout != x || r.Stderr != x {
		t.Errorf("result text: %+v", r)
	}
	if got := ids(t, db, store.ItemFilter{Query: "end"}); got != "p" {
		t.Errorf("search over arbitrary text: %q", got)
	}
}

func testStylePresetConstraints(t *testing.T, db store.Store) {
	ClearStylePresets(t, db)
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
	if err := insert("p1", "Other name", false); err == nil {
		t.Error("the database should reject a duplicate id")
	}
	if err := insert("p3", "Other", true); err == nil {
		t.Error("the database should reject a second default")
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		return tx.InsertStylePreset(&domain.StylePreset{ID: "p4", Name: strings.Repeat("n", 61), Instructions: "x", CreatedAt: now, UpdatedAt: now})
	}); err == nil {
		t.Error("the database should reject a 61-character name")
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		return tx.InsertStylePreset(&domain.StylePreset{ID: "p4", Name: strings.Repeat("ü", 60), Instructions: strings.Repeat("ü", 2000),
			CreatedAt: now, UpdatedAt: now})
	}); err != nil {
		t.Errorf("60 and 2000 characters (not bytes) are allowed: %v", err)
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		return tx.InsertStylePreset(&domain.StylePreset{ID: "p6", Name: "long", Instructions: strings.Repeat("x", 2001), CreatedAt: now, UpdatedAt: now})
	}); err == nil {
		t.Error("the database should reject 2001-character instructions")
	}
	for _, name := range []string{"two\nlines", "tab\tname", "carriage\rreturn"} {
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
	// Moving the default.
	Write(t, db, func(tx store.Tx) error {
		if err := tx.ClearDefaultStylePreset(); err != nil {
			return err
		}
		p, err := tx.GetStylePreset("p4")
		if err != nil {
			return err
		}
		p.IsDefault, p.UpdatedAt = true, now.Add(time.Minute)
		return tx.UpdateStylePreset(&p)
	})
	for i := 3; i <= 20; i++ {
		if err := insert(fmt.Sprint("q", i), fmt.Sprint("name ", i), false); err != nil {
			t.Fatalf("preset %d: %v", i, err)
		}
	}
	if err := insert("q21", "one too many", false); err == nil {
		t.Error("the database should reject a 21st preset")
	}
	list := Read(t, db, func(tx store.Tx) ([]domain.StylePreset, error) { return tx.ListStylePresets() })
	if len(list) != 20 || list[0].ID != "p4" || list[1].Name != "LeetCode" || list[2].Name != "name 10" ||
		!list[0].UpdatedAt.Equal(now.Add(time.Minute)) {
		t.Errorf("list: %d presets, first %+v", len(list), list[0])
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error { return tx.DeleteStylePreset("nope") }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("deleting a missing preset: %v", err)
	}
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		return tx.UpdateStylePreset(&domain.StylePreset{ID: "nope", Name: "n", Instructions: "x"})
	}); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("updating a missing preset: %v", err)
	}
}

// A new database starts with the built-in style presets, which are valid
// presets with a single default.
func testBuiltinStylePresets(t *testing.T, db store.Store) {
	list := Read(t, db, func(tx store.Tx) ([]domain.StylePreset, error) { return tx.ListStylePresets() })
	if len(list) != len(store.BuiltinStylePresets) {
		t.Fatalf("%d built-in presets", len(list))
	}
	// Listed default first, then by name.
	byName := map[string]store.BuiltinStylePreset{}
	for _, b := range store.BuiltinStylePresets {
		byName[b.Name] = b
	}
	var names []string
	for _, p := range list {
		names = append(names, p.Name)
		if _, err := uuid.Parse(p.ID); err != nil || p.CreatedAt.IsZero() || !p.CreatedAt.Equal(p.UpdatedAt) ||
			p.CreatedAt.Before(time.Now().Add(-time.Hour)) {
			t.Errorf("%s: id %q, created %v, updated %v", p.Name, p.ID, p.CreatedAt, p.UpdatedAt)
		}
		if u, _ := uuid.Parse(p.ID); u.Version() != 4 {
			t.Errorf("%s: id %s is not a version-4 UUID", p.Name, p.ID)
		}
		v := p
		if fe := domain.ValidateStylePreset(&v); len(fe) != 0 || v != p {
			t.Errorf("%s does not validate unchanged: %v", p.Name, fe)
		}
		if b := byName[p.Name]; b.Instructions != p.Instructions || b.IsDefault != p.IsDefault {
			t.Errorf("%s differs from store.BuiltinStylePresets", p.Name)
		}
	}
	if strings.Join(names, ",") != "Interview practice,Contest style,Study notes" {
		t.Errorf("built-in presets: %v", names)
	}
}

// The database itself enforces one reference per item, the per-item cap
// and single-line names, and solutions go with their item.
func testSolutionConstraints(t *testing.T, db store.Store) {
	it := Item("i1", "P", domain.TypeProblem)
	Write(t, db, func(tx store.Tx) error { return tx.InsertItem(&it) })
	sol := func(id string, ref bool, name string) *domain.ItemSolution {
		return &domain.ItemSolution{ID: id, ItemID: "i1", Name: name, Language: "python", Source: "x", IsReference: ref,
			CreatedAt: now, UpdatedAt: now}
	}
	reject := func(what string, s *domain.ItemSolution) {
		t.Helper()
		if err := db.Write(context.Background(), func(tx store.Tx) error { return tx.InsertSolution(s) }); err == nil {
			t.Errorf("%s was accepted", what)
		}
	}
	Write(t, db, func(tx store.Tx) error { return tx.InsertSolution(sol("s1", true, "one")) })
	reject("a second reference solution", sol("s2", true, "two"))
	reject("a multi-line name", sol("s3", false, "a\nb"))
	reject("an empty name", sol("s3", false, ""))
	reject("a 101-character name", sol("s3", false, strings.Repeat("n", 101)))
	empty := sol("s3", false, "n")
	empty.Source = ""
	reject("an empty source", empty)
	long := sol("s3", false, "n")
	long.Notes = strings.Repeat("x", 5001)
	reject("5001-character notes", long)
	ok := sol("s3", false, "n")
	ok.Notes = strings.Repeat("é", 5000) // characters, not bytes
	Write(t, db, func(tx store.Tx) error { return tx.InsertSolution(ok) })
	Write(t, db, func(tx store.Tx) error {
		for i := 2; i < domain.MaxSolutionsPerItem; i++ {
			if err := tx.InsertSolution(sol(string(rune('A'+i/26))+string(rune('a'+i%26)), false, "n")); err != nil {
				return err
			}
		}
		return nil
	})
	reject("a 51st solution", sol("extra", false, "n"))
	sols := Read(t, db, func(tx store.Tx) ([]domain.ItemSolution, error) { return tx.ListSolutions("i1") })
	if len(sols) != domain.MaxSolutionsPerItem || sols[0].ID != "s1" || sols[1].ID != "s3" {
		t.Errorf("%d solutions, first %s", len(sols), sols[0].ID)
	}
	// Moving the reference.
	Write(t, db, func(tx store.Tx) error {
		if err := tx.ClearReference("i1"); err != nil {
			return err
		}
		s, err := tx.GetSolution("s3")
		if err != nil {
			return err
		}
		s.IsReference, s.Name, s.UpdatedAt = true, "renamed", now.Add(time.Minute)
		return tx.UpdateSolution(&s)
	})
	it2 := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("i1") })
	sols = Read(t, db, func(tx store.Tx) ([]domain.ItemSolution, error) { return tx.ListSolutions("i1") })
	if sols[0].ID != "s3" || sols[0].Name != "renamed" || sols[1].ID != "s1" || sols[1].IsReference ||
		it2.Problem.ReferenceSolution == nil || it2.SolutionCount != domain.MaxSolutionsPerItem {
		t.Errorf("after moving the reference: %+v", sols[:2])
	}
	for _, fn := range []func(store.Tx) error{
		func(tx store.Tx) error { _, err := tx.GetSolution("nope"); return err },
		func(tx store.Tx) error { return tx.DeleteSolution("nope") },
		func(tx store.Tx) error {
			return tx.UpdateSolution(&domain.ItemSolution{ID: "nope", Name: "n", Source: "x"})
		},
	} {
		if err := db.Write(context.Background(), fn); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("missing solution: %v", err)
		}
	}
	Write(t, db, func(tx store.Tx) error { return tx.DeleteSolution("s1") })
	Write(t, db, func(tx store.Tx) error { _, err := tx.DeleteItem("i1"); return err })
	if sols := Read(t, db, func(tx store.Tx) ([]domain.ItemSolution, error) { return tx.ListSolutions("i1") }); len(sols) != 0 {
		t.Errorf("solutions outlived their item: %d", len(sols))
	}
	it3 := Item("i3", "Q", domain.TypeProblem)
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&it3); err != nil {
			return err
		}
		s := sol("q1", false, "n")
		s.ItemID = "i3"
		if err := tx.InsertSolution(s); err != nil {
			return err
		}
		return tx.DeleteSolutions("i3")
	})
	if sols := Read(t, db, func(tx store.Tx) ([]domain.ItemSolution, error) { return tx.ListSolutions("i3") }); len(sols) != 0 {
		t.Errorf("DeleteSolutions left %d", len(sols))
	}
}

// The database enforces the AI provider rules: unique case-insensitive
// single-line names, known kinds (every kind of ai.ProviderIDs), at most 20. (The kind is never written
// by an update; each backend tests its own database rule against changing
// it.)
func testAIProviderConstraints(t *testing.T, db store.Store) {
	prov := func(id, name, kind string) *store.AIProvider {
		return &store.AIProvider{ID: id, Name: name, Kind: kind, CreatedAt: now, UpdatedAt: now}
	}
	insert := func(p *store.AIProvider) error {
		return db.Write(context.Background(), func(tx store.Tx) error { return tx.InsertAIProvider(p) })
	}
	full := prov("p1", "Work", "anthropic")
	full.Model, full.BaseURL, full.APIKey, full.APIKeyOrigin = "m", "https://api.example", "ciphertext", "https://api.example"
	if err := insert(full); err != nil {
		t.Fatal(err)
	}
	for what, p := range map[string]*store.AIProvider{
		"a case-insensitive duplicate name": prov("p2", " WORK ", "anthropic"),
		"a duplicate id":                    prov("p1", "Other", "anthropic"),
		"an unknown kind":                   prov("p3", "Other", "mistral"),
		"a multi-line name":                 prov("p4", "a\nb", "anthropic"),
		"a tab in the name":                 prov("p4", "a\tb", "anthropic"),
		"an empty name":                     prov("p4", "", "anthropic"),
		"a 61-character name":               prov("p4", strings.Repeat("n", 61), "anthropic"),
	} {
		if err := insert(p); err == nil {
			t.Errorf("%s was accepted", what)
		}
	}
	got := Read(t, db, func(tx store.Tx) (store.AIProvider, error) { return tx.GetAIProvider("p1") })
	if got != *full {
		t.Errorf("round trip: %+v", got)
	}
	Write(t, db, func(tx store.Tx) error {
		p, _ := tx.GetAIProvider("p1")
		p.Name, p.Model, p.BaseURL, p.APIKey, p.APIKeyOrigin, p.UpdatedAt = "Renamed", "", "", "", "", now.Add(time.Hour)
		p.Kind = "openai_compatible" // ignored: the kind never changes
		return tx.UpdateAIProvider(&p)
	})
	got = Read(t, db, func(tx store.Tx) (store.AIProvider, error) { return tx.GetAIProvider("p1") })
	if got.Name != "Renamed" || got.Kind != "anthropic" || got.APIKey != "" || !got.UpdatedAt.Equal(now.Add(time.Hour)) ||
		!got.CreatedAt.Equal(now) {
		t.Errorf("after update: %+v", got)
	}
	for i := 2; i <= domain.MaxAIProviders; i++ {
		kind := ai.ProviderIDs[i%len(ai.ProviderIDs)]
		if err := insert(prov(fmt.Sprint("q", i), fmt.Sprint("provider ", i), kind)); err != nil {
			t.Fatalf("provider %d (%s): %v", i, kind, err)
		}
	}
	kinds := map[string]bool{}
	for _, p := range Read(t, db, func(tx store.Tx) ([]store.AIProvider, error) { return tx.ListAIProviders() }) {
		kinds[p.Kind] = true
	}
	if len(kinds) != len(ai.ProviderIDs) || !kinds["gemini"] {
		t.Errorf("kinds stored: %v", kinds)
	}
	if err := insert(prov("q21", "one too many", "anthropic")); err == nil {
		t.Error("a 21st provider was accepted")
	}
	list := Read(t, db, func(tx store.Tx) ([]store.AIProvider, error) { return tx.ListAIProviders() })
	if len(list) != domain.MaxAIProviders || list[0].Name != "provider 10" || list[len(list)-1].Name != "Renamed" {
		t.Errorf("list: %d, first %q, last %q", len(list), list[0].Name, list[len(list)-1].Name)
	}
	for _, fn := range []func(store.Tx) error{
		func(tx store.Tx) error { _, err := tx.GetAIProvider("nope"); return err },
		func(tx store.Tx) error { return tx.DeleteAIProvider("nope") },
		func(tx store.Tx) error { return tx.UpdateAIProvider(prov("nope", "n", "anthropic")) },
	} {
		if err := db.Write(context.Background(), fn); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("missing provider: %v", err)
		}
	}
}

func testRollbackOnError(t *testing.T, db store.Store) {
	it := Item("a", "A", domain.TypeReading)
	err := db.Write(context.Background(), func(tx store.Tx) error {
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		return errors.New("abort")
	})
	if err == nil || err.Error() != "abort" {
		t.Fatalf("expected the error back: %v", err)
	}
	err = db.Read(context.Background(), func(tx store.Tx) error { _, err := tx.GetItem("a"); return err })
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("write was not rolled back: %v", err)
	}
	if got := ids(t, db, store.ItemFilter{Query: "a"}); got != "" {
		t.Errorf("the search index kept a rolled-back item: %q", got)
	}
}

func testReadIsReadOnly(t *testing.T, db store.Store) {
	err := db.Read(context.Background(), func(tx store.Tx) error { return tx.SetSetting("k", "v") })
	if err == nil {
		t.Error("a read transaction wrote")
	}
}

// Writers run one at a time, and each sees the commits before it: a
// read-modify-write in every writer loses no update.
func testWritesAreSerialised(t *testing.T, db store.Store) {
	const n = 20
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for range n {
		wg.Go(func() {
			errs <- db.Write(context.Background(), func(tx store.Tx) error {
				v, _, err := tx.GetSetting("counter")
				if err != nil {
					return err
				}
				var c int
				fmt.Sscan(v, &c)
				time.Sleep(time.Millisecond)
				return tx.SetSetting("counter", fmt.Sprint(c+1))
			})
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	v := Read(t, db, func(tx store.Tx) (string, error) { v, _, err := tx.GetSetting("counter"); return v, err })
	if v != fmt.Sprint(n) {
		t.Errorf("counter = %s after %d increments", v, n)
	}
}

func testCancelledContext(t *testing.T, db store.Store) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := db.Write(ctx, func(tx store.Tx) error { return tx.SetSetting("k", "v") }); err == nil {
		t.Error("a write ran with a cancelled context")
	}
	if err := db.Read(ctx, func(tx store.Tx) error { _, _, err := tx.GetSetting("k"); return err }); err == nil {
		t.Error("a read ran with a cancelled context")
	}
}

// AI usage is rolled up per provider and UTC day; the recent window is a
// range of days, and deleting one provider's counts leaves the others.
func testAIUsage(t *testing.T, db store.Store) {
	day := time.Date(2026, 3, 31, 23, 59, 59, 0, time.UTC)
	recs := []store.AIUsageRecord{
		{ProviderID: "p1", At: day, InputTokens: 100, OutputTokens: 50},
		{ProviderID: "p1", At: day.Add(-time.Hour), Failed: true},
		{ProviderID: "p1", At: day.AddDate(0, 0, -29), InputTokens: 10, OutputTokens: 5},
		{ProviderID: "p1", At: day.AddDate(0, 0, -30), InputTokens: 1000, OutputTokens: 500},
		{ProviderID: "env-anthropic", At: day.AddDate(0, 0, -100), InputTokens: 7},
	}
	for _, r := range recs {
		Write(t, db, func(tx store.Tx) error { return tx.RecordAIUsage(r) })
	}
	since := store.UsageDay(day) - 29
	got := Read(t, db, func(tx store.Tx) (map[string]store.AIUsage, error) { return tx.AIUsage(since) })
	p1 := got["p1"]
	if p1.Recent != (store.AIUsageTotals{Requests: 3, Failed: 1, InputTokens: 110, OutputTokens: 55}) ||
		p1.AllTime != (store.AIUsageTotals{Requests: 4, Failed: 1, InputTokens: 1110, OutputTokens: 555}) ||
		!p1.LastUsedAt.Equal(day) {
		t.Errorf("p1: %+v", p1)
	}
	env := got["env-anthropic"]
	if env.Recent != (store.AIUsageTotals{}) || env.AllTime.Requests != 1 || len(got) != 2 {
		t.Errorf("usage: %+v", got)
	}
	rows := Read(t, db, func(tx store.Tx) (int, error) {
		u, err := tx.AIUsage(store.UsageDay(day))
		return int(u["p1"].Recent.Requests), err
	})
	if rows != 2 {
		t.Errorf("one day's requests: %d", rows)
	}
	// Concurrent writers add up.
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := db.Write(context.Background(), func(tx store.Tx) error {
				return tx.RecordAIUsage(store.AIUsageRecord{ProviderID: "p2", At: day, InputTokens: 1})
			}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	Write(t, db, func(tx store.Tx) error { return tx.DeleteAIUsage("p1") })
	got = Read(t, db, func(tx store.Tx) (map[string]store.AIUsage, error) { return tx.AIUsage(since) })
	if _, ok := got["p1"]; ok || got["p2"].AllTime.Requests != 10 || got["p2"].AllTime.InputTokens != 10 || len(got) != 2 {
		t.Errorf("after deleting p1: %+v", got)
	}
	if store.UsageDay(time.Date(1970, 1, 2, 0, 0, 0, 0, time.UTC)) != 1 || store.UsageDay(day) != store.UsageDay(day.Add(-23*time.Hour)) {
		t.Error("UsageDay")
	}
}

// The AI log is append-only and keyset-paged newest first; filters, prune
// and clear work on the index; bodies are compressed and system texts
// shared, and dropped with the last entry that uses them.
func testAILog(t *testing.T, db store.Store) {
	const odd = "a\x00b\x01\r\n\t\ufeff \U0001F642 end"
	insert := func(i int, at time.Time) {
		in, title := i*10, fmt.Sprint("Item ", i)
		e := store.AILogEntry{ID: fmt.Sprintf("log%03d", i), CreatedAt: at, Operation: []string{"draft", "testcases"}[i%2],
			Title: &title, ProviderID: []string{"p1", "p2", "p3"}[i%3], ProviderName: "Work", Kind: "anthropic", Model: "m",
			Status: "ok", DurationMs: 100 + i, InputTokens: &in}
		b := store.AILogBody{System: "SYSTEM " + odd, Request: fmt.Sprintf(`{"n":%d}`, i), Truncated: i == 4}
		if i%5 == 3 {
			msg := odd
			e.Status, e.Error = "failed", &msg
		} else {
			resp := strings.Repeat(odd, i+1)
			b.Response = &resp
		}
		if i == 7 {
			b.System = "ANOTHER SYSTEM"
		}
		Write(t, db, func(tx store.Tx) error { return tx.InsertAILogEntry(e, b) })
	}
	// Several entries share a second; the id orders them.
	for i := range 30 {
		insert(i, now.Add(time.Duration(i/3)*time.Second))
	}
	list := func(f store.AILogFilter) ([]store.AILogEntry, int) {
		type res struct {
			l []store.AILogEntry
			n int
		}
		r := Read(t, db, func(tx store.Tx) (res, error) {
			l, n, err := tx.ListAILog(f)
			return res{l, n}, err
		})
		return r.l, r.n
	}
	// Page through everything while new entries arrive: nothing repeats or
	// goes missing, and nothing was trimmed.
	var seen []string
	f := store.AILogFilter{Limit: 7}
	for page := 0; ; page++ {
		items, total := list(f)
		if page == 0 && total != 30 {
			t.Fatalf("total %d", total)
		}
		for _, e := range items {
			seen = append(seen, e.ID)
		}
		if page == 1 {
			insert(30, now.Add(time.Hour)) // newer than every page
		}
		if len(items) < f.Limit {
			break
		}
		last := items[len(items)-1]
		f.Before = &store.AILogCursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	if len(seen) != 30 || seen[0] != "log029" || seen[29] != "log000" {
		t.Errorf("paged %d entries: %v", len(seen), seen)
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] >= seen[i-1] {
			t.Fatalf("order at %d: %v", i, seen)
		}
	}
	items, total := list(store.AILogFilter{Limit: 2})
	if total != 31 || items[0].ID != "log030" || items[0].DurationMs != 130 || *items[0].InputTokens != 300 ||
		*items[0].Title != "Item 30" || items[0].OutputTokens != nil {
		t.Errorf("newest: %d %+v", total, items[0])
	}
	if _, n := list(store.AILogFilter{ProviderID: "p2", Operation: "draft"}); n != 5 {
		t.Errorf("provider and operation filter: %d", n)
	}
	if l, n := list(store.AILogFilter{Status: "failed"}); n != 6 || l[0].ID != "log028" || *l[0].Error != odd {
		t.Errorf("status filter: %d %+v", n, l)
	}

	get := func(id string) (store.AILogEntry, store.AILogBody, error) {
		var e store.AILogEntry
		var b store.AILogBody
		err := db.Read(context.Background(), func(tx store.Tx) error {
			var err error
			e, b, err = tx.GetAILogEntry(id)
			return err
		})
		return e, b, err
	}
	if e, b, err := get("log004"); err != nil || b.System != "SYSTEM "+odd || b.Request != `{"n":4}` || !b.Truncated ||
		*b.Response != strings.Repeat(odd, 5) || e.Operation != "draft" {
		t.Errorf("detail: %+v %+v %v", e, b, err)
	}
	if _, b, _ := get("log003"); b.Response != nil || b.Truncated {
		t.Errorf("failed entry: %+v", b)
	}
	// How many system texts are stored, read through the bulk interface
	// every backend has.
	texts := func() int {
		bulk, ok := db.(store.Bulk)
		if !ok {
			t.Fatal("the store has no bulk interface")
		}
		tb, _ := store.TableByName("ai_log_texts")
		var n int64
		if err := bulk.Export(context.Background(), func(d store.Dump) error {
			var err error
			n, err = d.Count(tb)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return int(n)
	}
	if n := texts(); n != 2 {
		t.Errorf("%d stored system texts, want 2", n)
	}

	// Pruning removes what is older, and the system text only entry 7 used.
	Write(t, db, func(tx store.Tx) error { at := now.Add(3 * time.Second); return tx.DeleteAILog(&at) })
	if _, n := list(store.AILogFilter{}); n != 22 {
		t.Errorf("after pruning: %d", n)
	}
	if _, _, err := get("log008"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("pruned entry: %v", err)
	}
	if n := texts(); n != 1 {
		t.Errorf("%d system texts after pruning, want 1", n)
	}
	Write(t, db, func(tx store.Tx) error { return tx.DeleteAILog(nil) })
	if _, n := list(store.AILogFilter{}); n != 0 {
		t.Errorf("cleared: %d", n)
	}
	if n := texts(); n != 0 {
		t.Errorf("%d system texts after clearing", n)
	}
}
