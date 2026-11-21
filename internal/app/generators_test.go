package app_test

import (
	"encoding/json"
	"strings"
	"testing"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

func caseInput(t *testing.T, js string) domain.TestCaseInput {
	t.Helper()
	return decodeInto[domain.TestCaseInput](t, js)
}

// A test case given a generator gets what it prints as its stdin, keeps the
// generator, and is verified like any other case.
func TestAddTestCaseWithGenerator(t *testing.T) {
	e := newEnv(t)
	e.engine.Handler = generatorHandler
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)

	tc := must(e.app.AddTestCase(e.ctx, it.ID, caseInput(t, `{"name":"Big","generator":{"language":"python","source":"gen 3000\r\n"}}`)))
	if len(tc.Stdin) != 3000 || tc.ExpectedStdout != "" || tc.Verified || tc.Origin != domain.OriginManual ||
		tc.Generator == nil || *tc.Generator != (domain.GeneratorSpec{Language: "python", Source: "gen 3000\n"}) {
		t.Fatalf("case: %+v", tc)
	}
	if b, _ := json.Marshal(tc); !strings.Contains(string(b), `"generator":{"language":"python","source":"gen 3000\n"}`) {
		t.Errorf("JSON: %.300s", b)
	}
	if b, _ := json.Marshal(must(e.app.ListTestCases(e.ctx, it.ID)).Items[0]); !strings.Contains(string(b), `"generator":null`) {
		t.Errorf("a case without a generator: %s", b)
	}
	must(e.app.VerifyTestCases(e.ctx, it.ID, true, ""))
	got := must(e.app.ListTestCases(e.ctx, it.ID)).Items[2]
	if got.ExpectedStdout != "10500\n" || !got.Verified || got.Generator == nil {
		t.Errorf("verified: %+v", got)
	}

	// An expected output given with the generator is kept.
	tc = must(e.app.AddTestCase(e.ctx, it.ID, caseInput(t, `{"generator":{"language":"python","source":"gen 400"},"expectedStdout":"1400\n","verified":true}`)))
	if len(tc.Stdin) != 400 || tc.ExpectedStdout != "1400\n" || !tc.Verified {
		t.Errorf("with an expected output: %+v", tc)
	}
}

// What a generator fails on is a validation error on its field, in plain
// words, and nothing is stored.
func TestGeneratorFailures(t *testing.T) {
	e := newEnv(t)
	e.engine.Handler = generatorHandler
	it := e.problem(t, "")
	add := func(js string) error {
		_, err := e.app.AddTestCase(e.ctx, it.ID, caseInput(t, js))
		return err
	}
	for _, c := range []struct{ body, want string }{
		{`{"generator":{"language":"cobol","source":"gen 10"}}`, "the generator is not usable: language: unknown language"},
		{`{"generator":{"language":"python","source":"  "}}`, "the generator is not usable: source: is required"},
		{`{"generator":{"language":"java","source":"gen 10"}}`, "the generator is in a language the judge does not run"},
		{`{"generator":{"language":"python","source":"COMPILE_ERROR"}}`, "the generator does not compile"},
		{`{"generator":{"language":"python","source":"crash"}}`, "the generator failed: runtime error: boom"},
		{`{"generator":{"language":"python","source":"timeout"}}`, "the generator failed: time limit exceeded"},
		{`{"generator":{"language":"python","source":"gen-big"}}`, "the generator printed more than 1048576 bytes"},
		{`{"generator":{"language":"python","source":"gen-empty"}}`, "the generator printed nothing"},
		{`{"generator":{"language":"python","source":"gen-badutf8"}}`, "the generator printed something that is not UTF-8"},
		{`{"generator":{"language":"python","source":"gen-text 5 5"}}`, `the generated input repeats "h1"`},
	} {
		err := add(c.body)
		wantField(t, err, "generator")
		if msg := app.AsError(err).Fields["generator"].(string); !strings.Contains(msg, c.want) {
			t.Errorf("%s: %q, want %q", c.body, msg, c.want)
		}
	}
	// With stdin as well, the generator is only checked, never run.
	calls := e.engine.Calls()
	wantField(t, add(`{"stdin":"4 4","expectedStdout":"8","generator":{"language":"cobol","source":"x"}}`), "generator")
	// Without a generator, an expected output is still required.
	wantField(t, add(`{"stdin":"1"}`), "expectedStdout")
	if n := len(must(e.app.ListTestCases(e.ctx, it.ID)).Items); n != 2 {
		t.Errorf("%d cases stored", n)
	}
	if e.engine.Calls() != calls {
		t.Error("a generator given with its stdin ran")
	}
	// A reading or a missing item is refused before anything runs.
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	_, err := e.app.AddTestCase(e.ctx, reading.ID, caseInput(t, `{"generator":{"language":"python","source":"gen 10"}}`))
	wantField(t, err, "type")
	_, err = e.app.AddTestCase(e.ctx, "nope", caseInput(t, `{"generator":{"language":"python","source":"gen 10"}}`))
	wantCode(t, err, app.CodeNotFound)
	if e.engine.Calls() != calls {
		t.Error("a generator ran for an item that cannot have test cases")
	}
}

