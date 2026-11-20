package bundle

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/domain"
)

var lim = DefaultLimits(10<<20, 64<<10)

func sampleBundle() *Bundle {
	d := domain.DifficultyEasy
	url := "https://example.com/two-sum"
	parent := "0193b2f1-0000-7000-8000-000000000001"
	return &Bundle{
		Meta: Meta{Name: "DP plan", Author: "me", CreatedAt: time.Date(2026, 1, 31, 12, 0, 0, 0, time.UTC),
			GeneratorName: "codeatrophy", GeneratorVersion: "test", Includes: &Includes{Solutions: true, HiddenTests: true}},
		Items: []Item{
			{
				ID: "0193b2f0-0000-7000-8000-000000000001", Type: domain.TypeProblem, Title: "Two Sum",
				Summary: "Find two indices.", Difficulty: &d, Tags: []string{"array", "hash-map"},
				Source: domain.Source{URL: &url}, Body: "## Problem\n\n<b>&</b> \u2028 tab\t\"quoted\"",
				CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
				Problem: &Problem{TimeLimitMs: 2000, MemoryLimitKb: 262144, Compare: domain.CompareTokens,
					StarterCode: map[string]string{"python": "import sys\n", "cpp": "#include <iostream>\n"}},
				Solutions: []Solution{
					{Name: "Hash map, one pass", Language: "python", Source: "print(0, 1)\n", Notes: "O(n)", IsReference: true},
					{Name: "Brute force", Language: "cpp", Source: "int main() {}\n"},
				},
				SolutionsIncluded: true, HiddenTestsIncluded: true,
				TestCases: []TestCase{
					{Name: "Example 1", Stdin: "4\n2 7 11 15\n9\n", ExpectedStdout: "0 1\n", IsSample: true, Origin: domain.OriginManual, Verified: true},
					{Name: "hidden", Stdin: "2\n1 2\n3\r\n", ExpectedStdout: "0 1", IsSample: false, Origin: domain.OriginAI},
				},
			},
			{
				ID: "0193b2f4-0000-7000-8000-000000000002", Type: domain.TypeReading, Title: "CAP theorem notes",
				Tags: []string{}, Body: "# CAP\n",
			},
		},
		Collections: []Collection{
			{ID: parent, Name: "Dynamic Programming", ItemIDs: []string{"0193b2f0-0000-7000-8000-000000000001"}},
			{ID: "0193b2f1-0000-7000-8000-000000000002", Name: "Child", ParentID: &parent, Position: 0,
				ItemIDs: []string{"0193b2f4-0000-7000-8000-000000000002", "0193b2f0-0000-7000-8000-000000000001"}},
		},
	}
}

func write(t *testing.T, b *Bundle) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := Write(&buf, b); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestRoundTrip(t *testing.T) {
	src := sampleBundle()
	data := write(t, src)
	got, warnings, err := Read(data, lim)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Errorf("unexpected warnings: %v", warnings)
	}
	if got.Meta.Name != "DP plan" || got.Meta.FormatVersion != 1 || got.Meta.Author != "me" {
		t.Errorf("meta: %+v", got.Meta)
	}
	if len(got.Items) != 2 || len(got.Collections) != 2 {
		t.Fatalf("got %d items, %d collections", len(got.Items), len(got.Collections))
	}
	for i := range src.Items {
		if a, b := ContentHash(&src.Items[i]), ContentHash(&got.Items[i]); a != b {
			t.Errorf("item %d: hash changed across round trip: %s vs %s", i, a, b)
		}
	}
	p := got.Items[0]
	if p.TestCases[1].Stdin != "2\n1 2\n3\r\n" || p.TestCases[1].ExpectedStdout != "0 1" {
		t.Error("test bytes must be kept exactly")
	}
	if p.TestCases[1].Origin != domain.OriginAI || !p.TestCases[0].Verified {
		t.Error("origin and verified must be kept")
	}
	if p.Problem.StarterCode["cpp"] != "#include <iostream>\n" || !p.HasSolutions() || len(p.Solutions) != 2 ||
		p.Solutions[0] != src.Items[0].Solutions[0] || p.Solutions[1] != src.Items[0].Solutions[1] {
		t.Errorf("source files not read back: %+v", p.Solutions)
	}
	if !p.HasHiddenTests() || got.Meta.Includes == nil || !got.Meta.Includes.Solutions || !got.Meta.Includes.HiddenTests {
		t.Errorf("includes: %+v", got.Meta.Includes)
	}
	if *got.Collections[1].ParentID != src.Collections[0].ID || len(got.Collections[1].ItemIDs) != 2 {
		t.Errorf("collections: %+v", got.Collections)
	}
}

