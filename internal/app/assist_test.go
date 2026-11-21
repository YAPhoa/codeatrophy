package app_test

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/judge"
)

func (e *env) enableAI(t *testing.T) {
	t.Helper()
	p := e.addProvider(t, `{"name":"Test","kind":"anthropic","apiKey":"sk-ant-test-1234"}`)
	e.setDefault(t, p.ID)
}

func (e *env) addProvider(t *testing.T, js string) app.AIProvider {
	t.Helper()
	return must(e.app.CreateAIProvider(e.ctx, decodeInto[app.AIProviderInput](t, js)))
}

func (e *env) setDefault(t *testing.T, id string) app.AISettings {
	t.Helper()
	return must(e.app.UpdateAISettings(e.ctx, app.AISettingsInput{DefaultProviderID: domain.Some(id)}))
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

// casesAnswer is a model's answer to a test-case request: the reference
// solution "sum" and one case.
func casesAnswer(stdin, predicted string) map[string]any {
	return map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "sum"},
		"cases": []map[string]any{{"name": "n", "rationale": "r", "stdin": stdin, "predictedStdout": predicted}}}
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
	res = must(draftWith(t, e, `{"text":"notes","typeHint":"reading"}`, reading))
	if res.Draft.Problem != nil || len(res.Draft.TestCases) != 0 {
		t.Errorf("reading draft: %+v", res.Draft)
	}
}

func draftWith(t *testing.T, e *env, js string, out any) (app.DraftResponse, error) {
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return out, nil }
	return e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, js))
}

// Whitespace inside a tag the model suggests becomes "-", as for tags typed
// in the UI; tags saved through the API are left as they are.
func TestDraftTagsAreHyphenated(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	d := draftJSON()
	d["tags"] = []string{"Shortest  Path", "graph\ttheory ", " dp ", "two pointers", "shortest-path", "a/b", "   "}
	res := must(draftWith(t, e, `{"text":"x"}`, d))
	if got := strings.Join(res.Draft.Tags, ","); got != "dp,graph-theory,shortest-path,two-pointers" {
		t.Errorf("draft tags: %s", got)
	}
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"T","tags":["Shortest Path"]}`)))
	if strings.Join(it.Tags, ",") != "shortest path" {
		t.Errorf("item tags: %v", it.Tags)
	}
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
	_, err := draftWith(t, e, `{"text":"x","instruction":"`+strings.Repeat("i", domain.MaxGenerationInstructionChars)+`"}`, draftJSON())
	if err != nil {
		t.Errorf("instruction at the limit: %v", err)
	}
	untitled := draftJSON()
	untitled["title"] = " \n "
	_, err = draftWith(t, e, `{"text":"x"}`, untitled)
	if ae := wantCode(t, err, app.CodeUpstream); !strings.Contains(ae.Message, "without a title") {
		t.Errorf("untitled draft: %s", ae.Message)
	}
	e.ai.Respond = func(ai.GenerateRequest) (any, error) {
		return nil, ai.Errorf(401, "the Anthropic API rejected the API key sk-ant-test-1234")
	}
	_, err = e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"}`))
	ae := wantCode(t, err, app.CodeUpstream)
	if strings.Contains(ae.Message, "sk-ant-test-1234") {
		t.Errorf("the API key leaked into the error: %s", ae.Message)
	}
	// A revision passes the previous draft and the instruction as data.
	_, err = draftWith(t, e, `{"text":"x","instruction":"make it harder","previousDraft":{"title":"Old"}}`, draftJSON())
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
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return casesAnswer("1 1", "2"), nil }
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
			"referenceSolution": map[string]any{"language": "python", "source": "sum"},
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
	if !c1.Verified || c1.ExpectedStdout != "4\n" || *c1.PredictionMatched || *c1.PredictedStdout != "5" {
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
	if c := res.Cases[0]; c.Verified || c.PredictionMatched != nil || c.Error == nil || c.ExpectedStdout != *c.PredictedStdout {
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

// The output schema only allows the requested language, and a model that
// answers in another one is an upstream error.
func TestGenerateTestCasesLanguageMismatch(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	it := e.problem(t, "")
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return casesAnswer("1 1", "2"), nil }
	_, err := e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, `{"language":"cpp"}`))
	wantCode(t, err, app.CodeUpstream)
	b, _ := json.Marshal(e.ai.Last().Schema)
	if !strings.Contains(string(b), `"enum":["cpp"]`) {
		t.Errorf("schema does not pin the language: %s", b)
	}
}

