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
// presets plus one of the user's, items with tags, collections (nested,
// with positions), a variant link, test cases, solutions, and submissions
// with results, and text a backend could mangle.
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
		in := "custom"
		return tx.InsertSubmission(&domain.Submission{ID: "run", ItemID: "origin", Mode: domain.ModeRun, Language: "cpp",
			Source: "int main(){}", Stdin: &in, Status: domain.SubmissionQueued, CreatedAt: now})
	})
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

// ClearLastRuns removes the last runs of the solutions Populate stores, for
// tests that take its database back to a schema version from before
// solutions had them (11), which loses them.
func ClearLastRuns(t *testing.T, db store.Store) {
	t.Helper()
	Write(t, db, func(tx store.Tx) error {
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
		return nil
	})
}