func TestLayoutIsHumanReadable(t *testing.T) {
	data := write(t, sampleBundle())
	zr, _ := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	for _, want := range []string{
		"bundle.json",
		"items/two-sum-0193b2f0/item.json",
		"items/two-sum-0193b2f0/body.md",
		"items/two-sum-0193b2f0/starter/python.py",
		"items/two-sum-0193b2f0/starter/cpp.cpp",
		"items/two-sum-0193b2f0/solutions/solutions.json",
		"items/two-sum-0193b2f0/solutions/01-hash-map-one-pass.py",
		"items/two-sum-0193b2f0/solutions/02-brute-force.cpp",
		"items/two-sum-0193b2f0/tests/tests.json",
		"items/two-sum-0193b2f0/tests/01.in",
		"items/two-sum-0193b2f0/tests/02.out",
		"items/cap-theorem-notes-0193b2f4/item.json",
	} {
		if !names[want] {
			t.Errorf("missing %s (have %v)", want, names)
		}
	}
	if names["items/cap-theorem-notes-0193b2f4/tests/tests.json"] {
		t.Error("readings have no tests")
	}
}

func TestContentHashIsCanonical(t *testing.T) {
	a := sampleBundle().Items[0]
	b := sampleBundle().Items[0]
	b.Tags = []string{"hash-map", "array"} // order does not matter
	b.CreatedAt = time.Now()               // timestamps are excluded
	b.TestCases[0].Origin = domain.OriginImport
	b.TestCases[0].Verified = false
	if ContentHash(&a) != ContentHash(&b) {
		t.Error("hash must ignore tag order, timestamps, origin and verified")
	}
	b.Body += "x"
	if ContentHash(&a) == ContentHash(&b) {
		t.Error("hash must change with the body")
	}
	if !strings.HasPrefix(ContentHash(&a), "sha256:") || len(ContentHash(&a)) != len("sha256:")+64 {
		t.Errorf("format: %s", ContentHash(&a))
	}
}

func TestCanonicalJSON(t *testing.T) {
	got := string(Canonical(map[string]any{
		"b": []any{int64(1), true, nil}, "a": "x\"\\\n\u0001<&>é\u2028",
	}))
	want := `{"a":"x\"\\\n\u0001<&>é` + "\u2028" + `","b":[1,true,null]}`
	if got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
}

func TestStoredHashMismatchWarns(t *testing.T) {
	data := write(t, sampleBundle())
	data = rewrite(t, data, "items/two-sum-0193b2f0/body.md", []byte("edited by hand"))
	got, warnings, err := Read(data, lim)
	if err != nil {
		t.Fatal(err)
	}
	if got.Items[0].Body != "edited by hand" {
		t.Error("files must win over the stored hash")
	}
	if !containsWarning(warnings, "content hash") {
		t.Errorf("expected a hash warning, got %v", warnings)
	}
}

func containsWarning(ws []string, sub string) bool {
	for _, w := range ws {
		if strings.Contains(w, sub) {
			return true
		}
	}
	return false
}

