// Package bundle reads, writes and validates the portable import/export
// format described in docs/bundle-format.md.
package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"maps"
	"slices"
	"strings"
	"time"

	"codeatrophy/internal/domain"
)

// Format identification. FormatVersion is the newest version this package
// reads and writes. A bundle is written in the oldest version that can
// carry its content (see RequiredVersion), so that servers which know only
// version 1 can still import bundles without solution-only problems, and
// refuse those that have one.
const (
	FormatName    = "codeatrophy.bundle"
	FormatVersion = 2
)

// MaxRelated is the most ids an item's related field holds, a rule of the
// format, and domain.MaxLinksPerItemCeiling, the most links an instance may
// allow an item, is the same number. A library may allow an item fewer
// links (domain.Limits.MaxLinksPerItem); an import leaves out the links over
// that limit with a warning.
const MaxRelated = 50

// Format versions.
const (
	// Version1 carries problems that are complete programs.
	Version1 = 1
	// Version2 adds solution-only problems: problem.interface and
	// problem.harness in item.json, and the harness/ directory.
	Version2 = 2
)

// RequiredVersion is the oldest format version that can carry items.
func RequiredVersion(items []Item) int {
	for i := range items {
		if p := items[i].Problem; p != nil && p.Interface == domain.InterfaceFunction {
			return Version2
		}
	}
	return Version1
}

// Meta describes a bundle as a whole.
type Meta struct {
	Name             string
	Description      string
	Author           string
	FormatVersion    int
	CreatedAt        time.Time
	GeneratorName    string
	GeneratorVersion string
	// Includes records what the export carried. Nil when a bundle does not
	// say (written by hand or by an older writer); readers then infer it.
	Includes *Includes
}

// Includes says whether an export carried solutions and hidden test cases.
type Includes struct {
	Solutions   bool
	HiddenTests bool
}

// TestCase is a test case as carried by a bundle.
type TestCase struct {
	Name           string
	Stdin          string
	ExpectedStdout string
	IsSample       bool
	Origin         domain.TestOrigin
	Verified       bool
	// Generator is the program that printed Stdin, or nil. Like Origin, it
	// is not content: it is not hashed, and Stdin is carried either way.
	Generator *domain.GeneratorSpec
}

// Problem holds the problem-only fields of a bundle item.
type Problem struct {
	TimeLimitMs   int
	MemoryLimitKb int
	Compare       domain.CompareMode
	StarterCode   map[string]string
	// Interface is program unless the problem is solution-only; only
	// function problems have a Harness.
	Interface domain.ProblemInterface
	Harness   map[string]domain.HarnessCode
}

// Solution is a saved solution as carried by a bundle.
type Solution struct {
	Name        string
	Language    string
	Source      string
	Notes       string
	IsReference bool
}

// Item is the shareable content of one library item.
type Item struct {
	ID         string
	Type       domain.ItemType
	Title      string
	Summary    string
	Difficulty *domain.Difficulty
	Tags       []string
	Source     domain.Source
	VariantOf  *string
	// Related are the ids of the items linked to this one, sorted, which
	// may include items not in the bundle. Links are not content: they are
	// left out of the content hash and of Changes.
	Related   []string
	CreatedAt time.Time
	UpdatedAt time.Time
	Body      string
	Problem   *Problem
	TestCases []TestCase
	// Solutions are the item's saved solutions, in order, when
	// SolutionsIncluded; a bundle exported without solutions carries none
	// and says so (SolutionsIncluded false).
	Solutions         []Solution
	SolutionsIncluded bool
	// HiddenTestsIncluded is false when only sample test cases were
	// exported; local hidden cases are then left alone on import.
	HiddenTestsIncluded bool

	// StoredHash is the contentHash found in bundle.json (read side only).
	StoredHash string
	// Dir is the item's directory inside the bundle.
	Dir string
}

// HasSolutions reports whether the item carries its solutions (possibly
// none), as opposed to having been exported without them.
func (it *Item) HasSolutions() bool { return it.Type == domain.TypeProblem && it.SolutionsIncluded }

// HasHiddenTests reports whether the item carries its full test set, as
// opposed to sample cases only.
func (it *Item) HasHiddenTests() bool { return it.HiddenTestsIncluded }

