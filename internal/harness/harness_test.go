package harness

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"codeatrophy/internal/domain"
)

func TestAssemble(t *testing.T) {
	cases := []struct {
		name, prefix, source, suffix string
		want                         string
		offset, lines, suffixLines   int
	}{
		{"all end with newlines", "a\nb\n", "s1\ns2\n", "x\n", "a\nb\ns1\ns2\nx\n", 2, 2, 1},
		{"newlines are added", "a\nb", "s1\ns2", "x", "a\nb\ns1\ns2\nx", 2, 2, 1},
		{"empty prefix", "", "s\n", "\nx\n", "s\n\nx\n", 0, 1, 2},
		{"empty suffix", "p\n", "s", "", "p\ns\n", 1, 1, 0},
		{"stub with an open body", "p\n", "class S:\n    def f(self):\n        ", "\nmain()\n",
			"p\nclass S:\n    def f(self):\n        \n\nmain()\n", 1, 3, 2},
		{"blank lines count", "\n\n\n", "s\n", "", "\n\n\ns\n", 3, 1, 0},
	}
	for _, c := range cases {
		p := Assemble("python", &domain.HarnessCode{Prefix: c.prefix, Suffix: c.suffix}, c.source)
		if p.Text != c.want || p.LineOffset != c.offset || p.SourceLines != c.lines || p.SuffixLines != c.suffixLines {
			t.Errorf("%s: got %q offset %d lines %d suffix %d", c.name, p.Text, p.LineOffset, p.SourceLines, p.SuffixLines)
		}
		// The solver's first line is line offset+1 of the program.
		if lines := strings.Split(p.Text, "\n"); c.source != "" && lines[p.LineOffset] != strings.Split(c.source, "\n")[0] {
			t.Errorf("%s: line %d is %q", c.name, p.LineOffset+1, lines[p.LineOffset])
		}
	}
	p := Assemble("python", nil, "print(1)")
	if p.Text != "print(1)" || p.LineOffset != 0 || p.Harnessed() {
		t.Errorf("without a harness: %+v", p)
	}
	if got := p.Rewrite(`File "script.py", line 1`, []string{"script.py"}); got != `File "script.py", line 1` {
		t.Errorf("without a harness the text changed: %q", got)
	}
}

// TestRewriteJudge0Output maps real messages, captured from Judge0 1.13.1's
// toolchains (Python 3.8.1, OpenJDK 13.0.1, GCC 9.2.0, Go 1.13.5, Node.js
// 12.14.0, TypeScript 3.7.4, Kotlin 1.3.70, Ruby 2.7.0, Rust 1.40.0, Mono
// 6.6.0.161), for compile errors, runtime errors, unchanged stubs and
// errors inside the runner. The expected rewrites were written by hand.
func TestRewriteJudge0Output(t *testing.T) {
	raw, err := os.ReadFile("testdata/judge0-1.13.1.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Language                       string
		LineOffset, SourceLines, SuffixLines int
		Files                                []string
		Output, Want                         string
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	langs := map[string]bool{}
	for _, c := range cases {
		langs[c.Language] = true
		p := Assemble(c.Language, &domain.HarnessCode{Prefix: strings.Repeat("p\n", c.LineOffset),
			Suffix: strings.Repeat("x\n", c.SuffixLines)}, strings.Repeat("s\n", c.SourceLines))
		if got := p.Rewrite(c.Output, c.Files); got != c.Want {
			t.Errorf("%s:\ngot:\n%s\nwant:\n%s", c.Name, got, c.Want)
		}
	}
	for _, l := range domain.Languages {
		if !langs[l.ID] {
			t.Errorf("no captured output for %s", l.ID)
		}
	}
}

func TestRewriteRules(t *testing.T) {
	// Prefix lines 1-2, source lines 3-5, suffix lines 6-7.
	p := Assemble("cpp", &domain.HarnessCode{Prefix: "a\nb\n", Suffix: "x\ny\n"}, "1\n2\n3\n")
	files := []string{"main.cpp"}
	cases := []struct{ in, want string }{
		{"main.cpp:1:1: error: x", "<runner prefix>:1:1: error: x"},
		{"main.cpp:3:1: error: x", "main.cpp:1:1: error: x"},
		{"main.cpp:5:1: error: x", "main.cpp:3:1: error: x"},
		{"main.cpp:6:1: error: x", "<runner suffix>:1:1: error: x"},
		{"main.cpp:9:1: error: x", "<runner suffix>:4:1: error: x"},
		// Other files, and names that only end like the program's, are left alone.
		{"/usr/include/c++/9/bits/main.cpp:4:1: note", "/usr/include/c++/9/bits/main.cpp:4:1: note"},
		{"xmain.cpp:4:1: note", "xmain.cpp:4:1: note"},
		{"In file included from main.cpp:1:", "In file included from <runner prefix>:1:"},
		// Gutter lines follow the location before them.
		{"main.cpp:4:3: error: x\n    4 |   int y\n      |   ^\n", "main.cpp:2:3: error: x\n    2 |   int y\n      |   ^\n"},
		{"main.cpp:7:3: error: x\n    7 |   int y\n", "<runner suffix>:2:3: error: x\n    2 |   int y\n"},
		{"/usr/include/x.h:40:3: error: x\n   40 |   int y\n", "/usr/include/x.h:40:3: error: x\n   40 |   int y\n"},
		{"main.cpp:4:3: error: x\n/usr/include/x.h:40:3: note: y\n   40 |   int y\n",
			"main.cpp:2:3: error: x\n/usr/include/x.h:40:3: note: y\n   40 |   int y\n"},
		// Without a location first, a gutter-like line is program output.
		{"    4 | not a snippet\n", "    4 | not a snippet\n"},
		{"", ""},
	}
	for _, c := range cases {
		if got := p.Rewrite(c.in, files); got != c.want {
			t.Errorf("Rewrite(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := p.Rewrite("main.cpp:4:1: x", nil); got != "main.cpp:4:1: x" {
		t.Errorf("without file names the text changed: %q", got)
	}
	if got := Assemble("cobol", &domain.HarnessCode{}, "x").Rewrite("main.cob:1: x", []string{"main.cob"}); got != "main.cob:1: x" {
		t.Errorf("an unknown toolchain changed the text: %q", got)
	}

	// With nothing after the source, a line past its end is still the
	// solver's (an error at the end of the file).
	q := Assemble("python", &domain.HarnessCode{Prefix: "p\n"}, "def f():\n")
	if got := q.Rewrite(`  File "script.py", line 3`, []string{"script.py"}); got != `  File "script.py", line 2` {
		t.Errorf("end of file: %q", got)
	}

	// Go: the runtime's own main.go is not the program's.
	g := Assemble("go", &domain.HarnessCode{Prefix: "package main\n"}, "func f() {}\n")
	in := "main.f()\n\t/box/main.go:2 +0x1\nruntime.main()\n\t/usr/local/go-1.13.5/src/runtime/main.go:203 +0x2\n"
	want := "main.f()\n\t/box/main.go:1 +0x1\nruntime.main()\n\t/usr/local/go-1.13.5/src/runtime/main.go:203 +0x2\n"
	if got := g.Rewrite(in, []string{"main.go", "./main.go", "/box/main.go"}); got != want {
		t.Errorf("go: %q", got)
	}
}