// A new case given both stdin and a generator is stored as given, without
// running anything: on every create path, and without an engine.
func TestCasesWithStdinAndGenerator(t *testing.T) {
	e := newEnv(t, withoutEngine())
	it := e.problem(t, "")
	tc := must(e.app.AddTestCase(e.ctx, it.ID, caseInput(t,
		`{"stdin":"1 2","expectedStdout":"3","verified":true,"generator":{"language":"python","source":"print(1, 2)"}}`)))
	if tc.Stdin != "1 2" || !tc.Verified || tc.Generator == nil || tc.Generator.Source != "print(1, 2)" {
		t.Errorf("add: %+v", tc)
	}
	list := must(e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t,
		`{"cases":[{"stdin":"7 7","expectedStdout":"14","generator":{"language":"cpp","source":"int main() {}"}}]}`)))
	if c := list.Items[3]; c.Stdin != "7 7" || c.Generator == nil || c.Generator.Language != "cpp" {
		t.Errorf("bulk: %+v", c)
	}
	// stdin null is still not a stdin.
	_, err := e.app.AddTestCase(e.ctx, it.ID, caseInput(t, `{"stdin":null,"expectedStdout":"3","generator":{"language":"python","source":"x"}}`))
	wantField(t, err, "stdin")
}

func TestGeneratorsWithoutAnEngine(t *testing.T) {
	e := newEnv(t, withoutEngine())
	it := e.problem(t, "")
	_, err := e.app.AddTestCase(e.ctx, it.ID, caseInput(t, `{"generator":{"language":"python","source":"gen 10"}}`))
	wantCode(t, err, app.CodeJudgeUnavailable)
	_, err = e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t,
		`{"cases":[{"generator":{"language":"python","source":"gen 10"}}]}`))
	wantCode(t, err, app.CodeJudgeUnavailable)
	// The engine is checked after the generator itself.
	_, err = e.app.AddTestCase(e.ctx, it.ID, caseInput(t, `{"generator":{"language":"cobol","source":"gen 10"}}`))
	wantField(t, err, "generator")
}