func anyHidden(cases []TestCase) bool {
	for _, tc := range cases {
		if !tc.IsSample {
			return true
		}
	}
	return false
}

// Collection is a collection as carried by a bundle.
type Collection struct {
	ID          string
	Name        string
	Description string
	ParentID    *string
	Position    int
	ItemIDs     []string
}

// Bundle is a parsed or to-be-written bundle.
type Bundle struct {
	Meta        Meta
	Items       []Item
	Collections []Collection
}

// FromDomain converts a library item with its test cases and solutions into
// bundle form. includeSolutions and includeHidden select what is carried, as
// for an export; they are also used to compute a local item's hash over the
// same fields a bundle item contains.
func FromDomain(it domain.Item, cases []domain.TestCase, sols []domain.ItemSolution, includeSolutions, includeHidden bool) Item {
	out := Item{
		ID: it.ID, Type: it.Type, Title: it.Title, Summary: it.Summary, Difficulty: it.Difficulty,
		Tags: slices.Clone(it.Tags), Source: it.Source, VariantOf: it.VariantOf,
		CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt, Body: it.Body,
	}
	if out.Tags == nil {
		out.Tags = []string{}
	}
	if it.Type == domain.TypeProblem && it.Problem != nil {
		p := &Problem{
			TimeLimitMs: it.Problem.TimeLimitMs, MemoryLimitKb: it.Problem.MemoryLimitKb,
			Compare: it.Problem.Compare, StarterCode: map[string]string{},
			Interface: domain.InterfaceProgram, Harness: map[string]domain.HarnessCode{},
		}
		for k, v := range it.Problem.StarterCode {
			p.StarterCode[k] = v
		}
		if it.Problem.Interface == domain.InterfaceFunction {
			p.Interface = domain.InterfaceFunction
			for k, v := range it.Problem.Harness {
				p.Harness[k] = v
			}
		}
		if includeSolutions {
			out.SolutionsIncluded = true
			out.Solutions = []Solution{}
			for _, s := range sols {
				out.Solutions = append(out.Solutions, Solution{Name: s.Name, Language: s.Language, Source: s.Source,
					Notes: s.Notes, IsReference: s.IsReference})
			}
		}
		out.Problem = p
		out.HiddenTestsIncluded = includeHidden
		for _, tc := range cases {
			if !includeHidden && !tc.IsSample {
				continue
			}
			out.TestCases = append(out.TestCases, TestCase{
				Name: tc.Name, Stdin: tc.Stdin, ExpectedStdout: tc.ExpectedStdout,
				IsSample: tc.IsSample, Origin: tc.Origin, Verified: tc.Verified, Generator: tc.Generator,
			})
		}
	}
	return out
}

