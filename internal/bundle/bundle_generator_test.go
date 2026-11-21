package bundle

import (
	"strings"
	"testing"

	"codeatrophy/internal/domain"
)

const twoSumTests = "items/two-sum-0193b2f0/tests/tests.json"

// generatorBundle is the sample bundle whose hidden case has a generator.
func generatorBundle() *Bundle {
	b := sampleBundle()
	b.Items[0].TestCases[1].Generator = &domain.GeneratorSpec{Language: "python", Source: "print(2)\nprint('1 2')\n"}
	return b
}

// A test case's generator travels as a source file next to its input, and
// is not part of the content hash: the stdin is carried either way.
func TestGeneratorRoundTrip(t *testing.T) {
	src := generatorBundle()
	data := write(t, src)
	got, warnings, err := Read(data, lim)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("read: %v %v", err, warnings)
	}
	cases := got.Items[0].TestCases
	if cases[0].Generator != nil || cases[1].Generator == nil || *cases[1].Generator != *src.Items[0].TestCases[1].Generator ||
		cases[1].Stdin != "2\n1 2\n3\r\n" {
		t.Errorf("cases: %+v", cases)
	}
	if got.Meta.FormatVersion != 1 {
		t.Errorf("format version %d", got.Meta.FormatVersion)
	}
	if ContentHash(&got.Items[0]) != ContentHash(&sampleBundle().Items[0]) {
		t.Error("the generator changed the content hash")
	}
	if c := Changes(&got.Items[0], &sampleBundle().Items[0]); len(c) != 0 {
		t.Errorf("changes: %v", c)
	}
	if s := zipFile(t, data, "items/two-sum-0193b2f0/tests/02.gen.py"); s != "print(2)\nprint('1 2')\n" {
		t.Errorf("generator file: %q", s)
	}
	js := zipFile(t, data, twoSumTests)
	if !strings.Contains(js, `"generator": {
        "language": "python",
        "file": "02.gen.py"
      }`) || strings.Count(js, `"generator"`) != 1 {
		t.Errorf("tests.json:\n%s", js)
	}
}

// A generator that cannot be used is left out with a warning; the case
// and the item are imported.
func TestUnusableGeneratorIsLeftOut(t *testing.T) {
	data := write(t, generatorBundle())
	set := func(v any) []byte {
		return rewriteJSON(t, data, twoSumTests, func(m map[string]any) {
			m["cases"].([]any)[1].(map[string]any)["generator"] = v
		})
	}
	big := rewrite(t, data, "items/two-sum-0193b2f0/tests/02.gen.py", []byte(strings.Repeat("x", 64<<10+1)))
	for name, c := range map[string]struct {
		data []byte
		want string
	}{
		"wrong type":       {set("print(1)"), "case 2: generator must be an object"},
		"unknown language": {set(map[string]any{"language": "cobol", "file": "02.gen.py"}), `case 2: generator has unknown language "cobol"`},
		"bad file name":    {set(map[string]any{"language": "python", "file": "../x.py"}), `has invalid file name "../x.py"`},
		"missing file":     {set(map[string]any{"language": "python", "file": "nope.py"}), "file nope.py is missing"},
		"not UTF-8":        {rewrite(t, data, "items/two-sum-0193b2f0/tests/02.gen.py", []byte("\xff")), "file 02.gen.py is not valid UTF-8"},
		"too large":        {big, "file 02.gen.py: source: must be at most 65536 bytes"},
		"empty":            {rewrite(t, data, "items/two-sum-0193b2f0/tests/02.gen.py", []byte(" \n")), "source: is required"},
	} {
		got, warnings, err := Read(c.data, lim)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(got.Items) != 2 || len(got.Items[0].TestCases) != 2 || got.Items[0].TestCases[1].Generator != nil {
			t.Errorf("%s: %+v", name, got.Items)
		}
		if len(warnings) != 1 || !strings.Contains(warnings[0], c.want) || !strings.Contains(warnings[0], "imported without it") {
			t.Errorf("%s: warnings %v", name, warnings)
		}
	}
	// null is no generator, and no warning.
	got, warnings, _ := Read(set(nil), lim)
	if len(warnings) != 0 || got.Items[0].TestCases[1].Generator != nil {
		t.Errorf("null: %v", warnings)
	}
}
