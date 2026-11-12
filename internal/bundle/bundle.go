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

	"codeathropy/internal/domain"
)

// Format identification.
const (
	FormatName    = "codeathropy.bundle"
	FormatVersion = 1
)

// Meta describes a bundle as a whole.
type Meta struct {
	Name             string
	Description      string
	Author           string
	FormatVersion    int
	CreatedAt        time.Time
	GeneratorName    string
	GeneratorVersion string
}

// TestCase is a test case as carried by a bundle.
type TestCase struct {
	Name           string
	Stdin          string
	ExpectedStdout string
	IsSample       bool
	Origin         domain.TestOrigin
	Verified       bool
}

// Problem holds the problem-only fields of a bundle item.
type Problem struct {
	TimeLimitMs       int
	MemoryLimitKb     int
	Compare           domain.CompareMode
	StarterCode       map[string]string
	ReferenceSolution *domain.Solution
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
	CreatedAt  time.Time
	UpdatedAt  time.Time
	Body       string
	Problem    *Problem
	TestCases  []TestCase

	// StoredHash is the contentHash found in bundle.json (read side only).
	StoredHash string
	// Dir is the item's directory inside the bundle.
	Dir string
}

// HasSolution reports whether the item carries a reference solution.
func (it *Item) HasSolution() bool { return it.Problem != nil && it.Problem.ReferenceSolution != nil }

// SamplesOnly reports whether the item carries no hidden test cases.
func (it *Item) SamplesOnly() bool {
	for _, tc := range it.TestCases {
		if !tc.IsSample {
			return false
		}
	}
	return true
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

// FromDomain converts a library item and its test cases into bundle form.
// includeSolution and includeHidden select what is carried, as for an
// export; they are also used to compute a local item's hash over the same
// fields a bundle item contains.
func FromDomain(it domain.Item, cases []domain.TestCase, includeSolution, includeHidden bool) Item {
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
		}
		for k, v := range it.Problem.StarterCode {
			p.StarterCode[k] = v
		}
		if includeSolution && it.Problem.ReferenceSolution != nil {
			s := *it.Problem.ReferenceSolution
			p.ReferenceSolution = &s
		}
		out.Problem = p
		for _, tc := range cases {
			if !includeHidden && !tc.IsSample {
				continue
			}
			out.TestCases = append(out.TestCases, TestCase{
				Name: tc.Name, Stdin: tc.Stdin, ExpectedStdout: tc.ExpectedStdout,
				IsSample: tc.IsSample, Origin: tc.Origin, Verified: tc.Verified,
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
		var ref any
		if p.ReferenceSolution != nil {
			ref = map[string]any{"language": p.ReferenceSolution.Language, "source": p.ReferenceSolution.Source}
		}
		doc["problem"] = map[string]any{
			"timeLimitMs":       int64(p.TimeLimitMs),
			"memoryLimitKb":     int64(p.MemoryLimitKb),
			"compare":           string(p.Compare),
			"starterCode":       starter,
			"referenceSolution": ref,
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
// title, summary, body, difficulty, tags, source, variantOf, limits, compare,
// starterCode, referenceSolution, testCases. Both items should cover the
// same scope (see FromDomain), so that only what a bundle carries is
// compared.
func Changes(a, b *Item) []string {
	out := []string{}
	add := func(cond bool, name string) {
		if cond {
			out = append(out, name)
		}
	}
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
	add(!eqPtr(pa.ReferenceSolution, pb.ReferenceSolution), "referenceSolution")
	add(!slices.EqualFunc(a.TestCases, b.TestCases, func(x, y TestCase) bool {
		return x.Name == y.Name && x.Stdin == y.Stdin && x.ExpectedStdout == y.ExpectedStdout && x.IsSample == y.IsSample
	}), "testCases")
	return out
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