// rewrite returns a copy of the archive with one file replaced (or added).
func rewrite(t *testing.T, data []byte, name string, content []byte) []byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	done := false
	for _, f := range zr.File {
		w, _ := zw.Create(f.Name)
		if f.Name == name {
			w.Write(content)
			done = true
			continue
		}
		rc, _ := f.Open()
		var b bytes.Buffer
		b.ReadFrom(rc)
		rc.Close()
		w.Write(b.Bytes())
	}
	if !done {
		w, _ := zw.Create(name)
		w.Write(content)
	}
	zw.Close()
	return buf.Bytes()
}

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
	}
	zw.Close()
	return buf.Bytes()
}

const minimalManifest = `{"format":"codeatrophy.bundle","formatVersion":1,"name":"x","items":[],"collections":[]}`

func TestRejectsPathTraversal(t *testing.T) {
	for _, bad := range []string{"../evil.txt", "items/../../etc/passwd", "/abs/path", `..\windows.txt`, `C:\x.txt`, "a/b/../../../c"} {
		data := zipOf(t, map[string]string{"bundle.json": minimalManifest, bad: "x"})
		_, _, err := Read(data, lim)
		if !IsFormatError(err) {
			t.Errorf("%q: got %v, want a format error", bad, err)
		}
	}
	// A manifest item path that escapes is skipped with a warning.
	manifest := `{"format":"codeatrophy.bundle","formatVersion":1,"items":[{"id":"0193b2f0-0000-7000-8000-000000000001","path":"../outside"}]}`
	b, warnings, err := Read(zipOf(t, map[string]string{"bundle.json": manifest}), lim)
	if err != nil || len(b.Items) != 0 || !containsWarning(warnings, "invalid path") {
		t.Errorf("got %v, %v, %v", b, warnings, err)
	}
}

func TestSizeLimits(t *testing.T) {
	small := Limits{MaxCompressedBytes: 1 << 20, MaxUncompressedBytes: 4 << 10, MaxEntries: 5}
	big := zipOf(t, map[string]string{"bundle.json": minimalManifest, "pad.txt": strings.Repeat("a", 8<<10)})
	if _, _, err := Read(big, small); !IsLimitError(err) {
		t.Errorf("uncompressed limit: got %v", err)
	}
	files := map[string]string{"bundle.json": minimalManifest}
	for i := range 6 {
		files["f"+string(rune('a'+i))] = "x"
	}
	if _, _, err := Read(zipOf(t, files), small); !IsLimitError(err) {
		t.Errorf("entry limit: got %v", err)
	}
	compressed := Limits{MaxCompressedBytes: 100, MaxUncompressedBytes: 1 << 20, MaxEntries: 10}
	if _, _, err := Read(big, compressed); !IsLimitError(err) {
		t.Errorf("compressed limit: got %v", err)
	}
}

func TestRejectsInvalidBundles(t *testing.T) {
	cases := map[string][]byte{
		"not a zip":     []byte("hello"),
		"no manifest":   zipOf(t, map[string]string{"readme.md": "x"}),
		"bad json":      zipOf(t, map[string]string{"bundle.json": "{"}),
		"wrong format":  zipOf(t, map[string]string{"bundle.json": `{"format":"other","formatVersion":1}`}),
		"newer version": zipOf(t, map[string]string{"bundle.json": fmt.Sprintf(`{"format":"codeatrophy.bundle","formatVersion":%d}`, FormatVersion+1)}),
		"version 0":     zipOf(t, map[string]string{"bundle.json": `{"format":"codeatrophy.bundle","formatVersion":0}`}),
		"version -1":    zipOf(t, map[string]string{"bundle.json": `{"format":"codeatrophy.bundle","formatVersion":-1}`}),
		"no version":    zipOf(t, map[string]string{"bundle.json": `{"format":"codeatrophy.bundle"}`}),
	}
	for name, data := range cases {
		if _, _, err := Read(data, lim); !IsFormatError(err) {
			t.Errorf("%s: got %v, want a format error", name, err)
		}
	}
}