// The draft text limit counts code points after line-ending normalization,
// and model-written titles are kept on one line.
func TestDraftCountsNormalizedText(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	d := draftJSON()
	d["title"] = "Two Sum\n  again"
	e.ai.Responses = []any{d}
	text := strings.Repeat(`a\r\n`, app.MaxDraftTextChars/2) // 1.5x the limit raw, at the limit after \r\n -> \n
	res := must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"`+text+`"}`)))
	if res.Draft.Title != "Two Sum again" {
		t.Errorf("title %q", res.Draft.Title)
	}
	if u := e.ai.Last().User; strings.Contains(u, "\r") {
		t.Error("the model sees normalized text")
	}
}

// A model's answer that cannot be used fails the generation; a reference
// solution the engine cannot run leaves every case unverified, with the
// reason.
func TestGenerateTestCasesFailures(t *testing.T) {
	e := newEnv(t, withToolchains(20)) // cpp programs of at most 20 bytes
	e.enableAI(t)
	it := e.problem(t, "")
	generate := func(js string, answer map[string]any) (app.GenerateTestCasesResponse, error) {
		e.ai.Respond = func(ai.GenerateRequest) (any, error) { return answer, nil }
		return e.app.GenerateTestCases(e.ctx, it.ID, decodeInto[app.GenerateTestCasesInput](t, js))
	}
	big := strings.Repeat("1 ", domain.MaxTestCaseBytes)
	withCases := func(cases ...map[string]any) map[string]any {
		a := casesAnswer("", "")
		a["cases"] = cases
		return a
	}
	unusable := casesAnswer("7 7", "14")
	unusable["referenceSolution"] = map[string]any{"language": "python", "source": "  "}
	for name, c := range map[string]struct {
		answer map[string]any
		want   string
	}{
		"not the schema":       {map[string]any{"referenceSolution": "sum", "cases": []any{}}, "do not match the schema"},
		"unusable reference":   {unusable, "unusable reference solution"},
		"no cases":             {withCases(), "no usable test cases"},
		"only oversized cases": {withCases(map[string]any{"name": "n", "stdin": big, "predictedStdout": "0"}), "no usable test cases"},
	} {
		_, err := generate(`{}`, c.answer)
		if ae := wantCode(t, err, app.CodeUpstream); !strings.Contains(ae.Message, c.want) {
			t.Errorf("%s: %s", name, ae.Message)
		}
	}
	res := must(generate(`{}`, withCases(map[string]any{"name": "big", "stdin": big, "predictedStdout": "0"},
		map[string]any{"name": "small", "stdin": "7 7", "predictedStdout": "14"})))
	if len(res.Cases) != 1 || res.Cases[0].Name != "small" || !res.Cases[0].Verified {
		t.Errorf("an oversized case among others: %+v", res.Cases)
	}

	for name, c := range map[string]struct {
		lang, source, want string
	}{
		"language not offered": {"java", "class Main {}", `language "java" is not offered by the judge engine`},
		"program too large":    {"cpp", "int main() { return 0; }", "the reference solution cannot run: the program is 24 bytes"},
		"does not compile":     {"cpp", "compile_error", "the reference solution does not compile: main.cpp:1: error"},
	} {
		answer := casesAnswer("7 7", "14")
		answer["referenceSolution"] = map[string]any{"language": c.lang, "source": c.source}
		res, err := generate(`{"language":"`+c.lang+`"}`, answer)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		v := res.Verification
		if !v.Attempted || v.Error == nil || !strings.Contains(*v.Error, c.want) {
			t.Errorf("%s: verification %+v %s", name, v, ptrString(v.Error))
		}
		if cs := res.Cases; len(cs) != 1 || cs[0].Verified || cs[0].Error == nil || *cs[0].Error != *v.Error ||
			cs[0].ExpectedStdout != "14" || cs[0].PredictionMatched != nil {
			t.Errorf("%s: cases %+v", name, cs)
		}
	}
}

// testCasesDesc is the description of the test cases in a request's schema.
func testCasesDesc(req ai.GenerateRequest) any {
	return req.Schema["properties"].(map[string]any)["testCases"].(map[string]any)["description"]
}

// A draft or variant asks for testCaseCount at least testCaseCount test cases when given
// one; without it, or with 0, the request is as it always was. A reading
// ignores it.
func TestDraftAndVariantTestCaseCount(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R","body":"b"}`)))
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return draftJSON(), nil }
	const asked = `"testCases" holds at least 8 test cases:`
	stable := func(req ai.GenerateRequest) string {
		nonce := regexp.MustCompile(`suffix ([0-9a-f]{24}) is unique`).FindStringSubmatch(req.System)[1]
		return strings.ReplaceAll(req.System+req.User, nonce, "NONCE")
	}
	type gen func(js string) (ai.GenerateRequest, error)
	draft := func(js string) (ai.GenerateRequest, error) {
		_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x"`+js+`}`))
		return e.ai.Last(), err
	}
	variant := func(js string) (ai.GenerateRequest, error) {
		_, err := e.app.Variant(e.ctx, it.ID, decodeInto[app.VariantInput](t, `{"mode":"harder"`+js+`}`))
		return e.ai.Last(), err
	}
	for name, run := range map[string]gen{"draft": draft, "variant": variant} {
		plain := must(run(""))
		zero := must(run(`,"testCaseCount":0`))
		if stable(plain) != stable(zero) || strings.Contains(plain.System, "holds at least") || strings.Contains(plain.System, "## Test design") ||
			testCasesDesc(plain) != "Sample test cases (empty for readings)" {
			t.Errorf("%s: 0 is no count:\n%s", name, zero.System)
		}
		eight := must(run(`,"testCaseCount":8`))
		if !strings.Contains(eight.System, asked) || !strings.Contains(eight.System, ai.EditableTestCaseRules) ||
			testCasesDesc(eight) != "At least 8 test cases: the sample cases, then hidden ones (empty for readings)" {
			t.Errorf("%s with 8:\n%s", name, eight.System)
		}
		if req := must(run(`,"testCaseCount":30`)); !strings.Contains(req.System, `holds at least 30 test cases:`) {
			t.Errorf("%s: the upper bound", name)
		}
		for _, bad := range []string{`,"testCaseCount":31`, `,"testCaseCount":-1`} {
			_, err := run(bad)
			if wantField(t, err, "testCaseCount"); app.AsError(err).Fields["testCaseCount"] != "must be between 0 and 30" {
				t.Errorf("%s %s: %v", name, bad, app.AsError(err).Fields)
			}
		}
	}
	// Not an integer: refused when the request is decoded, as a job's is.
	for _, bad := range []string{`"8"`, `2.5`, `true`} {
		_, _, err := e.app.CreateDraft(e.ctx, decodeInto[app.NewDraftInput](t, `{"kind":"capture","generate":{"text":"x","testCaseCount":`+bad+`}}`))
		if wantField(t, err, "testCaseCount"); app.AsError(err).Fields["testCaseCount"] != "must be an integer" {
			t.Errorf("%s: %v", bad, app.AsError(err).Fields)
		}
	}

	// A reading ignores it, but it is still checked.
	r := draftJSON()
	r["type"] = "reading"
	e.ai.Respond = func(ai.GenerateRequest) (any, error) { return r, nil }
	must(e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x","typeHint":"reading","testCaseCount":8}`)))
	if req := e.ai.Last(); strings.Contains(req.System, "holds at least") || testCasesDesc(req) != "Sample test cases (empty for readings)" {
		t.Errorf("a reading draft asked for test cases:\n%s", req.System)
	}
	must(e.app.Variant(e.ctx, reading.ID, decodeInto[app.VariantInput](t, `{"testCaseCount":8}`)))
	if strings.Contains(e.ai.Last().System, "holds at least") {
		t.Error("a reading's variant asked for test cases")
	}
	_, err := e.app.Draft(e.ctx, decodeInto[app.DraftInput](t, `{"text":"x","typeHint":"reading","testCaseCount":31}`))
	wantField(t, err, "testCaseCount")
}

