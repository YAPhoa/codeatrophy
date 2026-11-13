// Package harness assembles the program that runs for a solution of a
// "function" problem, and maps line numbers in what the toolchain reports
// about that program back to the solver's own lines. It performs no I/O.
//
// The program is the harness prefix, the submitted source and the harness
// suffix, each starting on a new line: a newline is added after the prefix
// and after the source when they do not already end with one, and nothing
// else is added or removed. The source therefore starts on line
// LineOffset+1 of the program, where LineOffset is the number of lines of
// the prefix, and its line k is line LineOffset+k of the program.
package harness

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"codeatrophy/internal/domain"
)

// Labels that replace the file name in a location inside the harness, so
// that a number there is not mistaken for a line of the solver's code. The
// line number becomes relative to that part of the harness.
const (
	PrefixLabel = "<runner prefix>"
	SuffixLabel = "<runner suffix>"
)

// Program is the code that runs for a submitted source.
type Program struct {
	Language string
	// Text is the complete program.
	Text string
	// LineOffset is the number of lines before the source; 0 without a
	// harness.
	LineOffset int
	// SourceLines is the number of lines of the source in Text.
	SourceLines int
	// SuffixLines is the number of lines of the suffix.
	SuffixLines int
	harnessed   bool
}

// withNewline returns s with a trailing newline unless it is empty or
// already ends with one.
func withNewline(s string) string {
	if s == "" || strings.HasSuffix(s, "\n") {
		return s
	}
	return s + "\n"
}