func TestToleratesSingleTopLevelDirectory(t *testing.T) {
	data := write(t, sampleBundle())
	zr, _ := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	files := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		var b bytes.Buffer
		b.ReadFrom(rc)
		rc.Close()
		files["my-bundle-main/"+f.Name] = b.String()
	}
	got, _, err := Read(zipOf(t, files), lim)
	if err != nil || len(got.Items) != 2 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestItemLevelProblemsAreWarnings(t *testing.T) {
	data := write(t, sampleBundle())
	var ij map[string]any
	zr, _ := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	for _, f := range zr.File {
		if f.Name == "items/two-sum-0193b2f0/item.json" {
			rc, _ := f.Open()
			json.NewDecoder(rc).Decode(&ij)
			rc.Close()
		}
	}
	p := ij["problem"].(map[string]any)
	p["starter"].(map[string]any)["brainfuck"] = "starter/bf.b"
	p["timeLimitMs"] = 5
	ij["difficulty"] = "impossible"
	b, _ := json.Marshal(ij)
	data = rewrite(t, data, "items/two-sum-0193b2f0/item.json", b)
	data = rewrite(t, data, "items/cap-theorem-notes-0193b2f4/item.json", []byte("{not json"))
	got, warnings, err := Read(data, lim)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != 1 {
		t.Fatalf("the malformed item should be skipped, got %d items", len(got.Items))
	}
	it := got.Items[0]
	if _, ok := it.Problem.StarterCode["brainfuck"]; ok || it.Problem.TimeLimitMs != domain.DefaultTimeLimitMs || it.Difficulty != nil {
		t.Errorf("invalid fields should be dropped: %+v", it.Problem)
	}
	for _, w := range []string{`unknown language "brainfuck"`, "timeLimitMs", "difficulty", "malformed"} {
		if !containsWarning(warnings, w) {
			t.Errorf("missing warning %q in %v", w, warnings)
		}
	}
	// The collection referring to the skipped item drops it.
	for _, c := range got.Collections {
		for _, id := range c.ItemIDs {
			if id == "0193b2f4-0000-7000-8000-000000000002" {
				t.Error("collection still lists the skipped item")
			}
		}
	}
}

func TestPartialExportCarriesNoSolutionOrHiddenTests(t *testing.T) {
	it := domain.Item{ItemSummary: domain.ItemSummary{ID: "0193b2f0-0000-7000-8000-000000000009", Type: domain.TypeProblem, Title: "P"},
		Problem: &domain.ProblemSpec{TimeLimitMs: 1000, MemoryLimitKb: 65536, Compare: domain.CompareTokens,
			StarterCode: map[string]string{}}}
	sols := []domain.ItemSolution{{Name: "Reference solution", Language: "python", Source: "x", IsReference: true}}
	cases := []domain.TestCase{{Name: "s", IsSample: true, Stdin: "1", ExpectedStdout: "1"}, {Name: "h", Stdin: "2", ExpectedStdout: "2"}}
	full := FromDomain(it, cases, sols, true, true)
	partial := FromDomain(it, cases, sols, false, false)
	if !full.HasSolutions() || len(full.Solutions) != 1 || !full.HasHiddenTests() {
		t.Error("full export should carry the solutions and hidden tests")
	}
	if partial.HasSolutions() || partial.HasHiddenTests() || len(partial.TestCases) != 1 {
		t.Error("partial export should carry neither")
	}
	if ContentHash(&full) == ContentHash(&partial) {
		t.Error("the hash describes what is in the bundle")
	}
	b := &Bundle{Meta: Meta{Name: "p"}, Items: []Item{partial}, Collections: []Collection{}}
	got, _, err := Read(write(t, b), lim)
	if err != nil {
		t.Fatal(err)
	}
	if got.Items[0].HasSolutions() || got.Items[0].HasHiddenTests() || len(got.Items[0].TestCases) != 1 {
		t.Error("partial bundle round trip")
	}
}

