package app_test

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"

	"codeathropy/internal/ai"
	"codeathropy/internal/app"
	"codeathropy/internal/domain"
	"codeathropy/internal/judge"
)

func (e *env) enableAI(t *testing.T) {
	t.Helper()
	must(e.app.UpdateAISettings(e.ctx, decodeInto[app.AISettingsInput](t,
		`{"activeProvider":"anthropic","providers":{"anthropic":{"apiKey":"sk-ant-test-1234"}}}`)))
}

func draftJSON() map[string]any {
	return map[string]any{
		"type": "problem", "title": "Two Sum", "summary": "Find two indices.", "body": "## Problem\n\nGiven...",
		"difficulty": "easy", "tags": []string{"Array", "hash-map", "array"},
		"problem": map[string]any{"timeLimitMs": 50, "memoryLimitKb": 999999999, "compare": "weird",
			"starterCode": []map[string]string{{"language": "python", "source": "import sys\n"}, {"language": "cobol", "source": "x"}}},
		"testCases":   []map[string]any{{"name": "Example 1", "stdin": "1 2", "expectedStdout": "3", "isSample": true}},
		"assumptions": []string{"Assumed exactly one answer.", "  "},
	}
}

func TestDraftNormalizesModelOutput(t *testing.T) {
	e := newEnv(t)
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"two sum"}`))
	wantCode(t, err, app.CodeAIUnavailable)
	e.enableAI(t)
	e.ai.Responses = []any{draftJSON()}
	res := must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"two sum, array + target"}`)))
	d := res.Draft
	if d.Title != "Two Sum" || strings.Join(d.Tags, ",") != "array,hash-map" || *d.Difficulty != domain.DifficultyEasy ||
		d.Problem.TimeLimitMs != domain.MinTimeLimitMs || d.Problem.MemoryLimitKb != domain.MaxMemoryLimitKb ||
		d.Problem.Compare != domain.CompareTokens || len(d.Problem.StarterCode) != 1 || d.Problem.StarterCode["python"] == "" ||
		len(d.TestCases) != 1 || len(d.Assumptions) != 1 {
		t.Errorf("draft: %+v %+v", d, d.Problem)
	}
	if res.Style != nil {
		t.Error("no preset exists, style should be null")
	}
	req := e.ai.Last()
	if req.Schema == nil || req.SchemaName != "item_draft" {
		t.Errorf("request schema: %+v", req.SchemaName)
	}
	// The snippet is data in the user turn, never in the system prompt.
	if strings.Contains(req.System, "two sum, array + target") || !regexp.MustCompile(`<user_input-([0-9a-f]{24})>\ntwo sum, array \+ target\n</user_input-([0-9a-f]{24})>`).MatchString(req.User) {
		t.Errorf("untrusted text placement:\nsystem: %.200s\nuser: %s", req.System, req.User)
	}
	if !strings.Contains(req.System, ai.AuthoringConventions[:40]) {
		t.Error("the system prompt should carry the authoring conventions")
	}
	// A reading draft never has problem fields or tests.
	reading := draftJSON()
	reading["type"] = "reading"
	e.ai.Responses = []any{reading}
	e.ai.Respond = nil
	res = must(newDraft(t, e, `{"text":"notes","typeHint":"reading"}`, reading))
	if res.Draft.Problem != nil || len(res.Draft.TestCases) != 0 {
		t.Errorf("reading draft: %+v", res.Draft)
	}
}

func newDraft(t *testing.T, e *env, js string, out any) (app.DraftResponse, error) {
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return out, nil }
	return e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, js))
}

