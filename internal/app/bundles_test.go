package app_test

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

// library builds: collection "DP" > child "Easy"; problem P (in DP, Easy)
// with a sample and a hidden case and a solution; reading R (in Easy);
// variant V of P (in no collection).
func (e *env) library(t *testing.T) (dp, easy domain.Collection, p, r, v domain.Item) {
	t.Helper()
	dp = must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"DP"}`)))
	easy = must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"Easy","parentId":"`+dp.ID+`"}`)))
	p = must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"Knapsack","body":"## Problem","tags":["dp"],
		"status":"done","favorite":true,"notes":"PRIVATE-NOTES","rawInput":"RAW-AI-INPUT",
		"problem":{"starterCode":{"python":"import sys"},"referenceSolution":{"language":"python","source":"sum"}},
		"collectionIds":["`+dp.ID+`","`+easy.ID+`"],
		"testCases":[{"name":"s","stdin":"1 2","expectedStdout":"3","isSample":true},{"name":"h","stdin":"2 2","expectedStdout":"4"}]}`)))
	r = must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"Notes on DP","body":"text","collectionIds":["`+easy.ID+`"]}`)))
	v = must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"Knapsack II","variantOf":"`+p.ID+`"}`)))
	return
}

func (e *env) export(t *testing.T, js string) []byte {
	t.Helper()
	res := must(e.app.Export(e.ctx, decodeInto[app.ExportInput](t, js)))
	return res.Data
}

func zipText(t *testing.T, data []byte) string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		all.WriteString(f.Name + "\n" + string(b) + "\n")
	}
	return all.String()
}

func TestExportScopesAndContentOnly(t *testing.T) {
	e := newEnv(t)
	must(e.app.CreateStylePreset(e.ctx, decodeInto[domain.StylePresetInput](t, `{"name":"PRESET-NAME","instructions":"PRESET-INSTRUCTIONS","isDefault":true}`)))
	e.enableAI(t)
	dp, easy, p, _, _ := e.library(t)
	e.submit(t, p.ID, `{"language":"python","source":"SUBMITTED-SOURCE","mode":"run"}`)
	// A solution's last run is instance-local, like submissions.
	must(e.app.VerifyTestCases(e.ctx, p.ID, false, ""))
	if sols := must(e.app.ListSolutions(e.ctx, p.ID)).Items; sols[0].LastRun == nil {
		t.Fatal("the reference solution has no last run")
	}

	res := must(e.app.Export(e.ctx, decodeInto[app.ExportInput](t, `{"scope":"all"}`)))
	if res.Filename != "codeatrophy-library.codeatrophy.zip" || res.Items != 3 {
		t.Errorf("all: %s, %d items", res.Filename, res.Items)
	}
	text := zipText(t, res.Data)
	for _, secret := range []string{"PRIVATE-NOTES", "RAW-AI-INPUT", "SUBMITTED-SOURCE", "PRESET-NAME", "PRESET-INSTRUCTIONS",
		"sk-ant-test-1234", `"status"`, `"favorite"`, "lastRun", "ranAt", "passed"} {
		if strings.Contains(text, secret) {
			t.Errorf("bundle contains %q", secret)
		}
	}
	coll := must(e.app.Export(e.ctx, decodeInto[app.ExportInput](t, `{"scope":"collection","collectionId":"`+easy.ID+`"}`)))
	if coll.Filename != "easy.codeatrophy.zip" || coll.Items != 2 {
		t.Errorf("collection: %s, %d items", coll.Filename, coll.Items)
	}
	if strings.Contains(zipText(t, coll.Data), dp.ID) {
		t.Error("the root of a collection export is written with parentId null")
	}
	items := must(e.app.Export(e.ctx, decodeInto[app.ExportInput](t, `{"scope":"items","itemIds":["`+p.ID+`"],"name":"Just one"}`)))
	if items.Items != 1 || !strings.Contains(zipText(t, items.Data), `"collections": []`) {
		t.Error("an item selection exports no collections")
	}
	for _, js := range []string{`{"scope":"galaxy"}`, `{"scope":"collection"}`, `{"scope":"collection","collectionId":"nope"}`,
		`{"scope":"items"}`, `{"scope":"items","itemIds":["nope"]}`} {
		_, err := e.app.Export(e.ctx, decodeInto[app.ExportInput](t, js))
		wantCode(t, err, app.CodeValidation)
	}
}

func TestImportIntoEmptyLibraryAndIdempotence(t *testing.T) {
	src := newEnv(t)
	dp, easy, p, _, v := src.library(t)
	data := src.export(t, `{"scope":"all"}`)

	dst := newEnv(t)
	pre := must(dst.app.PreviewImport(dst.ctx, data))
	if pre.Counts.New != 3 || pre.Counts.Changed != 0 || len(pre.Collections) != 2 || pre.Collections[0].State != "new" {
		t.Errorf("preview: %+v", pre)
	}
	if st := must(dst.app.Stats(dst.ctx)); st.Items.Total != 0 {
		t.Error("preview must not write")
	}
	res := must(dst.app.Import(dst.ctx, data, ""))
	if res.Created != 3 || res.CollectionsCreated != 2 {
		t.Errorf("import: %+v", res)
	}
	got := must(dst.app.GetItem(dst.ctx, p.ID))
	if got.ID != p.ID || got.Status != domain.StatusTodo || got.Favorite || got.Notes != "" || got.RawInput != nil ||
		got.TestCaseCount != 2 || got.Problem.ReferenceSolution == nil || len(got.CollectionIDs) != 2 {
		t.Errorf("imported item: %+v %+v", got.ItemSummary, got.Problem)
	}
	if gv := must(dst.app.GetItem(dst.ctx, v.ID)); gv.VariantOf == nil || *gv.VariantOf != p.ID {
		t.Error("variantOf links within the bundle are kept")
	}
	c := must(dst.app.GetCollection(dst.ctx, easy.ID))
	if c.ParentID == nil || *c.ParentID != dp.ID || c.ItemCount != 2 {
		t.Errorf("collection nesting: %+v", c)
	}
	// Importing the same bundle again changes nothing, a solution's last
	// run included: it is not content.
	must(dst.app.VerifyTestCases(dst.ctx, p.ID, false, ""))
	pre = must(dst.app.PreviewImport(dst.ctx, data))
	if pre.Counts.Unchanged != 3 || pre.Counts.New != 0 || pre.Collections[0].State != "existing" {
		t.Errorf("second preview: %+v", pre.Counts)
	}
	res = must(dst.app.Import(dst.ctx, data, "overwrite"))
	if res.Unchanged != 3 || res.Created+res.Updated+res.Duplicated != 0 {
		t.Errorf("second import: %+v", res)
	}
	if again := must(dst.app.GetItem(dst.ctx, p.ID)); again.Revision != got.Revision {
		t.Error("an unchanged import must not touch items")
	}
	if sols := must(dst.app.ListSolutions(dst.ctx, p.ID)).Items; sols[0].LastRun == nil {
		t.Error("an unchanged import cleared a last run")
	}
}

func TestImportStrategies(t *testing.T) {
	src := newEnv(t)
	dp, _, p, _, _ := src.library(t)
	// The destination is a copy that then diverges locally.
	dst := newEnv(t)
	must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"all"}`), ""))
	must(dst.app.UpdateItem(dst.ctx, p.ID, input(t, `{"title":"Local title","status":"in_progress","notes":"mine"}`)))
	dst.submit(t, p.ID, `{"language":"python","source":"sum","mode":"submit"}`)
	// And the source changes too.
	must(src.app.UpdateItem(src.ctx, p.ID, input(t, `{"title":"Upstream title"}`)))
	data := src.export(t, `{"scope":"all"}`)

	pre := must(dst.app.PreviewImport(dst.ctx, data))
	if pre.Counts.Changed != 1 || pre.Counts.Unchanged != 2 {
		t.Fatalf("preview: %+v", pre.Counts)
	}
	for _, it := range pre.Items {
		want := "[]"
		if it.ID == p.ID {
			want = "[title]"
		}
		if got := fmt.Sprint(it.Changes); (want == "[]" && len(it.Changes) != 0) || (want != "[]" && got != want) {
			t.Errorf("%s: changes %v, want %s", it.Title, it.Changes, want)
		}
	}
	res := must(dst.app.Import(dst.ctx, data, "skip"))
	if res.Skipped != 1 || must(dst.app.GetItem(dst.ctx, p.ID)).Title != "Local title" {
		t.Errorf("skip: %+v", res)
	}
	res = must(dst.app.Import(dst.ctx, data, "duplicate"))
	if res.Duplicated != 1 {
		t.Errorf("duplicate: %+v", res)
	}
	page := must(dst.app.ListItems(dst.ctx, app.ItemQuery{Q: "upstream"}))
	if page.Total != 1 || page.Items[0].ID == p.ID {
		t.Fatalf("the duplicate gets a fresh id: %+v", page.Items)
	}
	dup := page.Items[0]
	members := must(dst.app.ListItems(dst.ctx, app.ItemQuery{CollectionID: dp.ID, Sort: "position"}))
	ids := []string{}
	for _, it := range members.Items {
		ids = append(ids, it.ID)
	}
	if !strings.Contains(strings.Join(ids, ","), dup.ID) {
		t.Errorf("the duplicate takes the original's place in bundle collections: %v", ids)
	}
	res = must(dst.app.Import(dst.ctx, data, "overwrite"))
	if res.Updated != 1 {
		t.Errorf("overwrite: %+v", res)
	}
	got := must(dst.app.GetItem(dst.ctx, p.ID))
	if got.Title != "Upstream title" || got.Status != domain.StatusDone || got.Notes != "mine" || got.LastVerdict == nil {
		t.Errorf("overwrite keeps personal state and submissions: %+v", got.ItemSummary)
	}
	_, err := dst.app.Import(dst.ctx, data, "merge")
	wantCode(t, err, app.CodeValidation)
}

