package bundle

import (
	"archive/zip"
	"bytes"
	"encoding/json"
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
		"newer version": zipOf(t, map[string]string{"bundle.json": `{"format":"codeatrophy.bundle","formatVersion":3}`}),
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
	b := sampleBundle()
	b.Meta.Includes = &Includes{Solutions: false, HiddenTests: false}
	it := &b.Items[0]
	it.SolutionsIncluded, it.Solutions, it.HiddenTestsIncluded = false, nil, false
	it.TestCases = it.TestCases[:1]
	got, _, err := Read(write(t, b), lim)
	if err != nil {
		t.Fatal(err)
	}
	if p := got.Items[0]; p.HasSolutions() || p.HasHiddenTests() {
		t.Errorf("declared partial export: %+v", p)
	}
	// An empty solutions list is not the same as solutions left out.
	b = sampleBundle()
	b.Items[0].Solutions = []Solution{}
	got, _, _ = Read(write(t, b), lim)
	if p := got.Items[0]; !p.HasSolutions() || len(p.Solutions) != 0 {
		t.Errorf("exported with no solutions: %+v", p)
	}
	if ContentHash(&b.Items[0]) == ContentHash(&sampleBundle().Items[0]) {
		t.Error("solutions are part of the hash")
	}
	// Without includes (an older writer), the files decide.
	data := write(t, sampleBundle())
	data = rewriteJSON(t, data, "bundle.json", func(m map[string]any) { delete(m, "includes") })
	data = drop(t, data, "items/two-sum-0193b2f0/solutions/")
	got, _, _ = Read(data, lim)
	if p := got.Items[0]; p.HasSolutions() || !p.HasHiddenTests() {
		t.Errorf("inferred: solutions %v hidden %v", p.HasSolutions(), p.HasHiddenTests())
	}
	// Two references: the first one wins, with a warning.
	b = sampleBundle()
	b.Items[0].Solutions[1].IsReference = true
	got, warnings, _ := Read(write(t, b), lim)
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