// The generators of a bulk request run in parallel before anything is
// stored, and if one fails nothing is.
func TestBulkTestCasesWithGenerators(t *testing.T) {
	e := newEnv(t)
	e.engine.Handler = generatorHandler
	it := e.problem(t, "")
	bulk := func(js string) (app.List[domain.TestCase], error) {
		return e.app.BulkTestCases(e.ctx, it.ID, decodeInto[app.BulkTestCasesInput](t, js))
	}
	_, err := bulk(`{"cases":[{"stdin":"8 8","expectedStdout":"16"},
		{"generator":{"language":"python","source":"gen 1000"}},
		{"generator":{"language":"python","source":"crash"}}]}`)
	wantField(t, err, "cases.2.generator")
	// Repeats of an earlier case of the request, by its stdin or its
	// generator, and of a stored case.
	_, err = bulk(`{"cases":[{"name":"Typed","stdin":"7 7 ","expectedStdout":"14"},
		{"generator":{"language":"python","source":"gen 4"}},
		{"generator":{"language":"python","source":"gen 1000"}},
		{"generator":{"language":"python","source":"gen 1000\n"}}]}`)
	fields := wantCode(t, err, app.CodeValidation).Fields
	if fields["cases.1.generator"] != `the generated input repeats "Typed"` ||
		fields["cases.3.generator"] != "the generated input repeats case 3 of the request" || len(fields) != 2 {
		t.Errorf("repeats: %v", fields)
	}
	_, err = bulk(`{"cases":[{"stdin":"3 3","expectedStdout":"6"},{"generator":{"language":"python","source":"gen-text 1 2"}}]}`)
	if fields := wantCode(t, err, app.CodeValidation).Fields; fields["cases.1.generator"] != `the generated input repeats "s1"` {
		t.Errorf("repeat of a stored case: %v", fields)
	}
	_, err = bulk(`{"cases":[{"stdin":"1","expectedStdout":"1","generator":{"language":"python","source":""}}]}`)
	wantField(t, err, "cases.0.generator")
	if n := len(must(e.app.ListTestCases(e.ctx, it.ID)).Items); n != 2 {
		t.Fatalf("%d cases stored after failed requests", n)
	}

	list := must(bulk(`{"cases":[{"name":"a","stdin":"8 8","expectedStdout":"16"},
		{"name":"b","generator":{"language":"python","source":"gen 1000"},"origin":"ai"},
		{"name":"c","generator":{"language":"python","source":"gen 2000"},"expectedStdout":"7000\n","verified":true}]}`))
	if len(list.Items) != 5 {
		t.Fatalf("cases: %d", len(list.Items))
	}
	b, c := list.Items[3], list.Items[4]
	if len(b.Stdin) != 1000 || b.Generator.Source != "gen 1000" || b.Origin != domain.OriginAI || b.Verified ||
		len(c.Stdin) != 2000 || !c.Verified || c.ExpectedStdout != "7000\n" || list.Items[2].Generator != nil {
		t.Errorf("stored: %+v %+v", b, c)
	}
	// Replacing keeps the samples only, so a generated input may repeat a
	// hidden case that goes.
	list = must(bulk(`{"replace":true,"cases":[{"generator":{"language":"python","source":"gen-text 5 5"}}]}`))
	if len(list.Items) != 2 || list.Items[1].Stdin != "5 5\n" {
		t.Errorf("replaced: %+v", list.Items)
	}
}

// PATCH: a generator runs and replaces stdin; null drops it and keeps
// stdin; a new stdin alone drops it too; both at once are refused.
func TestUpdateTestCaseGenerator(t *testing.T) {
	e := newEnv(t)
	e.engine.Handler = generatorHandler
	it := e.problem(t, "")
	cases := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	id := cases[1].ID
	must(e.app.UpdateTestCase(e.ctx, id, caseInput(t, `{"verified":true}`)))
	patch := func(js string) (domain.TestCase, error) { return e.app.UpdateTestCase(e.ctx, id, caseInput(t, js)) }

	tc := must(patch(`{"generator":{"language":"python","source":"gen 600"}}`))
	if len(tc.Stdin) != 600 || tc.Generator == nil || tc.Verified || tc.ExpectedStdout != "10" {
		t.Fatalf("generated: %+v", tc)
	}
	tc = must(patch(`{"generator":{"language":"python","source":"gen 800"},"verified":true}`))
	if len(tc.Stdin) != 800 || tc.Generator.Source != "gen 800" || !tc.Verified {
		t.Errorf("verified in the same input: %+v", tc)
	}
	_, err := patch(`{"generator":{"language":"python","source":"gen 10"},"stdin":"1"}`)
	wantField(t, err, "generator")
	_, err = patch(`{"generator":{"language":"python","source":"gen-text 1 2"}}`)
	wantField(t, err, "generator")
	// The same generator again is no change.
	before := must(e.app.GetItem(e.ctx, it.ID)).UpdatedAt
	tc = must(patch(`{"generator":{"language":"python","source":"gen 800"}}`))
	if !tc.Verified || !must(e.app.GetItem(e.ctx, it.ID)).UpdatedAt.Equal(before) {
		t.Errorf("unchanged: %+v", tc)
	}
	tc = must(patch(`{"generator":null}`))
	if tc.Generator != nil || len(tc.Stdin) != 800 || !tc.Verified {
		t.Errorf("dropped: %+v", tc)
	}
	must(patch(`{"generator":{"language":"python","source":"gen 900"}}`))
	tc = must(patch(`{"stdin":"3 4"}`))
	if tc.Generator != nil || tc.Stdin != "3 4" {
		t.Errorf("typed stdin: %+v", tc)
	}
	must(patch(`{"generator":{"language":"python","source":"gen 900"}}`))
	if tc = must(patch(`{"name":"renamed","expectedStdout":"x"}`)); tc.Generator == nil {
		t.Error("an edit that leaves stdin alone dropped the generator")
	}
}

