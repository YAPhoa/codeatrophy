package bundle

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"codeatrophy/internal/domain"
)

// functionBundle is sampleBundle with its problem made solution-only.
func functionBundle() *Bundle {
	b := sampleBundle()
	p := b.Items[0].Problem
	p.Interface = domain.InterfaceFunction
	p.StarterCode = map[string]string{"python": "class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        "}
	p.Harness = map[string]domain.HarnessCode{
		"python": {Prefix: "from __future__ import annotations\n\nimport json\nimport sys\n", Suffix: "\nprint(json.dumps(Solution().twoSum(*[json.loads(l) for l in sys.stdin])))\n"},
		"java":   {Prefix: "", Suffix: "\npublic class Main { public static void main(String[] a) {} }\n"},
	}
	return b
}

func manifestVersion(t *testing.T, data []byte) float64 {
	t.Helper()
	zr, _ := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	for _, f := range zr.File {
		if f.Name == "bundle.json" {
			rc, _ := f.Open()
			var m map[string]any
			json.NewDecoder(rc).Decode(&m)
			rc.Close()
			return m["formatVersion"].(float64)
		}
	}
	t.Fatal("no bundle.json")
	return 0
}

func TestSolutionOnlyProblemRoundTrip(t *testing.T) {
	src := functionBundle()
	data := write(t, src)
	if v := manifestVersion(t, data); v != 2 {
		t.Errorf("a bundle with a solution-only problem is version %v, want 2", v)
	}
	if v := manifestVersion(t, write(t, sampleBundle())); v != 1 {
		t.Errorf("a bundle without one is version %v, want 1", v)
	}
	got, warnings, err := Read(data, lim)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("read: %v %v", err, warnings)
	}
	p := got.Items[0].Problem
	if got.Meta.FormatVersion != 2 || p.Interface != domain.InterfaceFunction || len(p.Harness) != 2 ||
		p.Harness["python"] != src.Items[0].Problem.Harness["python"] || p.Harness["java"].Prefix != "" ||
		p.StarterCode["python"] != src.Items[0].Problem.StarterCode["python"] {
		t.Errorf("problem: %+v", p)
	}
	if ContentHash(&got.Items[0]) != ContentHash(&src.Items[0]) {
		t.Error("the hash changed across the round trip")
	}
	zr, _ := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	for _, want := range []string{"items/two-sum-0193b2f0/harness/python-prefix.py", "items/two-sum-0193b2f0/harness/python-suffix.py",
		"items/two-sum-0193b2f0/harness/java-prefix.java", "items/two-sum-0193b2f0/harness/java-suffix.java"} {
		if !names[want] {
			t.Errorf("missing %s", want)
		}
	}
}

// A program problem hashes exactly as format version 1 defines it, so the
// stored hashes of existing bundles stay valid; the interface and harness
// of a solution-only problem change the hash.
func TestContentHashOfProgramProblemsIsUnchanged(t *testing.T) {
	it := sampleBundle().Items[0]
	it.Problem.Interface = domain.InterfaceProgram
	it.Problem.Harness = map[string]domain.HarnessCode{}
	starter := map[string]any{}
	for k, v := range it.Problem.StarterCode {
		starter[k] = v
	}
	var sols, cases []any
	for _, s := range it.Solutions {
		sols = append(sols, map[string]any{"name": s.Name, "language": s.Language, "source": s.Source, "notes": s.Notes, "isReference": s.IsReference})
	}
	for _, c := range it.TestCases {
		cases = append(cases, map[string]any{"name": c.Name, "stdin": c.Stdin, "expectedStdout": c.ExpectedStdout, "isSample": c.IsSample})
	}
	v1 := map[string]any{
		"type": "problem", "title": it.Title, "summary": it.Summary, "tags": []any{"array", "hash-map"},
		"source": map[string]any{"url": *it.Source.URL, "note": nil}, "variantOf": nil, "body": it.Body,
		"difficulty": "easy",
		"problem":    map[string]any{"timeLimitMs": int64(2000), "memoryLimitKb": int64(262144), "compare": "tokens", "starterCode": starter},
		"solutions":  sols, "testCases": cases,
	}
	sum := sha256.Sum256(Canonical(v1))
	if want := "sha256:" + hex.EncodeToString(sum[:]); ContentHash(&it) != want {
		t.Errorf("program problem hash %s, want the version 1 hash %s", ContentHash(&it), want)
	}

	fn := functionBundle().Items[0]
	h := ContentHash(&fn)
	if h == ContentHash(&it) {
		t.Error("a solution-only problem hashes like a program")
	}
	fn2 := functionBundle().Items[0]
	fn2.Problem.Harness["java"] = domain.HarnessCode{Suffix: "changed"}
	if ContentHash(&fn2) == h {
		t.Error("the harness is not part of the hash")
	}
	if c := Changes(&fn, &fn2); strings.Join(c, ",") != "harness" {
		t.Errorf("changes: %v", c)
	}
	if c := Changes(&it, &fn); strings.Join(c, ",") != "starterCode,interface,harness" {
		t.Errorf("changes: %v", c)
	}
}