func TestDraftValidationAndUpstreamErrors(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	bad := []string{
		`{"text":""}`,
		`{"text":"x","typeHint":"video"}`,
		`{"text":"` + strings.Repeat("a", app.MaxDraftTextChars+1) + `"}`,
		`{"text":"x","instruction":"` + strings.Repeat("i", domain.MaxGenerationInstructionChars+1) + `"}`,
		`{"text":"x","previousDraft":"not an object"}`,
	}
	for _, js := range bad {
		_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, js))
		wantCode(t, err, app.CodeValidation)
	}
	// Instruction at the limit is fine.
	_, err := newDraft(t, e, `{"text":"x","instruction":"`+strings.Repeat("i", domain.MaxGenerationInstructionChars)+`"}`, draftJSON())
	if err != nil {
		t.Errorf("instruction at the limit: %v", err)
	}
	_, err = newDraft(t, e, `{"text":"x"}`, map[string]any{"title": ""})
	wantCode(t, err, app.CodeUpstream)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return nil, ai.Errorf(401, "the Anthropic API rejected the API key sk-ant-test-1234")
	}
	_, err = e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	ae := wantCode(t, err, app.CodeUpstream)
	if strings.Contains(ae.Message, "sk-ant-test-1234") {
		t.Errorf("the API key leaked into the error: %s", ae.Message)
	}
	// A revision passes the previous draft and the instruction as data.
	_, err = newDraft(t, e, `{"text":"x","instruction":"make it harder","previousDraft":{"title":"Old"}}`, draftJSON())
	if err != nil {
		t.Fatal(err)
	}
	if u := e.ai.Last().User; !strings.Contains(u, "<previous_draft-") || !strings.Contains(u, `"title":"Old"`) || !strings.Contains(u, "make it harder") {
		t.Errorf("revision prompt: %s", u)
	}
	if s := e.ai.Last().System; strings.Contains(s, "make it harder") || strings.Contains(s, `"Old"`) {
		t.Error("revision data must stay out of the system prompt")
	}
}

func TestStylePresetResolution(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	preset := func(js string) domain.StylePreset {
		return must(e.app.CreateStylePreset(e.ctx, decodeInto[domain.StylePresetInput](t, js)))
	}
	leet := preset(`{"name":"LeetCode style","instructions":"STYLE-LEET: Example blocks with Input / Output / Explanation.","isDefault":true}`)
	terse := preset(`{"name":"Terse","instructions":"STYLE-TERSE: one paragraph."}`)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }

	cases := []struct {
		body      string
		wantStyle *domain.StylePreset
		marker    string
	}{
		{`{"text":"snippet"}`, &leet, "STYLE-LEET"},                                // omitted -> default
		{`{"text":"snippet","styleId":null}`, nil, ""},                             // null -> none
		{`{"text":"snippet","styleId":"` + terse.ID + `"}`, &terse, "STYLE-TERSE"}, // explicit
	}
	for _, c := range cases {
		res := must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, c.body)))
		sys := e.ai.Last().System
		if c.wantStyle == nil {
			if res.Style != nil || strings.Contains(sys, "STYLE-") || strings.Contains(sys, "<style_preset") {
				t.Errorf("%s: expected no style, got %+v", c.body, res.Style)
			}
			continue
		}
		if res.Style == nil || res.Style.ID != c.wantStyle.ID || res.Style.Name != c.wantStyle.Name {
			t.Errorf("%s: style %+v", c.body, res.Style)
		}
		if !strings.Contains(sys, c.marker) || !strings.Contains(sys, "conventions win") {
			t.Errorf("%s: preset missing from the system prompt", c.body)
		}
		if strings.Index(sys, c.marker) < strings.Index(sys, "## Problems") {
			t.Errorf("%s: the preset must come after the built-in conventions", c.body)
		}
		if strings.Contains(e.ai.Last().User, c.marker) {
			t.Errorf("%s: the preset belongs in the system prompt", c.body)
		}
	}
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"snippet","styleId":"no-such-preset"}`))
	ae := wantCode(t, err, app.CodeValidation)
	if ae.Fields["styleId"] == nil {
		t.Errorf("fields: %v", ae.Fields)
	}

	// Variants resolve presets the same way.
	orig := e.problem(t, `,"body":"ORIGINAL-BODY-TEXT"`)
	res := must(e.app.Variant(e.ctx, orig.ID, decodeInto[app.VariantInput](t, `{"mode":"harder"}`)))
	req := e.ai.Last()
	if res.Style == nil || res.Style.ID != leet.ID || !strings.Contains(req.System, "STYLE-LEET") {
		t.Errorf("variant default style: %+v", res.Style)
	}
	if strings.Contains(req.System, "ORIGINAL-BODY-TEXT") || !strings.Contains(req.User, "ORIGINAL-BODY-TEXT") {
		t.Error("the original's body is data in the user turn")
	}
	res = must(e.app.Variant(e.ctx, orig.ID, decodeInto[app.VariantInput](t, `{"styleId":null}`)))
	if res.Style != nil || strings.Contains(e.ai.Last().System, "STYLE-") {
		t.Error("variant with styleId null should apply no preset")
	}
	_, err = e.app.Variant(e.ctx, orig.ID, decodeInto[app.VariantInput](t, `{"styleId":"nope"}`))
	wantCode(t, err, app.CodeValidation)

	// Test-case generation never uses presets.
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "sum"},
			"cases": []map[string]any{{"name": "a", "rationale": "r", "stdin": "1 1", "predictedStdout": "2", "isSample": false}}}, nil
	}
	must(e.app.GenerateTestCases(e.ctx, orig.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":1}`)))
	if sys := e.ai.Last().System; strings.Contains(sys, "STYLE-") || strings.Contains(sys, "<style_preset") {
		t.Error("presets must not reach the test-case prompt")
	}
}

