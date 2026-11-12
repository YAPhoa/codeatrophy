package app_test

// Regression tests for bundle import problems reported by an independent
// review.

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

// rewriteZip returns a copy of the bundle zip with fn applied to every file.
func rewriteZip(t *testing.T, data []byte, fn func(name string, b []byte) []byte) []byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		w, _ := zw.Create(f.Name)
		w.Write(fn(f.Name, b))
	}
	zw.Close()
	return buf.Bytes()
}

func mkzip(files map[string]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for n, c := range files {
		w, _ := zw.Create(n)
		w.Write([]byte(c))
	}
	zw.Close()
	return buf.Bytes()
}

func ptrString(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// A variantOf link dropped on import (its target is in neither the bundle
// nor the library) does not make the item "changed" forever.
func TestReviewDroppedVariantLinkIsIdempotent(t *testing.T) {
	src := newEnv(t)
	_, _, _, _, v := src.library(t)
	data := src.export(t, `{"scope":"items","itemIds":["`+v.ID+`"]}`)
	dst := newEnv(t)
	must(dst.app.Import(dst.ctx, data, ""))
	before := must(dst.app.GetItem(dst.ctx, v.ID))
	if before.VariantOf != nil {
		t.Fatalf("a link to a missing item is dropped: %v", ptrString(before.VariantOf))
	}
	pre := must(dst.app.PreviewImport(dst.ctx, data))
	if pre.Counts.Unchanged != 1 {
		t.Errorf("re-importing the same bundle should be unchanged, got %+v %v", pre.Counts, pre.Items[0].Changes)
	}
	must(dst.app.Import(dst.ctx, data, "overwrite"))
	if after := must(dst.app.GetItem(dst.ctx, v.ID)); after.Revision != before.Revision {
		t.Errorf("revision %d -> %d on an identical re-import", before.Revision, after.Revision)
	}
	if res := must(dst.app.Import(dst.ctx, data, "duplicate")); res.Created != 0 {
		t.Errorf("duplicate re-import of unchanged content: %+v", res)
	}
}

// An overwrite that changes only test cases leaves the revision alone but
// moves updatedAt.
func TestReviewOverwriteTestsOnlyKeepsRevision(t *testing.T) {
	src := newEnv(t)
	p := src.problem(t, "")
	clock := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	dst := newEnv(t, func(o *app.Options) { o.Now = func() time.Time { return clock } })
	must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"all"}`), ""))
	before := must(dst.app.GetItem(dst.ctx, p.ID))
	must(src.app.BulkTestCases(src.ctx, p.ID, decodeInto[app.BulkTestCasesInput](t, `{"cases":[{"stdin":"9 9","expectedStdout":"18"}]}`)))
	data := src.export(t, `{"scope":"all"}`)
	pre := must(dst.app.PreviewImport(dst.ctx, data))
	if fmt.Sprint(pre.Items[0].Changes) != "[testCases]" {
		t.Errorf("changes: %v", pre.Items[0].Changes)
	}
	clock = clock.Add(time.Minute)
	must(dst.app.Import(dst.ctx, data, "overwrite"))
	after := must(dst.app.GetItem(dst.ctx, p.ID))
	if after.Revision != before.Revision {
		t.Errorf("only test cases changed, but revision %d -> %d", before.Revision, after.Revision)
	}
	if !after.UpdatedAt.After(before.UpdatedAt) {
		t.Errorf("updatedAt did not move: %v -> %v", before.UpdatedAt, after.UpdatedAt)
	}
	if n := len(must(dst.app.ListTestCases(dst.ctx, p.ID)).Items); n != 3 {
		t.Errorf("%d test cases after the overwrite", n)
	}
}

// A type difference is reported first in changes.
func TestReviewTypeChangeInChanges(t *testing.T) {
	src := newEnv(t)
	_, _, _, r, _ := src.library(t)
	data := src.export(t, `{"scope":"items","itemIds":["`+r.ID+`"]}`)
	dst := newEnv(t)
	must(dst.app.Import(dst.ctx, data, ""))
	changed := rewriteZip(t, data, func(name string, b []byte) []byte {
		if strings.HasSuffix(name, ".json") {
			return bytes.ReplaceAll(b, []byte(`"type": "reading"`), []byte(`"type": "problem"`))
		}
		return b
	})
	pre := must(dst.app.PreviewImport(dst.ctx, changed))
	if pre.Items[0].State != "changed" || len(pre.Items[0].Changes) == 0 || pre.Items[0].Changes[0] != "type" {
		t.Errorf("changes should start with type: %s %v", pre.Items[0].State, pre.Items[0].Changes)
	}
}

const (
	idA = "00000000-0000-4000-8000-00000000000a"
	idB = "00000000-0000-4000-8000-00000000000b"
	idC = "00000000-0000-4000-8000-00000000000c"
)

// A collection whose ancestor chain leads into a cycle (but is not itself
// in it) keeps its parent; the cycle is cut at its closing edge.
func TestReviewCycleBreakKeepsBystander(t *testing.T) {
	e := newEnv(t)
	manifest := `{"format":"codeatrophy.bundle","formatVersion":1,"items":[],"collections":[
	 {"id":"` + idC + `","name":"C","parentId":"` + idA + `","itemIds":[]},
	 {"id":"` + idA + `","name":"A","parentId":"` + idB + `","itemIds":[]},
	 {"id":"` + idB + `","name":"B","parentId":"` + idA + `","itemIds":[]}]}`
	data := mkzip(map[string]string{"bundle.json": manifest})
	pre := must(e.app.PreviewImport(e.ctx, data))
	if !strings.Contains(strings.Join(pre.Warnings, "\n"), "cycle") {
		t.Errorf("the cycle is reported: %v", pre.Warnings)
	}
	must(e.app.Import(e.ctx, data, ""))
	c := must(e.app.GetCollection(e.ctx, idC))
	a := must(e.app.GetCollection(e.ctx, idA))
	b := must(e.app.GetCollection(e.ctx, idB))
	if ptrString(c.ParentID) != idA {
		t.Errorf("C is not part of the cycle and should stay under A, got %s", ptrString(c.ParentID))
	}
	if (a.ParentID == nil) == (b.ParentID == nil) {
		t.Errorf("exactly one edge of the cycle is cut: A.parent=%s B.parent=%s", ptrString(a.ParentID), ptrString(b.ParentID))
	}
}

func manyCollections(n int, chain bool) []byte {
	var sb strings.Builder
	sb.WriteString(`{"format":"codeatrophy.bundle","formatVersion":1,"items":[],"collections":[`)
	for i := 0; i < n; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		parent := "null"
		if chain && i > 0 {
			parent = fmt.Sprintf(`"00000000-0000-4000-8000-%012x"`, i-1)
		}
		fmt.Fprintf(&sb, `{"id":"00000000-0000-4000-8000-%012x","name":"c%d","parentId":%s,"position":%d,"itemIds":[]}`, i, i, parent, i)
	}
	sb.WriteString(`]}`)
	return mkzip(map[string]string{"bundle.json": sb.String()})
}

// Collection handling is linear: the largest allowed number of collections,
// flat or as one deep chain, previews and imports quickly; one more is
// refused with a limit error.
func TestReviewManyCollectionsCost(t *testing.T) {
	for _, chain := range []bool{false, true} {
		e := newEnv(t)
		data := manyCollections(domain.MaxBundleCollections, chain)
		start := time.Now()
		must(e.app.PreviewImport(e.ctx, data))
		res := must(e.app.Import(e.ctx, data, ""))
		if d := time.Since(start); d > 20*time.Second {
			t.Errorf("chain=%v: %d collections took %s", chain, domain.MaxBundleCollections, d)
		}
		if res.CollectionsCreated != domain.MaxBundleCollections {
			t.Errorf("chain=%v: %+v", chain, res)
		}
	}
	e := newEnv(t)
	_, err := e.app.PreviewImport(e.ctx, manyCollections(domain.MaxBundleCollections+1, false))
	if err == nil || !strings.Contains(err.Error(), "collections") {
		t.Errorf("too many collections: %v", err)
	}
}

// A whole-library export of a modest library can be imported back.
func TestReviewOwnExportFitsImportLimits(t *testing.T) {
	src := newEnv(t)
	var cases strings.Builder
	cases.WriteString(`{"cases":[`)
	for i := 0; i < 1000; i++ {
		if i > 0 {
			cases.WriteByte(',')
		}
		fmt.Fprintf(&cases, `{"stdin":"%d","expectedStdout":"%d"}`, i, i)
	}
	cases.WriteString(`]}`)
	for i := 0; i < 10; i++ {
		p := must(src.app.CreateItem(src.ctx, input(t, fmt.Sprintf(`{"type":"problem","title":"P%d"}`, i))))
		must(src.app.BulkTestCases(src.ctx, p.ID, decodeInto[app.BulkTestCasesInput](t, cases.String())))
	}
	data := src.export(t, `{"scope":"all"}`)
	dst := newEnv(t)
	if _, err := dst.app.PreviewImport(dst.ctx, data); err != nil {
		t.Errorf("own export rejected: %v", err)
	}
}

// A test file that is not valid UTF-8 is skipped with a warning instead of
// being imported (and hashed) as replacement characters.
func TestReviewInvalidUTF8TestFileIsSkipped(t *testing.T) {
	mk := func(in string) []byte {
		id := "00000000-0000-4000-8000-0000000000d1"
		return mkzip(map[string]string{
			"bundle.json":              `{"format":"codeatrophy.bundle","formatVersion":1,"items":[{"id":"` + id + `","path":"items/x"}],"collections":[]}`,
			"items/x/item.json":        `{"id":"` + id + `","type":"problem","title":"X"}`,
			"items/x/body.md":          "b",
			"items/x/tests/tests.json": `{"cases":[{"input":"1.in","output":"1.out","sample":true},{"input":"2.in","output":"2.out","sample":true}]}`,
			"items/x/tests/1.in":       in,
			"items/x/tests/1.out":      "o",
			"items/x/tests/2.in":       "ok",
			"items/x/tests/2.out":      "o",
		})
	}
	e := newEnv(t)
	pre := must(e.app.PreviewImport(e.ctx, mk("\xff")))
	if !strings.Contains(strings.Join(pre.Warnings, "\n"), "UTF-8") || pre.Items[0].TestCaseCount != 1 {
		t.Errorf("invalid test file: %d cases, warnings %v", pre.Items[0].TestCaseCount, pre.Warnings)
	}
	res := must(e.app.Import(e.ctx, mk("\xff"), ""))
	cases := must(e.app.ListTestCases(e.ctx, "00000000-0000-4000-8000-0000000000d1")).Items
	if res.Created != 1 || len(cases) != 1 || cases[0].Stdin != "ok" {
		t.Errorf("imported %+v with cases %+v", res, cases)
	}
}

// Under "duplicate", a bundle variant whose original was duplicated in the
// same import points at the new copy.
func TestReviewDuplicateVariantTarget(t *testing.T) {
	src := newEnv(t)
	_, _, p, _, v := src.library(t)
	dst := newEnv(t)
	must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"items","itemIds":["`+p.ID+`"]}`), ""))
	must(dst.app.UpdateItem(dst.ctx, p.ID, input(t, `{"title":"Local"}`)))
	res := must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"items","itemIds":["`+p.ID+`","`+v.ID+`"]}`), "duplicate"))
	if res.Created != 1 || res.Duplicated != 1 {
		t.Fatalf("import: %+v", res)
	}
	gv := must(dst.app.GetItem(dst.ctx, v.ID))
	if gv.VariantOf == nil || *gv.VariantOf == p.ID {
		t.Fatalf("variantOf=%s should name the imported copy, not the local %s", ptrString(gv.VariantOf), p.ID)
	}
	if orig := must(dst.app.GetItem(dst.ctx, *gv.VariantOf)); orig.Title != "Knapsack" {
		t.Errorf("variantOf points at %q", orig.Title)
	}
}