// The draft check runs every test case a draft can have, as many as the
// instance allows, hidden ones included, and marks those that pass
// verified; it corrects none.
func TestDraftCheckCoversEveryCase(t *testing.T) {
	const n = 40
	e := newEnv(t, func(o *app.Options) { o.Limits.MaxGeneratedTestCases = n })
	e.enableAI(t)
	e.engine.Handler = harnessHandler
	d := draftJSON()
	d["problem"].(map[string]any)["referenceSolution"] = map[string]string{"language": "python", "source": "sum"}
	var cases []map[string]any
	for i := range n + 5 {
		want := strconv.Itoa(i)
		if i == n-1 {
			want = "wrong"
		}
		cases = append(cases, map[string]any{"name": "c" + strconv.Itoa(i), "stdin": strconv.Itoa(i), "expectedStdout": want, "isSample": i < 2})
	}
	d["testCases"] = cases
	res := must(draftWith(t, e, `{"text":"x","testCaseCount":40}`, d))
	c := res.Check
	if !c.Attempted || c.Total != n || c.Passed != n-1 || c.Error == nil ||
		!strings.Contains(*c.Error, `"c39"`) || len(res.Draft.TestCases) != n {
		t.Fatalf("check: %+v %v", c, c.Error)
	}
	for i, tc := range res.Draft.TestCases {
		if tc.Verified != (i < n-1) || tc.IsSample != (i < 2) {
			t.Errorf("case %d: %+v", i, tc)
		}
	}
	if last := res.Draft.TestCases[n-1]; last.ExpectedStdout != "wrong" {
		t.Errorf("the check corrected an expected output: %+v", last)
	}
}