func TestVersion2ReaderRules(t *testing.T) {
	data := write(t, functionBundle())
	item := "items/two-sum-0193b2f0/item.json"

	// A missing runner file makes that language unusable, not the item.
	b, warnings, err := Read(drop(t, data, "items/two-sum-0193b2f0/harness/java-suffix"), lim)
	if err != nil || len(b.Items) != 2 || len(b.Items[0].Problem.Harness) != 1 || !containsWarning(warnings, "java harness is incomplete") {
		t.Errorf("missing file: %v %+v %v", err, b, warnings)
	}
	// An unknown interface or a malformed harness skips the item.
	for name, fn := range map[string]func(map[string]any){
		"unknown interface":       func(m map[string]any) { m["problem"].(map[string]any)["interface"] = "interactive" },
		"harness of a wrong type": func(m map[string]any) { m["problem"].(map[string]any)["harness"] = []any{"x"} },
	} {
		b, warnings, err := Read(rewriteJSON(t, data, item, fn), lim)
		if err != nil || len(b.Items) != 1 || b.Items[0].Type != domain.TypeReading || len(warnings) == 0 {
			t.Errorf("%s: %v %d items %v", name, err, len(b.Items), warnings)
		}
	}
	// A harness on a program problem is ignored.
	b, warnings, err = Read(rewriteJSON(t, data, item, func(m map[string]any) {
		m["problem"].(map[string]any)["interface"] = "program"
	}), lim)
	if err != nil || b.Items[0].Problem.Interface != domain.InterfaceProgram || len(b.Items[0].Problem.Harness) != 0 ||
		!containsWarning(warnings, "full-program problem") {
		t.Errorf("program with harness: %v %+v %v", err, b.Items[0].Problem, warnings)
	}

	// In a version 1 bundle the fields mean nothing: the problem is a
	// program, with a warning, and the item is still imported.
	v1 := rewriteJSON(t, data, "bundle.json", func(m map[string]any) { m["formatVersion"] = 1 })
	b, warnings, err = Read(v1, lim)
	if err != nil || len(b.Items) != 2 || b.Items[0].Problem.Interface != domain.InterfaceProgram ||
		len(b.Items[0].Problem.Harness) != 0 || !containsWarning(warnings, "not part of bundle format version 1") {
		t.Errorf("version 1: %v %+v %v", err, b.Items[0].Problem, warnings)
	}
	// A harness of a wrong type in a version 1 bundle is an unknown field.
	b, _, err = Read(rewriteJSON(t, v1, item, func(m map[string]any) { m["problem"].(map[string]any)["harness"] = 7 }), lim)
	if err != nil || len(b.Items) != 2 {
		t.Errorf("version 1, odd harness: %v %d", err, len(b.Items))
	}
}
