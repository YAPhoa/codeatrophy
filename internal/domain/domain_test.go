package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOptDistinguishesOmittedNullAndValue(t *testing.T) {
	var in struct {
		A Opt[string] `json:"a"`
		B Opt[string] `json:"b"`
		C Opt[string] `json:"c"`
	}
	if err := json.Unmarshal([]byte(`{"a": null, "b": "x"}`), &in); err != nil {
		t.Fatal(err)
	}
	if !in.A.Set || !in.A.Null || in.A.HasValue() {
		t.Errorf("a: got %+v, want set null", in.A)
	}
	if !in.B.HasValue() || in.B.Val != "x" {
		t.Errorf("b: got %+v", in.B)
	}
	if in.C.Set {
		t.Errorf("c: got %+v, want unset", in.C)
	}
}

func TestDecodeJSONReportsFieldPath(t *testing.T) {
	cases := []struct {
		body, path, expected string
	}{
		{`{"title": 5}`, "title", "a string"},
		{`{"problem": {"timeLimitMs": "fast"}}`, "problem.timeLimitMs", "an integer"},
		{`{"tags": "a"}`, "tags", "an array"},
		{`{"testCases": [{}, {"expectedStdout": 3}]}`, "testCases.1.expectedStdout", "a string"},
		{`[1, 2]`, "", "an object"},
	}
	for _, c := range cases {
		var in ItemInput
		err := DecodeJSON([]byte(c.body), &in)
		te, ok := err.(*TypeError)
		if !ok {
			t.Errorf("%s: got %v, want *TypeError", c.body, err)
			continue
		}
		if te.Path != c.path || te.Expected != c.expected {
			t.Errorf("%s: got path %q expected %q, want %q %q", c.body, te.Path, te.Expected, c.path, c.expected)
		}
	}
}