func TestSlug(t *testing.T) {
	for in, want := range map[string]string{"Two Sum": "two-sum", "  C++ / Go!! ": "c-go", "日本": "item",
		strings.Repeat("ab ", 30): "ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab"} {
		if got := Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
	}
}

// includes in bundle.json says what was exported; without it, a reader
// infers it from the files.
func TestIncludesDecideWhatWasExported(t *testing.T) {
	// Content that includes says was left out is ignored, with a warning,
	// and the hash covers only what is kept.
	data := rewriteJSON(t, write(t, sampleBundle()), "bundle.json", func(m map[string]any) {
		m["includes"] = map[string]any{"solutions": false, "hiddenTests": false}
	})
	got, warnings, err := Read(data, lim)
	if err != nil {
		t.Fatal(err)
	}
	p := got.Items[0]
	if p.HasSolutions() || p.Solutions != nil || p.HasHiddenTests() || len(p.TestCases) != 1 || p.TestCases[0].Name != "Example 1" {
		t.Errorf("left-out content kept: %+v", p)
	}
	for _, w := range []string{"two-sum-0193b2f0: solutions in a bundle exported without them; ignored",
		"two-sum-0193b2f0: hidden test cases in a bundle exported without them; ignored"} {
		if !containsWarning(warnings, w) {
			t.Errorf("missing warning %q in %v", w, warnings)
		}
	}
	kept := sampleBundle().Items[0]
	kept.SolutionsIncluded, kept.Solutions, kept.HiddenTestsIncluded, kept.TestCases = false, nil, false, kept.TestCases[:1]
	if ContentHash(&p) != ContentHash(&kept) {
		t.Error("the hash still covers the ignored content")
	}
	// An empty solutions list is not the same as solutions left out.
	b := sampleBundle()
	b.Items[0].Solutions = []Solution{}
	got, _, _ = Read(write(t, b), lim)
	if p := got.Items[0]; !p.HasSolutions() || len(p.Solutions) != 0 {
		t.Errorf("exported with no solutions: %+v", p)
	}
	if ContentHash(&b.Items[0]) == ContentHash(&sampleBundle().Items[0]) {
		t.Error("solutions are part of the hash")
	}
	// Without includes (an older writer), the files decide.
	data = write(t, sampleBundle())
	data = rewriteJSON(t, data, "bundle.json", func(m map[string]any) { delete(m, "includes") })
	data = drop(t, data, "items/two-sum-0193b2f0/solutions/")
	got, _, _ = Read(data, lim)
	if p := got.Items[0]; p.HasSolutions() || !p.HasHiddenTests() {
		t.Errorf("inferred: solutions %v hidden %v", p.HasSolutions(), p.HasHiddenTests())
	}
	// Two references: the first one wins, with a warning.
	b = sampleBundle()
	b.Items[0].Solutions[1].IsReference = true
	got, warnings, _ = Read(write(t, b), lim)
	if !got.Items[0].Solutions[0].IsReference || got.Items[0].Solutions[1].IsReference || !containsWarning(warnings, "more than one reference") {
		t.Errorf("two references: %+v %v", got.Items[0].Solutions, warnings)
	}
}