// ContentHash returns "sha256:<hex>" over the item's canonical content
// document.
func ContentHash(it *Item) string {
	tags := slices.Clone(it.Tags)
	slices.Sort(tags)
	tagVals := make([]any, len(tags))
	for i, t := range tags {
		tagVals[i] = t
	}
	doc := map[string]any{
		"type":      string(it.Type),
		"title":     it.Title,
		"summary":   it.Summary,
		"tags":      tagVals,
		"source":    map[string]any{"url": strOrNil(it.Source.URL), "note": strOrNil(it.Source.Note)},
		"variantOf": strOrNil(it.VariantOf),
		"body":      it.Body,
	}
	if it.Difficulty != nil {
		doc["difficulty"] = string(*it.Difficulty)
	} else {
		doc["difficulty"] = nil
	}
	if it.Type == domain.TypeProblem {
		p := it.Problem
		if p == nil {
			p = &Problem{}
		}
		starter := map[string]any{}
		for k, v := range p.StarterCode {
			starter[k] = v
		}
		prob := map[string]any{
			"timeLimitMs":   int64(p.TimeLimitMs),
			"memoryLimitKb": int64(p.MemoryLimitKb),
			"compare":       string(p.Compare),
			"starterCode":   starter,
		}
		// Format version 2: a solution-only problem adds its interface and
		// harness. A program problem hashes exactly as in version 1, so the
		// hashes of existing bundles stay valid.
		if p.Interface == domain.InterfaceFunction {
			harness := map[string]any{}
			for k, h := range p.Harness {
				harness[k] = map[string]any{"prefix": h.Prefix, "suffix": h.Suffix}
			}
			prob["interface"] = string(domain.InterfaceFunction)
			prob["harness"] = harness
		}
		doc["problem"] = prob
		// Solutions left out of the export are left out of the hash; a
		// problem without solutions hashes an empty list.
		if it.SolutionsIncluded {
			sols := make([]any, len(it.Solutions))
			for i, s := range it.Solutions {
				sols[i] = map[string]any{"name": s.Name, "language": s.Language, "source": s.Source,
					"notes": s.Notes, "isReference": s.IsReference}
			}
			doc["solutions"] = sols
		}
		cases := make([]any, len(it.TestCases))
		for i, tc := range it.TestCases {
			cases[i] = map[string]any{
				"name": tc.Name, "stdin": tc.Stdin, "expectedStdout": tc.ExpectedStdout, "isSample": tc.IsSample,
			}
		}
		doc["testCases"] = cases
	}
	sum := sha256.Sum256(Canonical(doc))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func strOrNil(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// Slug turns a title into a short, filesystem-friendly name.
func Slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		default:
			if !dash && b.Len() > 0 {
				b.WriteByte('-')
				dash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 40 {
		out = out[:40]
		if i := strings.LastIndexByte(out, '-'); i > 0 {
			out = out[:i]
		}
	}
	if out == "" {
		return "item"
	}
	return out
}

// Changes lists the content fields in which b differs from a, in the order
// type, title, summary, body, difficulty, tags, source, variantOf, limits, compare,
// starterCode, interface, harness, solutions, testCases. Both items should cover the
// same scope (see FromDomain), so that only what a bundle carries is
// compared.
func Changes(a, b *Item) []string {
	out := []string{}
	add := func(cond bool, name string) {
		if cond {
			out = append(out, name)
		}
	}
	add(a.Type != b.Type, "type")
	add(a.Title != b.Title, "title")
	add(a.Summary != b.Summary, "summary")
	add(a.Body != b.Body, "body")
	add(!eqPtr(a.Difficulty, b.Difficulty), "difficulty")
	ta, tb := slices.Clone(a.Tags), slices.Clone(b.Tags)
	slices.Sort(ta)
	slices.Sort(tb)
	add(!slices.Equal(ta, tb), "tags")
	add(!eqPtr(a.Source.URL, b.Source.URL) || !eqPtr(a.Source.Note, b.Source.Note), "source")
	add(!eqPtr(a.VariantOf, b.VariantOf), "variantOf")
	pa, pb := a.Problem, b.Problem
	if pa == nil {
		pa = &Problem{}
	}
	if pb == nil {
		pb = &Problem{}
	}
	add(pa.TimeLimitMs != pb.TimeLimitMs || pa.MemoryLimitKb != pb.MemoryLimitKb, "limits")
	add(pa.Compare != pb.Compare, "compare")
	add(!maps.Equal(nonNil(pa.StarterCode), nonNil(pb.StarterCode)), "starterCode")
	add(interfaceOf(pa) != interfaceOf(pb), "interface")
	add(!maps.Equal(harnessOf(pa), harnessOf(pb)), "harness")
	add(a.SolutionsIncluded != b.SolutionsIncluded || !slices.Equal(a.Solutions, b.Solutions), "solutions")
	add(!slices.EqualFunc(a.TestCases, b.TestCases, func(x, y TestCase) bool {
		return x.Name == y.Name && x.Stdin == y.Stdin && x.ExpectedStdout == y.ExpectedStdout && x.IsSample == y.IsSample
	}), "testCases")
	return out
}

func interfaceOf(p *Problem) domain.ProblemInterface {
	if p.Interface == domain.InterfaceFunction {
		return p.Interface
	}
	return domain.InterfaceProgram
}

// harnessOf is the harness that counts: none for a program problem.
func harnessOf(p *Problem) map[string]domain.HarnessCode {
	if p.Interface != domain.InterfaceFunction || p.Harness == nil {
		return map[string]domain.HarnessCode{}
	}
	return p.Harness
}

func nonNil(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func eqPtr[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