func TestVariantModes(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R","body":"b"}`)))
	_, err := e.app.Variant(e.ctx, reading.ID, decodeInto[app.VariantInput](t, `{"mode":"harder"}`))
	wantCode(t, err, app.CodeValidation)
	res := must(e.app.Variant(e.ctx, reading.ID, decodeInto[app.VariantInput](t, `{"mode":"similar","instruction":"from a security angle"}`)))
	if res.Draft.Type != domain.TypeReading || res.Draft.Problem != nil {
		t.Errorf("a reading's variant is a reading: %+v", res.Draft)
	}
	_, err = e.app.Variant(e.ctx, reading.ID, decodeInto[app.VariantInput](t, `{"mode":"sideways"}`))
	wantCode(t, err, app.CodeValidation)
	_, err = e.app.Variant(e.ctx, "missing", decodeInto[app.VariantInput](t, `{}`))
	wantCode(t, err, app.CodeNotFound)
}

func TestGenerateTestCasesVerification(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"EXISTING-SOLUTION"}}`)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return map[string]any{
			"referenceSolution": map[string]any{"language": "cpp", "source": "sum"},
			"cases": []map[string]any{
				{"name": "small", "rationale": "min", "stdin": "1 1", "predictedStdout": "2", "isSample": true},
				{"name": "mispredicted", "rationale": "x", "stdin": "2 2", "predictedStdout": "5", "isSample": false},
				{"name": "extra", "rationale": "x", "stdin": "3 3", "predictedStdout": "6", "isSample": false},
			},
		}, nil
	}
	res := must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"count":2}`)))
	if res.ReferenceSolution.Language != "python" || !res.Verification.Attempted || *res.Verification.Engine != "fake" ||
		res.Verification.Error != nil || len(res.Cases) != 2 {
		t.Fatalf("response: %+v", res)
	}
	c0, c1 := res.Cases[0], res.Cases[1]
	if !c0.Verified || c0.ExpectedStdout != "2\n" || !*c0.PredictionMatched {
		t.Errorf("case 0: %+v", c0)
	}
	if !c1.Verified || c1.ExpectedStdout != "4\n" || *c1.PredictionMatched || c1.PredictedStdout != "5" {
		t.Errorf("case 1 disagreement must be surfaced: %+v", c1)
	}
	if u := e.ai.Last().User; !strings.Contains(u, "EXISTING-SOLUTION") {
		t.Error("the existing reference solution is given to the model as context")
	}
	// A failing reference solution keeps predictions, unverified.
	e.engine.Handler = func(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		return judge.ExecResult{Status: judge.StatusRuntimeError, Stderr: "Traceback"}, nil
	}
	res = must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{}`)))
	if c := res.Cases[0]; c.Verified || c.PredictionMatched != nil || c.Error == nil || c.ExpectedStdout != c.PredictedStdout {
		t.Errorf("failed run: %+v", c)
	}
	// The engine being unreachable is a verification-level error.
	e.engine.Handler = nil
	e.engine.SetHealth(errors.New("down"))
	res = must(e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{}`)))
	if !res.Verification.Attempted || res.Verification.Error == nil || res.Cases[0].Verified {
		t.Errorf("unreachable engine: %+v", res.Verification)
	}
	for _, js := range []string{`{"count":0}`, `{"count":31}`, `{"language":"cobol"}`, `{"instruction":"` + strings.Repeat("x", 2001) + `"}`} {
		_, err := e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, js))
		wantCode(t, err, app.CodeValidation)
	}
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	_, err := e.app.GenerateTestCases(e.ctx, reading.ID, decodeInto[app.GenerateTestCasesInput](t, `{}`))
	wantCode(t, err, app.CodeValidation)

	// Without an engine, nothing is attempted.
	ne := newEnv(t, withoutEngine())
	ne.enableAI(t)
	ne.ai.Respond = e.ai.Respond
	p := ne.problem(t, "")
	res = must(ne.app.GenerateTestCases(ne.ctx, p.ID, decodeInto[app.GenerateTestCasesInput](t, `{}`)))
	if res.Verification.Attempted || res.Verification.Engine != nil || res.Cases[0].Verified || res.Cases[0].ExpectedStdout != "2" ||
		res.Cases[0].PredictionMatched != nil {
		t.Errorf("no engine: %+v %+v", res.Verification, res.Cases[0])
	}
}