// Problems with one item's files are reported with what is wrong; test
// files that are not UTF-8 are skipped.
func TestItemFileProblemsSaySpecifically(t *testing.T) {
	data := write(t, sampleBundle())
	data = rewrite(t, data, "items/two-sum-0193b2f0/tests/02.in", []byte("\xff\xfe"))
	data = drop(t, data, "items/two-sum-0193b2f0/tests/01.out")
	got, warnings, err := Read(data, lim)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Items[0].TestCases) != 0 {
		t.Errorf("unreadable cases should be skipped: %+v", got.Items[0].TestCases)
	}
	for _, w := range []string{"UTF-8", "missing"} {
		if !containsWarning(warnings, w) {
			t.Errorf("missing warning %q in %v", w, warnings)
		}
	}
	// A malformed tests.json or solutions.json skips the item rather than
	// importing it as having none.
	for _, f := range []string{"items/two-sum-0193b2f0/tests/tests.json", "items/two-sum-0193b2f0/solutions/solutions.json"} {
		got, warnings, err := Read(rewrite(t, write(t, sampleBundle()), f, []byte(`{"cases":"many","solutions":7}`)), lim)
		if err != nil || len(got.Items) != 1 || got.Items[0].Type != domain.TypeReading || !containsWarning(warnings, "item skipped") {
			t.Errorf("%s malformed: %d items, %v, %v", f, len(got.Items), warnings, err)
		}
	}
	b := sampleBundle()
	b.Items[1].Title = "two\u2028lines"
	got, warnings, _ = Read(write(t, b), lim)
	if len(got.Items) != 1 || !containsWarning(warnings, "single line") {
		t.Errorf("multi-line title: %d items, %v", len(got.Items), warnings)
	}
	data = rewrite(t, write(t, sampleBundle()), "bundle.json", []byte(`{"format":"codeatrophy.bundle","formatVersion":"one"}`))
	if _, _, err := Read(data, lim); err == nil || !strings.Contains(err.Error(), "formatVersion") {
		t.Errorf("a wrongly typed field is named: %v", err)
	}
}

func rewriteJSON(t *testing.T, data []byte, name string, fn func(map[string]any)) []byte {
	t.Helper()
	zr, _ := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	for _, f := range zr.File {
		if f.Name == name {
			rc, _ := f.Open()
			var m map[string]any
			json.NewDecoder(rc).Decode(&m)
			rc.Close()
			fn(m)
			b, _ := json.Marshal(m)
			return rewrite(t, data, name, b)
		}
	}
	t.Fatalf("%s not found", name)
	return nil
}

// drop removes the files whose names start with prefix.
func drop(t *testing.T, data []byte, prefix string) []byte {
	t.Helper()
	zr, _ := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, prefix) {
			continue
		}
		rc, _ := f.Open()
		w, _ := zw.Create(f.Name)
		io.Copy(w, rc)
		rc.Close()
	}
	zw.Close()
	return buf.Bytes()
}