func TestNormalizeTags(t *testing.T) {
	got := NormalizeTags([]string{" DP ", "graphs", "dp", "", "Arrays"})
	want := []string{"arrays", "dp", "graphs"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestValidateItem(t *testing.T) {
	lim := Limits{MaxSourceBytes: 100}
	it := Item{ItemSummary: ItemSummary{Type: TypeProblem, Title: "T", Status: StatusTodo}, Problem: DefaultProblemSpec()}
	if fe := ValidateItem(&it, lim); len(fe) != 0 {
		t.Fatalf("valid item rejected: %v", fe)
	}
	bad := it.Clone()
	bad.Title = strings.Repeat("x", MaxTitleChars+1)
	bad.Problem.TimeLimitMs = 99
	bad.Problem.MemoryLimitKb = MaxMemoryLimitKb + 1
	bad.Problem.StarterCode = map[string]string{"cobol": "x", "python": strings.Repeat("x", 101)}
	bad.Tags = []string{strings.Repeat("t", MaxTagChars+1)}
	u := "ftp://example.com"
	bad.Source.URL = &u
	fe := ValidateItem(&bad, lim)
	for _, k := range []string{"title", "problem.timeLimitMs", "problem.memoryLimitKb", "problem.starterCode.cobol",
		"problem.starterCode.python", "tags", "source.url"} {
		if _, ok := fe[k]; !ok {
			t.Errorf("missing error for %s; got %v", k, fe)
		}
	}
	// Boundaries are inclusive.
	edge := it.Clone()
	edge.Title = strings.Repeat("é", MaxTitleChars)
	edge.Problem.TimeLimitMs, edge.Problem.MemoryLimitKb = MinTimeLimitMs, MaxMemoryLimitKb
	if fe := ValidateItem(&edge, lim); len(fe) != 0 {
		t.Errorf("boundary values rejected: %v", fe)
	}
}

func TestApplyTestCaseInputResetsVerified(t *testing.T) {
	tc := TestCase{Stdin: "1", ExpectedStdout: "2", Verified: true, Origin: OriginManual}
	ApplyTestCaseInput(&tc, TestCaseInput{ExpectedStdout: Some("3")})
	if tc.Verified {
		t.Error("changing expectedStdout should reset verified")
	}
	tc.Verified = true
	ApplyTestCaseInput(&tc, TestCaseInput{Stdin: Some("5"), Verified: Some(true)})
	if !tc.Verified {
		t.Error("verified set in the same request should win")
	}
	tc.Verified = true
	ApplyTestCaseInput(&tc, TestCaseInput{Name: Some("renamed")})
	if !tc.Verified {
		t.Error("renaming should keep verified")
	}
}

func TestStylePresetLimits(t *testing.T) {
	ok := func(name, instr string) bool {
		p := StylePreset{Name: name, Instructions: instr}
		return len(ValidateStylePreset(&p)) == 0
	}
	// Code points, not bytes: 60 three-byte characters are fine.
	if !ok(strings.Repeat("語", MaxStyleNameChars), "x") {
		t.Error("60 multi-byte characters should be a valid name")
	}
	if ok(strings.Repeat("語", MaxStyleNameChars+1), "x") {
		t.Error("61 characters should be rejected")
	}
	if !ok("n", strings.Repeat("ü", MaxStyleInstructionsChars)) {
		t.Error("2000 characters should be valid instructions")
	}
	if ok("n", strings.Repeat("ü", MaxStyleInstructionsChars+1)) {
		t.Error("2001 characters should be rejected")
	}
	// Lengths are counted after trimming.
	if !ok("  "+strings.Repeat("a", MaxStyleNameChars)+"\n ", "x") {
		t.Error("surrounding whitespace should not count")
	}
	if ok("   ", "x") || ok("n", " \n\t ") {
		t.Error("blank values should be rejected")
	}
	// Newline and tab are allowed in instructions, other control characters are not.
	if !ok("n", "line one\n\tline two") {
		t.Error("newline and tab should be allowed in instructions")
	}
	// Names are a single line.
	for _, name := range []string{"two\nlines", "tab\tbed", "cr\rhere", "crlf\r\nname"} {
		if ok(name, "x") {
			t.Errorf("name %q should be rejected", name)
		}
	}
	for _, c := range []string{"\x00", "\x1b[31m", "\u0085", "\x7f", "\v"} {
		if ok("n", "a"+c+"b") {
			t.Errorf("control character %q should be rejected in instructions", c)
		}
		if ok("a"+c+"b", "x") {
			t.Errorf("control character %q should be rejected in names", c)
		}
	}
	// \r line endings are normalised, not rejected.
	crlf := StylePreset{Name: "n", Instructions: "one\r\ntwo\rthree"}
	if fe := ValidateStylePreset(&crlf); len(fe) != 0 || crlf.Instructions != "one\ntwo\nthree" {
		t.Errorf("CRLF normalisation: %q %v", crlf.Instructions, fe)
	}
	// Never truncated.
	p := StylePreset{Name: "n", Instructions: strings.Repeat("a", MaxStyleInstructionsChars+5)}
	ValidateStylePreset(&p)
	if len(p.Instructions) != MaxStyleInstructionsChars+5 {
		t.Error("instructions must not be truncated")
	}
}

func TestTruncateKeepsUTF8(t *testing.T) {
	s := strings.Repeat("é", 10) // 20 bytes
	got := Truncate(s, 7)
	if len(got) != 6 || !strings.HasPrefix(s, got) {
		t.Errorf("got %q (%d bytes)", got, len(got))
	}
}

func TestTagRules(t *testing.T) {
	for _, bad := range []string{"a/b", "tab\there", "bell\x07"} {
		if ValidateTag(NormalizeTag(bad)) == "" {
			t.Errorf("%q should be rejected", bad)
		}
	}
	if ValidateTag("c++") != "" || ValidateTag("日本語") != "" {
		t.Error("ordinary tags should be valid")
	}
}

func TestNormalizeItemText(t *testing.T) {
	it := Item{ItemSummary: ItemSummary{Type: TypeProblem, Title: " T\r\n "}, Body: "a\r\nb\rc", Notes: "x\r\n",
		Problem: &ProblemSpec{StarterCode: map[string]string{"python": "x\r\ny"}, ReferenceSolution: &Solution{Language: "python", Source: "p\r\n"}}}
	NormalizeItem(&it)
	if it.Title != "T" || it.Body != "a\nb\nc" || it.Notes != "x\n" || it.Problem.StarterCode["python"] != "x\ny" ||
		it.Problem.ReferenceSolution.Source != "p\n" {
		t.Errorf("normalised: %+v %+v", it, it.Problem)
	}
	tc := TestCase{Origin: OriginManual}
	ApplyTestCaseInput(&tc, TestCaseInput{Name: Some("n\r\n"), Stdin: Some("1\r\n"), ExpectedStdout: Some("2\r\n")})
	if tc.Name != "n\n" || tc.Stdin != "1\r\n" || tc.ExpectedStdout != "2\r\n" {
		t.Errorf("test case stdin/stdout must stay byte-exact: %+v", tc)
	}
}

// Single-line fields reject the Unicode line and paragraph separators and
// NEL as well as newline and tab.
func TestSingleLineFieldsRejectUnicodeSeparators(t *testing.T) {
	lim := Limits{MaxSourceBytes: 1 << 20}
	checks := map[string]func(string) bool{
		"title": func(s string) bool {
			it := Item{Type: TypeReading, Title: s}
			return ValidateItem(&it, lim)["title"] == ""
		},
		"collection name": func(s string) bool {
			c := Collection{Name: s}
			return ValidateCollection(&c)["name"] == ""
		},
		"tag": func(s string) bool { return ValidateTag(s) == "" },
		"preset name": func(s string) bool {
			p := StylePreset{Name: s, Instructions: "x"}
			return ValidateStylePreset(&p)["name"] == ""
		},
		"solution name": func(s string) bool {
			sol := ItemSolution{Name: s, Language: "python", Source: "print(1)"}
			return ValidateItemSolution(&sol, lim)["name"] == ""
		},
	}
	for field, valid := range checks {
		if !valid("plain name") {
			t.Errorf("%s: a plain value is rejected", field)
		}
		for _, sep := range []string{" ", " ", "\u0085", "\n", "\t"} {
			if valid("a" + sep + "b") {
				t.Errorf("%s: %q is accepted", field, sep)
			}
		}
	}
}