func lineCount(s string) int {
	n := strings.Count(s, "\n")
	if s != "" && !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

// Assemble builds the program for source. Without a harness (a program
// problem) the source is the program.
func Assemble(language string, h *domain.HarnessCode, source string) Program {
	if h == nil {
		return Program{Language: language, Text: source, SourceLines: lineCount(source)}
	}
	prefix, body := withNewline(h.Prefix), withNewline(source)
	return Program{
		Language:    language,
		Text:        prefix + body + h.Suffix,
		LineOffset:  strings.Count(prefix, "\n"),
		SourceLines: strings.Count(body, "\n"),
		SuffixLines: lineCount(h.Suffix),
		harnessed:   true,
	}
}

// Harnessed reports whether the program was assembled from a harness.
func (p Program) Harnessed() bool { return p.harnessed }

// place maps a line of the program to where it is: the solver's line, or a
// line of the prefix or suffix with its label.
func (p Program) place(n int) (label string, line int) {
	switch {
	case n > p.LineOffset && n <= p.LineOffset+p.SourceLines:
		return "", n - p.LineOffset
	case n >= 1 && n <= p.LineOffset:
		return PrefixLabel, n
	case n > p.LineOffset+p.SourceLines && p.SuffixLines == 0:
		// Nothing follows the source (an error at the end of the file).
		return "", n - p.LineOffset
	default:
		return SuffixLabel, n - p.LineOffset - p.SourceLines
	}
}

// Rewrite maps line numbers that refer to the assembled program in text (a
// compiler's output or a program's stderr) to the solver's own lines.
// files are the names under which the engine's toolchain reports the
// program's own file (see judge.SourceNamer); references to other files are
// left alone. A location inside the harness keeps its line relative to that
// part, with the file name replaced by PrefixLabel or SuffixLabel. This is
// best effort: only the message formats of the toolchains listed in
// formats are recognised, and text without a harness is returned as is.
func (p Program) Rewrite(text string, files []string) string {
	if !p.harnessed || text == "" || len(files) == 0 {
		return text
	}
	tc := toolchainFor(p.Language, files)
	if tc == nil {
		return text
	}
	lines := strings.SplitAfter(text, "\n")
	ours := false // the latest location named the program's file
	for i, l := range lines {
		out, found := p.rewriteLocations(tc, l)
		switch {
		case found:
			ours = true
			lines[i] = out
		case tc.other != nil && tc.other.MatchString(l):
			ours = false
		case ours && tc.gutter != nil:
			lines[i] = p.rewriteGutter(tc.gutter, l)
		}
	}
	return strings.Join(lines, "")
}

func (p Program) rewriteLocations(tc *toolchain, l string) (string, bool) {
	var b strings.Builder
	last, found := 0, false
	for _, re := range tc.locations {
		ms := re.FindAllStringSubmatchIndex(l, -1)
		if len(ms) == 0 {
			continue
		}
		fi, li := re.SubexpIndex("file"), re.SubexpIndex("line")
		for _, m := range ms {
			fs, fe, ls, le := m[2*fi], m[2*fi+1], m[2*li], m[2*li+1]
			if fs < last {
				continue // overlaps an earlier match
			}
			n, err := strconv.Atoi(l[ls:le])
			if err != nil || n < 1 {
				continue
			}
			label, line := p.place(n)
			b.WriteString(l[last:fs])
			if label != "" {
				b.WriteString(label)
			} else {
				b.WriteString(l[fs:fe])
			}
			b.WriteString(l[fe:ls])
			b.WriteString(strconv.Itoa(line))
			last, found = le, true
		}
		if found {
			break // one format per line
		}
	}
	if !found {
		return l, false
	}
	b.WriteString(l[last:])
	return b.String(), true
}

// rewriteGutter maps the line number of a source-snippet line ("   12 | x")
// that follows a location in the program's file, keeping its width.
func (p Program) rewriteGutter(re *regexp.Regexp, l string) string {
	m := re.FindStringSubmatchIndex(l)
	if m == nil {
		return l
	}
	ns, ne := m[2], m[3]
	n, err := strconv.Atoi(strings.TrimSpace(l[ns:ne]))
	if err != nil || n < 1 {
		return l
	}
	_, line := p.place(n)
	return fmt.Sprintf("%*d", ne, line) + l[ne:]
}

// toolchain describes how one language's toolchain reports locations.
type toolchain struct {
	// locations match a reference to the program's file, with the groups
	// "file" and "line".
	locations []*regexp.Regexp
	// gutter matches a numbered source-snippet line; group 1 is the
	// number (with any padding before it).
	gutter *regexp.Regexp
	// other matches a location in another file, after which gutter lines
	// are left alone.
	other *regexp.Regexp
}

// Message formats, derived from the output of the toolchains Judge0 1.13
// ships (see harness_test.go for the captured messages). %f stands for the
// program's file names. A location must start a line or follow whitespace
// or "(", so that "main.go" does not match ".../runtime/main.go".
var (
	colonLine = `(?:^|[\s(])(?P<file>%f):(?P<line>\d+)`   // gcc, javac, kotlinc, go, node, ruby, rustc
	parenLine = `(?:^|[\s(])(?P<file>%f)\((?P<line>\d+),` // tsc, mcs
	pyLine    = `File "(?P<file>%f)", line (?P<line>\d+)` // CPython tracebacks and syntax errors
	gutter    = regexp.MustCompile(`^(\s*\d+) \|`)        // gcc 9 and rustc source snippets
	gccOther  = regexp.MustCompile(`^(?:In file included from |\s+from )?[^\s:]+:\d+[:,]`)
	rustOther = regexp.MustCompile(`^\s*(?:-->|:::) [^\s:]+:\d+`) // a span in another file
)

var formats = map[string]struct {
	locations []string
	gutter    *regexp.Regexp
	other     *regexp.Regexp
}{
	"c":          {[]string{colonLine}, gutter, gccOther},
	"cpp":        {[]string{colonLine}, gutter, gccOther},
	"csharp":     {[]string{parenLine}, nil, nil},
	"go":         {[]string{colonLine}, nil, nil},
	"java":       {[]string{colonLine}, nil, nil},
	"javascript": {[]string{colonLine}, nil, nil},
	"kotlin":     {[]string{colonLine}, nil, nil},
	"python":     {[]string{pyLine}, nil, nil},
	"ruby":       {[]string{colonLine}, nil, nil},
	"rust":       {[]string{colonLine}, gutter, rustOther},
	"typescript": {[]string{parenLine}, nil, nil},
}

var (
	cacheMu sync.Mutex
	cache   = map[string]*toolchain{}
)

func toolchainFor(lang string, files []string) *toolchain {
	f, ok := formats[lang]
	if !ok {
		return nil
	}
	key := lang + "\x00" + strings.Join(files, "\x00")
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if tc, ok := cache[key]; ok {
		return tc
	}
	quoted := make([]string, len(files))
	for i, name := range files {
		quoted[i] = regexp.QuoteMeta(name)
	}
	alt := strings.Join(quoted, "|")
	tc := &toolchain{gutter: f.gutter, other: f.other}
	for _, loc := range f.locations {
		tc.locations = append(tc.locations, regexp.MustCompile(strings.ReplaceAll(loc, "%f", alt)))
	}
	cache[key] = tc
	return tc
}