// Problems in bundle.json or in one item.json are warnings that say what
// was wrong and skip as little as possible.
func TestReaderWarnings(t *testing.T) {
	const (
		two    = "0193b2f0-0000-7000-8000-000000000001"
		reader = "0193b2f4-0000-7000-8000-000000000002"
		parent = "0193b2f1-0000-7000-8000-000000000001"
		child  = "0193b2f1-0000-7000-8000-000000000002"
		other  = "0193b2f1-0000-7000-8000-00000000dead"
	)
	capItem := "items/cap-theorem-notes-0193b2f4/item.json"
	manifest := func(fn func(m map[string]any)) func(*testing.T, []byte) []byte {
		return func(t *testing.T, data []byte) []byte { return rewriteJSON(t, data, "bundle.json", fn) }
	}
	capJSON := func(fn func(m map[string]any)) func(*testing.T, []byte) []byte {
		return func(t *testing.T, data []byte) []byte { return rewriteJSON(t, data, capItem, fn) }
	}
	entry := func(m map[string]any, key string, i int) map[string]any { return m[key].([]any)[i].(map[string]any) }
	itemIDs := func(b *Bundle) string {
		var ids []string
		for _, it := range b.Items {
			ids = append(ids, it.ID)
		}
		return strings.Join(ids, ",")
	}
	coll := func(b *Bundle, id string) *Collection {
		for i := range b.Collections {
			if b.Collections[i].ID == id {
				return &b.Collections[i]
			}
		}
		return nil
	}
	parentOf := func(b *Bundle, id string) string {
		if c := coll(b, id); c != nil && c.ParentID != nil {
			return *c.ParentID
		}
		return ""
	}
	onlyTwoSum := func(t *testing.T, b *Bundle) {
		if itemIDs(b) != two {
			t.Errorf("items %s, want only %s", itemIDs(b), two)
		}
		if c := coll(b, child); c == nil || strings.Join(c.ItemIDs, ",") != two {
			t.Errorf("the skipped item is still a member: %+v", c)
		}
	}
	cases := []struct {
		name    string
		edit    func(*testing.T, []byte) []byte
		warning string
		check   func(*testing.T, *Bundle)
	}{
		{"invalid item id", manifest(func(m map[string]any) { entry(m, "items", 1)["id"] = "not-a-uuid" }),
			`bundle.json: item "CAP theorem notes" has an invalid id; skipped`, onlyTwoSum},
		{"duplicate item id", manifest(func(m map[string]any) {
			dup := map[string]any{"id": strings.ToUpper(two), "path": "items/cap-theorem-notes-0193b2f4"}
			m["items"] = append(m["items"].([]any), dup)
		}), "bundle.json: duplicate item id " + two + "; skipped", func(t *testing.T, b *Bundle) {
			if itemIDs(b) != two+","+reader || b.Items[0].Title != "Two Sum" {
				t.Errorf("items %s", itemIDs(b))
			}
		}},
		{"item.json missing", func(t *testing.T, data []byte) []byte { return drop(t, data, capItem) },
			"items/cap-theorem-notes-0193b2f4/item.json: missing; item skipped", onlyTwoSum},
		{"item.json id mismatch", capJSON(func(m map[string]any) { m["id"] = "0193b2f4-0000-7000-8000-000000000099" }),
			"items/cap-theorem-notes-0193b2f4/item.json: id does not match bundle.json; item skipped", onlyTwoSum},
		{"unknown type", capJSON(func(m map[string]any) { m["type"] = "video" }),
			`items/cap-theorem-notes-0193b2f4/item.json: unknown type "video"; item skipped`, onlyTwoSum},
		{"missing title", capJSON(func(m map[string]any) { delete(m, "title") }),
			"items/cap-theorem-notes-0193b2f4/item.json: title must be 1-200 characters; item skipped", onlyTwoSum},
		{"blank title", capJSON(func(m map[string]any) { m["title"] = " \t " }),
			"item.json: title must be 1-200 characters; item skipped", onlyTwoSum},
		{"title too long", capJSON(func(m map[string]any) { m["title"] = strings.Repeat("é", domain.MaxTitleChars+1) }),
			"item.json: title must be 1-200 characters; item skipped", onlyTwoSum},
		{"invalid collection id", manifest(func(m map[string]any) { entry(m, "collections", 0)["id"] = "nope" }),
			`bundle.json: collection "Dynamic Programming" has an invalid id; skipped`, func(t *testing.T, b *Bundle) {
				if len(b.Collections) != 1 || b.Collections[0].ID != child || b.Collections[0].ParentID != nil {
					t.Errorf("collections %+v; want the child alone, at the top level", b.Collections)
				}
			}},
		{"duplicate collection id", manifest(func(m map[string]any) {
			m["collections"] = append(m["collections"].([]any), map[string]any{"id": strings.ToUpper(child), "name": "Copy", "itemIds": []any{}})
		}), "bundle.json: duplicate collection id " + child + "; skipped", func(t *testing.T, b *Bundle) {
			if len(b.Collections) != 2 || coll(b, child).Name != "Child" {
				t.Errorf("collections %+v", b.Collections)
			}
		}},
		{"parent not in the bundle", manifest(func(m map[string]any) { entry(m, "collections", 1)["parentId"] = other }),
			"bundle.json: collection " + child + " refers to a parent that is not in the bundle; placed at the top level",
			func(t *testing.T, b *Bundle) {
				if p := parentOf(b, child); p != "" {
					t.Errorf("parent %s, want none", p)
				}
			}},
		{"own parent", manifest(func(m map[string]any) { entry(m, "collections", 0)["parentId"] = parent }),
			"bundle.json: collection " + parent + " refers to a parent that is not in the bundle; placed at the top level",
			func(t *testing.T, b *Bundle) {
				if p, c := parentOf(b, parent), parentOf(b, child); p != "" || c != parent {
					t.Errorf("parents %q, %q", p, c)
				}
			}},
		// parent -> child -> parent; a third collection hangs off the cycle.
		{"parent cycle", manifest(func(m map[string]any) {
			entry(m, "collections", 0)["parentId"] = child
			m["collections"] = append(m["collections"].([]any), map[string]any{"id": other, "name": "Leaf", "parentId": parent, "itemIds": []any{}})
		}), "bundle.json: collections " + child + " and " + parent + " form a parent cycle; " + child + " placed at the top level",
			func(t *testing.T, b *Bundle) {
				if p, c, o := parentOf(b, parent), parentOf(b, child), parentOf(b, other); p != child || c != "" || o != parent {
					t.Errorf("parents: %q %q %q; want only the closing edge cut", p, c, o)
				}
			}},
		{"member not in the bundle", manifest(func(m map[string]any) {
			entry(m, "collections", 0)["itemIds"] = []any{two, "0193b2f0-0000-7000-8000-00000000beef", strings.ToUpper(two)}
		}), "bundle.json: collection " + parent + " lists item 0193b2f0-0000-7000-8000-00000000beef, which is not in the bundle; ignored",
			func(t *testing.T, b *Bundle) {
				if ids := strings.Join(coll(b, parent).ItemIDs, ","); ids != two {
					t.Errorf("members %s; want the known item once", ids)
				}
			}},
		{"includes with one key", manifest(func(m map[string]any) { m["includes"] = map[string]any{"solutions": false} }),
			"bundle.json: includes needs both solutions and hiddenTests; ignored", func(t *testing.T, b *Bundle) {
				// Inferred from the files instead.
				if p := b.Items[0]; b.Meta.Includes != nil || !p.HasSolutions() || len(p.Solutions) != 2 || !p.HasHiddenTests() {
					t.Errorf("includes %+v, solutions %v (%d), hidden %v", b.Meta.Includes, p.HasSolutions(), len(p.Solutions), p.HasHiddenTests())
				}
			}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, warnings, err := Read(c.edit(t, write(t, sampleBundle())), lim)
			if err != nil {
				t.Fatal(err)
			}
			if !containsWarning(warnings, c.warning) {
				t.Errorf("missing warning %q in %v", c.warning, warnings)
			}
			c.check(t, b)
		})
	}
}