func TestPartialExportsCompareAndPreserve(t *testing.T) {
	src := newEnv(t)
	_, _, p, _, _ := src.library(t)
	dst := newEnv(t)
	must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"all"}`), ""))

	// Without solutions or hidden tests, the local solution and hidden cases
	// are ignored for the comparison...
	partial := src.export(t, `{"scope":"all","includeSolutions":false,"includeHiddenTests":false}`)
	pre := must(dst.app.PreviewImport(dst.ctx, partial))
	if pre.Counts.Unchanged != 3 {
		t.Errorf("partial bundle of identical content should be unchanged: %+v", pre.Counts)
	}
	for _, it := range pre.Items {
		if it.ID == p.ID && it.TestCaseCount != 1 {
			t.Errorf("only samples are exported: %+v", it)
		}
	}
	// ...and preserved by an overwrite.
	must(src.app.UpdateItem(src.ctx, p.ID, input(t, `{"body":"## Problem\n\nrevised","tags":["dp","knapsack"],"problem":{"timeLimitMs":3000,"referenceSolution":{"language":"python","source":"other"}}}`)))
	partial = src.export(t, `{"scope":"all","includeSolutions":false,"includeHiddenTests":false}`)
	for _, it := range must(dst.app.PreviewImport(dst.ctx, partial)).Items {
		if it.ID == p.ID && fmt.Sprint(it.Changes) != "[body tags limits]" {
			t.Errorf("partial bundle compares only what it carries: %v", it.Changes)
		}
	}
	res := must(dst.app.Import(dst.ctx, partial, "overwrite"))
	if res.Updated != 1 {
		t.Fatalf("overwrite: %+v", res)
	}
	full := src.export(t, `{"scope":"all"}`)
	for _, it := range must(dst.app.PreviewImport(dst.ctx, full)).Items {
		if it.ID == p.ID && fmt.Sprint(it.Changes) != "[solutions]" {
			t.Errorf("full bundle compares the solution too: %v", it.Changes)
		}
	}
	got := must(dst.app.GetItem(dst.ctx, p.ID))
	cases := must(dst.app.ListTestCases(dst.ctx, p.ID)).Items
	if got.Body != "## Problem\n\nrevised" || got.Problem.ReferenceSolution == nil || got.Problem.ReferenceSolution.Source != "sum" ||
		len(cases) != 2 || !cases[0].IsSample || cases[1].IsSample {
		t.Errorf("local solution and hidden cases must survive: %+v, %d cases", got.Problem, len(cases))
	}
	// A full bundle replaces the test cases entirely. Replacing in the source
	// keeps its sample, so the bundle carries the sample and the new case.
	must(src.app.BulkTestCases(src.ctx, p.ID, decodeInto[app.BulkTestCasesInput](t, `{"cases":[{"stdin":"9 9","expectedStdout":"18"}],"replace":true}`)))
	res = must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"all"}`), "overwrite"))
	after := must(dst.app.ListTestCases(dst.ctx, p.ID)).Items
	if res.Updated != 1 || len(after) != 2 || !after[0].IsSample || after[1].Stdin != "9 9" {
		t.Errorf("full overwrite: %+v, %+v", res, after)
	}
}

func TestImportVariantOfOutsideBundle(t *testing.T) {
	src := newEnv(t)
	_, _, _, _, v := src.library(t)
	dst := newEnv(t)
	res := must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"items","itemIds":["`+v.ID+`"]}`), ""))
	if res.Created != 1 {
		t.Fatalf("import: %+v", res)
	}
	if got := must(dst.app.GetItem(dst.ctx, v.ID)); got.VariantOf != nil {
		t.Error("a variantOf link to an item missing from the target library is dropped")
	}
}

func TestImportRejectsBadArchives(t *testing.T) {
	e := newEnv(t)
	_, err := e.app.PreviewImport(e.ctx, []byte("not a zip"))
	wantCode(t, err, app.CodeValidation)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("bundle.json")
	w.Write([]byte(`{"format":"codeatrophy.bundle","formatVersion":1}`))
	w, _ = zw.Create("../escape")
	w.Write([]byte("x"))
	zw.Close()
	_, err = e.app.Import(e.ctx, buf.Bytes(), "")
	wantCode(t, err, app.CodeValidation)
	big := bytes.Repeat([]byte{0}, 11<<20)
	_, err = e.app.PreviewImport(e.ctx, big)
	wantCode(t, err, app.CodeTooLarge)
}