func TestVariantRevisionUsesPreviousDraft(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	orig := e.problem(t, "")
	must(e.app.Variant(e.ctx, orig.ID, decodeInto[app.VariantInput](t,
		`{"mode":"harder","instruction":"use a grid instead","previousDraft":{"title":"EARLIER-VARIANT"}}`)))
	req := e.ai.Last()
	if !strings.Contains(req.User, "<previous_draft-") || !strings.Contains(req.User, "EARLIER-VARIANT") || !strings.Contains(req.User, "use a grid") {
		t.Errorf("revision prompt: %s", req.User)
	}
	if strings.Contains(req.System, "EARLIER-VARIANT") || strings.Contains(req.System, "use a grid") {
		t.Error("the previous draft and instruction are data in the user turn")
	}
	_, err := e.app.Variant(e.ctx, orig.ID, decodeInto[app.VariantInput](t, `{"previousDraft":[1,2]}`))
	wantCode(t, err, app.CodeValidation)
	_, err = e.app.Variant(e.ctx, orig.ID, decodeInto[app.VariantInput](t, `{"instruction":"`+strings.Repeat("x", 2001)+`"}`))
	wantCode(t, err, app.CodeValidation)
}

func TestAIRequestHonoursCancellation(t *testing.T) {
	slow := &ctxProvider{started: make(chan struct{})}
	e := newEnv(t, func(o *app.Options) {
		o.Providers[ai.ProviderAnthropic] = func(ai.Config) (ai.Provider, error) { return slow, nil }
	})
	e.enableAI(t)
	ctx, cancel := context.WithCancel(e.ctx)
	go func() {
		<-slow.started
		cancel() // the client went away
	}()
	_, err := e.app.Draft(ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	if err == nil || !slow.sawCancel {
		t.Errorf("cancellation not propagated: %v", err)
	}
}

type ctxProvider struct {
	started   chan struct{}
	sawCancel bool
}

func (p *ctxProvider) Name() string  { return "ctx" }
func (p *ctxProvider) Model() string { return "m" }
func (p *ctxProvider) Generate(ctx context.Context, _ ai.GenerateRequest) (ai.GenerateResponse, error) {
	close(p.started)
	<-ctx.Done()
	p.sawCancel = true
	return ai.GenerateResponse{}, ctx.Err()
}