// Item directories are named after the title and the first 8 hex digits of
// the id; items sharing both get numbered directories and all read back.
func TestItemDirectoriesDoNotCollide(t *testing.T) {
	b := &Bundle{Meta: Meta{Name: "same"}, Items: []Item{
		{ID: "0193b2f0-aaaa-7000-8000-000000000001", Type: domain.TypeReading, Title: "Same title", Body: "first"},
		{ID: "0193b2f0-bbbb-7000-8000-000000000002", Type: domain.TypeReading, Title: "Same title!", Body: "second"},
		{ID: "0193b2f0-cccc-7000-8000-000000000003", Type: domain.TypeReading, Title: "same TITLE", Body: "third"},
	}}
	data := write(t, b)
	for i, want := range []string{"items/same-title-0193b2f0", "items/same-title-0193b2f0-2", "items/same-title-0193b2f0-3"} {
		if b.Items[i].Dir != want {
			t.Errorf("item %d in %s, want %s", i, b.Items[i].Dir, want)
		}
	}
	got, warnings, err := Read(data, lim)
	if err != nil || len(warnings) != 0 || len(got.Items) != 3 {
		t.Fatalf("%v %v %d items", err, warnings, len(got.Items))
	}
	for i, want := range []string{"first", "second", "third"} {
		if got.Items[i].ID != b.Items[i].ID || got.Items[i].Body != want {
			t.Errorf("item %d: %s %q", i, got.Items[i].ID, got.Items[i].Body)
		}
	}
}