// Creating an item runs the generators of the cases without stdin; a case
// that has both, such as a draft's large case, keeps them as given.
func TestCreateItemWithGenerators(t *testing.T) {
	e := newEnv(t)
	e.engine.Handler = generatorHandler
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"P","testCases":[
		{"name":"s","stdin":"1 2","expectedStdout":"3","isSample":true},
		{"name":"run","generator":{"language":"python","source":"gen 500"}},
		{"name":"kept","stdin":"9 9\n","expectedStdout":"18\n","verified":true,"generator":{"language":"python","source":"print(9, 9)"}}]}`)))
	cases := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if len(cases) != 3 || len(cases[1].Stdin) != 500 || cases[1].Generator == nil || cases[2].Stdin != "9 9\n" ||
		!cases[2].Verified || cases[2].Generator.Source != "print(9, 9)" {
		t.Fatalf("cases: %+v", cases)
	}
	_, err := e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"P","testCases":[
		{"generator":{"language":"python","source":"gen-empty"}}]}`))
	wantField(t, err, "testCases.0.generator")
	_, err = e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"P","testCases":[
		{"stdin":"1","expectedStdout":"1","generator":{"language":"cobol","source":"x"}}]}`))
	wantField(t, err, "testCases.0.generator")
	// An invalid item is refused before any generator runs.
	calls := e.engine.Calls()
	_, err = e.app.CreateItem(e.ctx, input(t, `{"type":"problem","testCases":[{"generator":{"language":"python","source":"gen 10"}}]}`))
	wantField(t, err, "title")
	if e.engine.Calls() != calls {
		t.Error("a generator ran for an invalid item")
	}
}

// Saving a draft stores its large cases' generators.
func TestSavedDraftKeepsGenerators(t *testing.T) {
	e := newEnv(t)
	e.enableAI(t)
	e.engine.Handler = generatorHandler
	res := must(draftWith(t, e, `{"text":"x","largeTestCases":1}`, largeDraft(gen("gen 2000"))))
	var cases []domain.TestCaseInput
	for _, c := range res.Draft.TestCases {
		cases = append(cases, caseInput(t, mustJSON(t, c)))
	}
	d, _, err := e.app.CreateDraft(e.ctx, decodeInto[app.NewDraftInput](t, `{"kind":"capture"}`))
	if err != nil {
		t.Fatal(err)
	}
	in := domain.ItemInput{Type: domain.Some(domain.TypeProblem), Title: domain.Some("Saved"), TestCases: domain.Some(cases)}
	it := must(e.app.SaveDraft(e.ctx, d.ID, app.DraftSaveInput{Item: in}))
	stored := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if len(stored) != 2 || stored[0].Generator != nil || stored[1].Generator == nil || stored[1].Generator.Source != "gen 2000" ||
		len(stored[1].Stdin) != 2000 || !stored[1].Verified {
		t.Errorf("saved: %+v", stored)
	}
}

// An export carries a case's generator, and an import stores it; the
// generator is not content, so it does not make an item changed.
func TestBundlesCarryGenerators(t *testing.T) {
	src := newEnv(t)
	src.engine.Handler = generatorHandler
	it := src.problem(t, "")
	must(src.app.AddTestCase(src.ctx, it.ID, caseInput(t, `{"name":"Big","generator":{"language":"python","source":"gen 300"},"expectedStdout":"1050\n"}`)))
	data := src.export(t, `{"scope":"all"}`)
	if txt := zipText(t, data); !strings.Contains(txt, "tests/03.gen.py\ngen 300") {
		t.Errorf("export: %.2000s", txt)
	}
	dst := newEnv(t)
	must(dst.app.Import(dst.ctx, data, ""))
	cases := must(dst.app.ListTestCases(dst.ctx, it.ID)).Items
	if len(cases) != 3 || cases[2].Generator == nil || cases[2].Generator.Source != "gen 300" || len(cases[2].Stdin) != 300 {
		t.Errorf("imported: %+v", cases)
	}
	// Without the generator the item is the same content.
	must(dst.app.UpdateTestCase(dst.ctx, cases[2].ID, caseInput(t, `{"generator":null}`)))
	if pre := must(dst.app.PreviewImport(dst.ctx, data)); pre.Counts.Unchanged != 1 {
		t.Errorf("preview: %+v", pre.Counts)
	}
}
