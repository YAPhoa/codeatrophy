package storetest

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store"
)

// FixtureSecrets encrypts the API key Populate stores.
var FixtureSecrets = func() *secrets.Box { b, _ := secrets.NewBox(bytes.Repeat([]byte{7}, 32)); return b }()

// Populate fills db with a library that uses every table: an AI provider
// with an encrypted key chosen as the default, edited and deleted built-in
// presets plus one of the user's, items with tags (and one that records who
// created and changed it), collections (nested,
// with positions), a variant link, links between items (to a deleted item
// too), test cases, solutions, working copies, and submissions with
// results, and text a backend could mangle.
func Populate(t *testing.T, db store.Store) {
	t.Helper()
	ctx := context.Background()
	a := app.New(app.Options{Store: db, Secrets: FixtureSecrets})
	p, err := a.CreateAIProvider(ctx, app.AIProviderInput{Name: domain.Some("Work"), Kind: domain.Some("anthropic"),
		Model: domain.Some("claude-test"), BaseURL: domain.Some("https://api.anthropic.example"),
		APIKey: domain.Some("sk-ant-test-key-1234"), Effort: domain.Some("high")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.UpdateAISettings(ctx, app.AISettingsInput{DefaultProviderID: domain.Some(p.ID)}); err != nil {
		t.Fatal(err)
	}
	x := ArbitraryText
	Write(t, db, func(tx store.Tx) error {
		presets, err := tx.ListStylePresets()
		if err != nil {
			return err
		}
		for _, sp := range presets {
			switch sp.Name {
			case "Contest style":
				sp.Instructions, sp.UpdatedAt = "My own contest rules.", now
				if err := tx.UpdateStylePreset(&sp); err != nil {
					return err
				}
			case "Study notes":
				if err := tx.DeleteStylePreset(sp.ID); err != nil {
					return err
				}
			}
		}
		if err := tx.InsertStylePreset(&domain.StylePreset{ID: "mine", Name: "Mine", Instructions: "Short.",
			CreatedAt: now, UpdatedAt: now}); err != nil {
			return err
		}
		if err := tx.SetSetting("preferences", `{"theme":"dark"}`); err != nil {
			return err
		}
		for i, sys := range []string{"SYSTEM", "SYSTEM", x} {
			resp, tokens, logItem := x, 5, "origin"
			if err := tx.InsertAILogEntry(store.AILogEntry{ID: fmt.Sprint("log", i), CreatedAt: now, Operation: "testcases",
				ItemID: &logItem, ProviderID: p.ID, ProviderName: "Work", Kind: "anthropic", Model: "claude-test", Status: "ok",
				DurationMs: 9, OutputTokens: &tokens}, store.AILogBody{System: sys, Request: `{"n":1}`, Response: &resp,
				Truncated: i == 1}); err != nil {
				return err
			}
		}
		for i, id := range []string{p.ID, "env-anthropic", p.ID} {
			if err := tx.RecordAIUsage(store.AIUsageRecord{ProviderID: id, At: now.AddDate(0, 0, -i), Failed: i == 1,
				InputTokens: int64(100 * i), OutputTokens: int64(10 * i)}); err != nil {
				return err
			}
		}
		for _, it := range SearchCorpus() {
			if err := tx.InsertItem(&it); err != nil {
				return err
			}
		}
		// A variant inserted before its origin.
		v := Item("variant", "Two Sum, sorted input", domain.TypeProblem, "array")
		v.Revision, v.UpdatedAt = 3, now.Add(time.Hour)
		if err := tx.InsertItem(&v); err != nil {
			return err
		}
		origin := Item("origin", "Two Sum (original)", domain.TypeProblem, "array", "classic")
		hard := domain.DifficultyHard
		origin.Difficulty, origin.Favorite, origin.Status, origin.Notes, origin.RawInput = &hard, true, domain.StatusDone, x, &x
		origin.Problem.StarterCode = map[string]string{"python": "def solve():\n    pass\n", "cpp": "int main() {}"}
		if err := tx.InsertItem(&origin); err != nil {
			return err
		}
		v.VariantOf = &origin.ID
		if err := tx.UpdateItem(&v); err != nil {
			return err
		}
		// A solution-only problem with runner code in two languages.
		fn := Item("function", "Merge k sorted lists", domain.TypeProblem, "linked-list")
		fn.Problem.Interface = domain.InterfaceFunction
		fn.Problem.StarterCode = map[string]string{"python": "class Solution:\n    def mergeKLists(self, lists):\n        "}
		fn.Problem.Harness = map[string]domain.HarnessCode{
			"python": {Prefix: "from __future__ import annotations\n\nimport json\n", Suffix: "\nprint(json.dumps(Solution().mergeKLists([])))\n"},
			"cpp":    {Prefix: "#include <bits/stdc++.h>\n", Suffix: ""},
		}
		if err := tx.InsertItem(&fn); err != nil {
			return err
		}
		// An item that records who created it and who last changed it.
		if err := insertTracked(tx); err != nil {
			return err
		}
		// Links, one of them to an item that is then deleted (which leaves
		// a record of it) and one to an id that never existed here.
		gone := Item("gone", "Deleted reading", domain.TypeReading)
		if err := tx.InsertItem(&gone); err != nil {
			return err
		}
		for i, other := range []string{"s1", "gone", "never", "variant"} {
			if _, err := tx.LinkItems("origin", other, now.Add(time.Duration(i)*time.Minute)); err != nil {
				return err
			}
		}
		if _, err := tx.DeleteItem("gone", now.Add(time.Hour)); err != nil {
			return err
		}
		// A child created before its parent, then moved under it.
		root, child := "root", "child"
		for _, c := range []domain.Collection{
			{ID: child, Name: "Child, created first", Position: 1, CreatedAt: now, UpdatedAt: now},
			{ID: root, Name: "Root", Description: x, Position: 0, CreatedAt: now, UpdatedAt: now},
		} {
			if err := tx.InsertCollection(&c); err != nil {
				return err
			}
		}
		if err := tx.UpdateCollection(&domain.Collection{ID: child, Name: "Child, created first", ParentID: &root,
			Position: 0, UpdatedAt: now.Add(time.Minute)}); err != nil {
			return err
		}
		if err := tx.SetCollectionItemIDs(root, []string{"s3", "origin", "s1"}); err != nil {
			return err
		}
		if err := tx.AddCollectionItems(child, []string{"variant"}); err != nil {
			return err
		}
		for i := range 3 {
			tc := domain.TestCase{ID: fmt.Sprint("tc", i), ItemID: "origin", Position: 2 - i, Name: fmt.Sprint("case ", i),
				Stdin: fmt.Sprint(i, " ", i), ExpectedStdout: fmt.Sprint(2 * i), IsSample: i == 0, Origin: domain.OriginAI,
				Verified: true, CreatedAt: now, UpdatedAt: now}
			if i == 2 {
				tc.Stdin, tc.ExpectedStdout = x, x
				tc.Generator = &domain.GeneratorSpec{Language: "python", Source: x}
			}
			if err := tx.InsertTestCase(&tc); err != nil {
				return err
			}
		}
		ms, kb := 48, 9318
		for i, ref := range []bool{true, false} {
			s := domain.ItemSolution{ID: fmt.Sprint("sol", i), ItemID: "origin",
				Name: fmt.Sprint("Approach ", i), Language: "python", Source: "print(sum(map(int, input().split())))",
				Notes: x, IsReference: ref, CreatedAt: now, UpdatedAt: now}
			if ref {
				s.LastRun = &domain.SolutionRun{Passed: 2, Total: 3, TimeMs: &ms, MemoryKb: &kb, RanAt: now.Add(time.Hour)}
			}
			if err := tx.InsertSolution(&s); err != nil {
				return err
			}
		}
		// Working copies: one with arbitrary text, one emptied.
		for i, w := range []domain.WorkingCopy{{ItemID: "origin", Language: "python", Source: x, UpdatedAt: now},
			{ItemID: "origin", Language: "cpp", Source: "", UpdatedAt: now.Add(time.Minute)}} {
			if err := tx.PutWorkingCopy(&w); err != nil {
				return fmt.Errorf("working copy %d: %w", i, err)
			}
		}
		acc, wa := domain.VerdictAccepted, domain.VerdictWrongAnswer
		for i, v := range []*domain.Verdict{&wa, &acc} {
			ms, kb := 10*i, 1024*i
			fin := now.Add(time.Duration(i+1) * time.Minute)
			s := domain.Submission{ID: fmt.Sprint("sub", i), ItemID: "origin", Mode: domain.ModeSubmit, Language: "python",
				Source: x, CaseIDs: []string{"tc0", "tc1"}, Status: domain.SubmissionCompleted, Verdict: v, PassedCount: i,
				TotalCount: 2, TimeMs: &ms, MemoryKb: &kb, CompileOutput: x, CreatedAt: now, FinishedAt: &fin}
			if err := tx.InsertSubmission(&s); err != nil {
				return err
			}
			for j := range 2 {
				tcID, exp := fmt.Sprint("tc", j), fmt.Sprint(2*j)
				if err := tx.AddSubmissionResult(s.ID, j, domain.SubmissionResult{TestCaseID: &tcID, Name: fmt.Sprint("case ", j),
					IsSample: j == 0, Verdict: *v, Stdin: fmt.Sprint(j), ExpectedStdout: &exp, Stdout: x, Stderr: x,
					TimeMs: &ms}); err != nil {
					return err
				}
			}
		}
		h := fn.Problem.Harness["python"]
		if err := tx.InsertSubmission(&domain.Submission{ID: "fnrun", ItemID: "function", Mode: domain.ModeRun,
			Language: "python", Source: "class Solution:\n    pass\n", LineOffset: 3, Harness: &h,
			Status: domain.SubmissionQueued, CreatedAt: now}); err != nil {
			return err
		}
		// AI jobs: one finished with a result and arbitrary text, one
		// waiting.
		back, origin2, result, fin := "/capture?collection="+x, "origin", `{"text":"`+x+`"}`, now.Add(time.Minute)
		for _, j := range []store.AIJob{
			{ID: "job0", CreatedAt: now, Kind: "draft", Title: x, Status: store.JobSucceeded, Origin: &back,
				Request: `{"text":"` + x + `"}`, Result: &result, StartedAt: &now, FinishedAt: &fin},
			{ID: "job1", CreatedAt: now, Kind: "testcases", ItemID: &origin2, Title: "Two Sum", Status: store.JobQueued, Request: `{}`},
		} {
			if err := tx.InsertAIJob(&j); err != nil {
				return err
			}
		}
		// Drafts: a variant with everything set, and a capture written by
		// hand.
		variantOf, content, errBody, job := "origin", `{"form":"`+x+`"}`, `{"code":"upstream_error","message":"`+x+`"}`, "job1"
		for _, d := range []store.Draft{
			{ID: "draft0", CreatedAt: now, UpdatedAt: fin, Kind: "variant", VariantOf: &variantOf, Title: x, ClientTitle: &back,
				Revision: 3, Request: &result, JobID: &job, Error: &errBody, Generation: &result, GenerationSeq: 2,
				Content: &content, BasedOn: 1},
			{ID: "draft1", CreatedAt: now, UpdatedAt: now, Kind: "capture", Title: "Untitled draft", Revision: 1, Edited: true,
				Content: &content},
		} {
			if err := tx.InsertDraft(&d); err != nil {
				return err
			}
		}
		in := "custom"
		return tx.InsertSubmission(&domain.Submission{ID: "run", ItemID: "origin", Mode: domain.ModeRun, Language: "cpp",
			Source: "int main(){}", Stdin: &in, Status: domain.SubmissionQueued, CreatedAt: now})
	})
}

// TrackedID is the item of Populate that records who created it (over MCP,
// with a client and a model) and who last changed it (over HTTP).
const TrackedID = "tracked"

func insertTracked(tx store.Tx) error {
	client, model := "claude-code é 🙂", "claude-opus-5-5"
	it := Item(TrackedID, "Tracked reading", domain.TypeReading)
	it.CreatedBy = &domain.ChangeSource{Via: domain.ViaMCP, Client: &client, Model: &model}
	it.LastUpdatedBy = it.CreatedBy
	if err := tx.InsertItem(&it); err != nil {
		return err
	}
	it.CreatedBy = &domain.ChangeSource{Via: domain.ViaImport} // not written by an update
	it.LastUpdatedBy, it.UpdatedAt = &domain.ChangeSource{Via: domain.ViaHTTP, Model: &model}, now.Add(time.Hour)
	return tx.UpdateItem(&it)
}

// Dump is the complete contents of a database, table by table, as text.
func Dump(t *testing.T, b store.Bulk) map[string][]string {
	t.Helper()
	out := map[string][]string{}
	if err := b.Export(context.Background(), func(d store.Dump) error {
		for _, tb := range store.Tables {
			out[tb.Name] = []string{}
			if err := d.Rows(tb, func(row []any) error {
				out[tb.Name] = append(out[tb.Name], fmt.Sprintf("%#v", row))
				return nil
			}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

// SameDump reports every table whose rows differ.
func SameDump(t *testing.T, what string, want, got map[string][]string) {
	t.Helper()
	for _, tb := range store.Tables {
		w, g := want[tb.Name], got[tb.Name]
		if strings.Join(w, "\n") != strings.Join(g, "\n") {
			t.Errorf("%s: %s differs:\nwant %d rows\n  %s\ngot %d rows\n  %s", what, tb.Name, len(w),
				strings.Join(w, "\n  "), len(g), strings.Join(g, "\n  "))
		}
	}
}

// ClearNewerData removes what Populate stores that older schema versions
// cannot hold, for tests that take its database back to one: the last runs
// of solutions (version 11), AI jobs and drafts (version 12), test case
// generators (version 13), links and the record of a deleted item
// (version 14; the item is created again, which removes its record),
// working copies (version 16) and who created and changed an item (version
// 17).
func ClearNewerData(t *testing.T, db store.Store) {
	t.Helper()
	ClearWorkingCopies(t, db)
	ClearProvenance(t, db)
	Write(t, db, func(tx store.Tx) error {
		links, err := tx.ItemLinks("origin")
		if err != nil {
			return err
		}
		for _, l := range links {
			if _, err := tx.UnlinkItems("origin", l.ID); err != nil {
				return err
			}
		}
		gone := Item("gone", "Deleted reading", domain.TypeReading)
		if err := tx.InsertItem(&gone); err != nil {
			return err
		}
		for _, id := range []string{"job0", "job1"} {
			if _, err := tx.DeleteAIJob(id); err != nil {
				return err
			}
		}
		for _, id := range []string{"draft0", "draft1"} {
			if _, err := tx.DeleteDraft(id); err != nil {
				return err
			}
		}
		sols, err := tx.ListSolutions("origin")
		if err != nil {
			return err
		}
		for _, s := range sols {
			s.LastRun = nil
			if err := tx.UpdateSolution(&s); err != nil {
				return err
			}
		}
		cases, err := tx.ListTestCases("origin")
		if err != nil {
			return err
		}
		for _, c := range cases {
			if c.Generator != nil {
				c.Generator = nil
				if err := tx.UpdateTestCase(&c); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// ClearWorkingCopies removes the working copies Populate stores, which
// schema versions before 16 cannot hold.
func ClearWorkingCopies(t *testing.T, db store.Store) {
	t.Helper()
	Write(t, db, func(tx store.Tx) error {
		ws, err := tx.ListWorkingCopies("origin")
		if err != nil {
			return err
		}
		for _, w := range ws {
			if _, err := tx.DeleteWorkingCopy(w.ItemID, w.Language); err != nil {
				return err
			}
		}
		return nil
	})
}

// ClearProvenance replaces the item of Populate that records who created
// and changed it with one that does not, which schema versions before 17
// cannot hold. The store never rewrites who created an item, so the item
// is deleted and created again (which also removes the record of its
// deletion).
func ClearProvenance(t *testing.T, db store.Store) {
	t.Helper()
	Write(t, db, func(tx store.Tx) error {
		if _, err := tx.DeleteItem(TrackedID, now); err != nil {
			return err
		}
		it := Item(TrackedID, "Tracked reading", domain.TypeReading)
		return tx.InsertItem(&it)
	})
}
