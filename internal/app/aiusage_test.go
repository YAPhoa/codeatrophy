package app_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// clock is a settable time source for app.Options.Now.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) set(t time.Time) { c.mu.Lock(); c.t = t; c.mu.Unlock() }

const secretKey = "sk-ant-RECOGNISABLE-SECRET-4242"

func (e *env) usageOf(t *testing.T, id string) app.ProviderUsage {
	t.Helper()
	p := providerByID(must(e.app.GetAISettings(e.ctx)), id)
	if p == nil {
		t.Fatalf("no provider %s", id)
	}
	return p.Usage
}

func (e *env) logPage(t *testing.T, q app.AILogQuery) app.AILogPage {
	t.Helper()
	return must(e.app.ListAILog(e.ctx, q))
}

func TestGenerationsAreCountedAndLogged(t *testing.T) {
	c := &clock{t: time.Date(2026, 5, 31, 23, 0, 0, 0, time.UTC)}
	e := newEnv(t, func(o *app.Options) { o.Now = c.now })
	p := e.addProvider(t, `{"name":"Work","kind":"anthropic","apiKey":"`+secretKey+`"}`)
	e.setDefault(t, p.ID)
	in, out, reasoning, cache := 1000, 200, 50, 300
	e.ai.InputTokens, e.ai.OutputTokens, e.ai.ReasoningTokens, e.ai.CacheReadTokens = &in, &out, &reasoning, &cache

	// A draft: usage in the response, an entry in the log, a count.
	res := must(draftWith(t, e, `{"text":"two sum"}`, draftJSON()))
	u := res.Usage
	if u.LogID == nil || u.Model != "fake-model" || *u.InputTokens != 1000 || *u.OutputTokens != 200 ||
		*u.ReasoningTokens != 50 || *u.CacheReadTokens != 300 || u.CacheWriteTokens != nil {
		t.Fatalf("usage: %+v", u)
	}
	d := must(e.app.GetAILogEntry(e.ctx, *u.LogID))
	if d.Operation != "draft" || d.Status != "ok" || d.ItemID != nil || d.Title == nil || *d.Title != "Two Sum" ||
		d.ProviderID != p.ID || d.ProviderName != "Work" || d.Kind != "anthropic" || *d.Usage.InputTokens != 1000 ||
		d.Response == nil || !strings.Contains(*d.Response, `"title":"Two Sum"`) || d.Truncated {
		t.Errorf("draft entry: %+v", d)
	}
	var req struct {
		System   string                           `json:"system"`
		Messages []struct{ Role, Content string } `json:"messages"`
		Schema   string                           `json:"schema"`
	}
	if err := json.Unmarshal(d.Request, &req); err != nil || !strings.Contains(req.System, "authoring conventions") ||
		len(req.Messages) != 1 || !strings.Contains(req.Messages[0].Content, "two sum") || req.Schema != "item_draft" {
		t.Errorf("request: %s %v", d.Request, err)
	}

	// Test generation and a variant of a problem.
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return casesAnswer("7 7", "14"), nil }
	tc := must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1}`)))
	if tc.Usage.LogID == nil || *tc.Usage.OutputTokens != 200 {
		t.Errorf("test generation usage: %+v", tc.Usage)
	}
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	v := must(e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{}`)))
	if v.Usage.LogID == nil {
		t.Errorf("variant usage: %+v", v.Usage)
	}
	for id, want := range map[string][3]string{*tc.Usage.LogID: {"testcases", it.ID, "A plus B"}, *v.Usage.LogID: {"variant", it.ID, "A plus B"}} {
		d := must(e.app.GetAILogEntry(e.ctx, id))
		if d.Operation != want[0] || d.ItemID == nil || *d.ItemID != want[1] || *d.Title != want[2] || d.Status != "ok" {
			t.Errorf("%s entry: %+v", want[0], d.AILogEntry)
		}
	}

	// A provider failure and an unusable answer are failed; a cancelled
	// request is cancelled. All are counted.
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return nil, ai.Errorf(500, "the service broke") }
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	wantCode(t, err, app.CodeUpstream)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return map[string]any{"title": 7}, nil }
	_, err = e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	wantCode(t, err, app.CodeUpstream)
	ctx, cancel := context.WithCancel(e.ctx)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { cancel(); return nil, context.Canceled }
	_, err = e.app.Draft(ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	if err == nil {
		t.Fatal("a cancelled draft succeeded")
	}
	page := e.logPage(t, app.AILogQuery{})
	statuses := []string{}
	for _, it := range page.Items {
		statuses = append(statuses, it.Operation+"/"+it.Status)
	}
	if got := strings.Join(statuses, ","); page.Total != 6 ||
		got != "draft/cancelled,draft/failed,draft/failed,variant/ok,testcases/ok,draft/ok" {
		t.Errorf("log: %d %s", page.Total, got)
	}
	if f := page.Items[1]; f.Error == nil || !strings.Contains(*f.Error, "does not match the schema") {
		t.Errorf("unusable answer: %+v", f)
	}
	if f := page.Items[2]; f.Error == nil || *f.Error != "the service broke" || f.Usage.InputTokens != nil {
		t.Errorf("provider failure: %+v", f)
	}

	// A connection test of the saved provider counts; one of unsaved
	// settings does not.
	e.ai.Respond = nil
	e.ai.Responses = nil
	e.testProvider(t, `{"providerId":"`+p.ID+`"}`)
	e.testProvider(t, `{"kind":"anthropic","apiKey":"sk-ant-other-1234"}`)
	usage := e.usageOf(t, p.ID)
	if usage.AllTime.Requests != 7 || usage.AllTime.Failed != 3 || usage.Last30Days != usage.AllTime ||
		usage.AllTime.InputTokens != 4*1300+1300 || usage.LastUsedAt == nil || !usage.LastUsedAt.Equal(c.now()) {
		t.Errorf("usage: %+v", usage)
	}
	if page := e.logPage(t, app.AILogQuery{Operation: "test"}); page.Total != 1 || page.Items[0].ProviderID != p.ID {
		t.Errorf("connection tests logged: %+v", page)
	}

	// The 30-day window: today and the 29 days before it, in UTC.
	c.set(time.Date(2026, 6, 29, 23, 59, 59, 0, time.UTC))
	if u := e.usageOf(t, p.ID); u.Last30Days.Requests != 7 {
		t.Errorf("29 days later: %+v", u.Last30Days)
	}
	c.set(time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC))
	if u := e.usageOf(t, p.ID); u.Last30Days.Requests != 0 || u.AllTime.Requests != 7 {
		t.Errorf("30 days later: %+v", u)
	}

	// No key in anything the log stores.
	bulk := e.db.(store.Bulk)
	if err := bulk.Export(e.ctx, func(dm store.Dump) error {
		for _, name := range []string{"ai_log", "ai_log_bodies", "ai_log_texts", "ai_usage"} {
			tb, _ := store.TableByName(name)
			if err := dm.Rows(tb, func(row []any) error {
				for _, v := range row {
					if s, ok := v.(string); ok {
						if text, err := store.DecompressText([]byte(s)); err == nil {
							s = text
						}
						if strings.Contains(s, secretKey) {
							return fmt.Errorf("%s holds the key: %q", name, s)
						}
					}
				}
				return nil
			}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Error(err)
	}

	// Deleting the provider removes its counts and keeps its log entries;
	// clearing the log leaves counts alone.
	other := e.addProvider(t, `{"name":"Other","kind":"anthropic","apiKey":"sk-ant-other-5555"}`)
	e.testProvider(t, `{"providerId":"`+other.ID+`"}`)
	if err := e.app.DeleteAIProvider(e.ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	if page := e.logPage(t, app.AILogQuery{ProviderID: p.ID}); page.Total != 7 {
		t.Errorf("entries after deleting the provider: %d", page.Total)
	}
	if err := e.app.DeleteAILog(e.ctx, ""); err != nil {
		t.Fatal(err)
	}
	if page := e.logPage(t, app.AILogQuery{}); page.Total != 0 {
		t.Errorf("cleared: %d", page.Total)
	}
	if u := e.usageOf(t, other.ID); u.AllTime.Requests != 1 {
		t.Errorf("counts after clearing the log: %+v", u)
	}
	// A new provider with the deleted one's counts would mean they stayed.
	err = e.db.Read(e.ctx, func(tx store.Tx) error {
		all, err := tx.AIUsage(0)
		if _, ok := all[p.ID]; ok {
			return errors.New("the deleted provider's counts are still stored")
		}
		return err
	})
	if err != nil {
		t.Error(err)
	}
}

func TestAILogPagingAndPruning(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	e := newEnv(t, func(o *app.Options) { o.Now = c.now })
	e.enableAI(t)
	for i := range 7 {
		c.set(c.now().Add(time.Duration(i%2) * time.Second))
		must(draftWith(t, e, `{"text":"x"}`, draftJSON()))
	}
	limit := 3
	var ids []string
	q := app.AILogQuery{Limit: &limit}
	for range 10 {
		page := e.logPage(t, q)
		for _, it := range page.Items {
			ids = append(ids, it.ID)
		}
		if page.Total != 7 && page.Total != 8 {
			t.Errorf("total %d", page.Total)
		}
		if len(ids) == 3 {
			must(draftWith(t, e, `{"text":"x"}`, draftJSON())) // arrives between pages
		}
		if page.Next == nil {
			break
		}
		q.Before = *page.Next
	}
	if len(ids) != 7 {
		t.Errorf("paged %d entries", len(ids))
	}
	_, err := e.app.ListAILog(e.ctx, app.AILogQuery{Before: "not-a-cursor"})
	wantCode(t, err, app.CodeBadRequest)
	_, err = e.app.ListAILog(e.ctx, app.AILogQuery{Status: "maybe"})
	wantCode(t, err, app.CodeBadRequest)
	wantCode(t, e.app.DeleteAILog(e.ctx, "yesterday"), app.CodeBadRequest)
	// Prune what is older than the newest second.
	if err := e.app.DeleteAILog(e.ctx, c.now().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	if page := e.logPage(t, app.AILogQuery{}); page.Total == 0 || page.Total == 8 {
		t.Errorf("after pruning: %d", page.Total)
	}
	_, err = e.app.GetAILogEntry(e.ctx, ids[len(ids)-1])
	wantCode(t, err, app.CodeNotFound)

	// A response larger than the cut is kept truncated.
	big := draftJSON()
	big["body"] = strings.Repeat("x", 300<<10)
	res := must(draftWith(t, e, `{"text":"x"}`, big))
	d := must(e.app.GetAILogEntry(e.ctx, *res.Usage.LogID))
	if !d.Truncated || len(*d.Response) != 256<<10 {
		t.Errorf("truncation: %v %d", d.Truncated, len(*d.Response))
	}
}

func TestGeneratedCasesAddToTheExistingOnes(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	it := e.problem(t, "")
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "sum"},
			"cases": []map[string]any{
				{"name": "copy of s1", "rationale": "x", "stdin": "1 2\n\n", "predictedStdout": "3", "isSample": false},
				{"name": "new", "rationale": "x", "stdin": "4 4", "predictedStdout": "8", "isSample": false},
				{"name": "copy of new", "rationale": "x", "stdin": "4 4 ", "predictedStdout": "8", "isSample": false},
				{"name": "copy of h1", "rationale": "x", "stdin": "5 5", "predictedStdout": "10", "isSample": false},
				{"name": "other", "rationale": "x", "stdin": "6 6", "predictedStdout": "12", "isSample": false},
			}}, nil
	}
	res := must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":5}`)))
	if res.DuplicatesDropped != 3 || len(res.Cases) != 2 || res.Cases[0].Name != "new" || res.Cases[1].Name != "other" {
		t.Errorf("dedupe: %d %+v", res.DuplicatesDropped, res.Cases)
	}
	u := e.ai.Last().User
	if !strings.Contains(u, "<existing_cases-") || !strings.Contains(u, "--- s1 (sample)\n1 2\n--- h1 (hidden)\n5 5") ||
		!strings.Contains(u, "Add to them") {
		t.Errorf("existing cases in the prompt: %s", u)
	}
	// Only duplicates: an empty proposal, not an error.
	onlyDuplicates := func(ai.GenerateRequest) (any, error) { return casesAnswer("1 2", "3"), nil }
	e.ai.Respond = onlyDuplicates
	res = must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{}`)))
	if len(res.Cases) != 0 || res.DuplicatesDropped != 1 {
		t.Errorf("only duplicates: %+v", res)
	}
	// A draft's own repeated inputs go too.
	dj := draftJSON()
	dj["testCases"] = []map[string]any{{"name": "a", "stdin": "1 2", "expectedStdout": "3", "isSample": true},
		{"name": "b", "stdin": "1 2\n", "expectedStdout": "3", "isSample": true}}
	if d := must(draftWith(t, e, `{"text":"x"}`, dj)).Draft; len(d.TestCases) != 1 {
		t.Errorf("draft dedupe: %+v", d.TestCases)
	}
	// A large existing case is described by name and size only.
	must(e.app.AddTestCase(e.ctx, it.ID, decodeInto[domain.TestCaseInput](t, `{"name":"big","stdin":"`+strings.Repeat("9 ", 2500)+`","expectedStdout":"x"}`)))
	e.ai.Respond = onlyDuplicates
	must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{}`)))
	if u := e.ai.Last().User; !strings.Contains(u, "--- big (hidden)\n(input of 5000 bytes and expected output of 1 bytes, too large to show)") ||
		strings.Contains(u, "9 9 9") {
		t.Errorf("a large input is shown: %s", u)
	}
}
