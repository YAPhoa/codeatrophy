package domain

import (
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Defaults and bounds for item fields.
const (
	DefaultTimeLimitMs   = 2000
	DefaultMemoryLimitKb = 262144
	MinTimeLimitMs       = 100
	MaxTimeLimitMs       = 30000
	MinMemoryLimitKb     = 16384
	MaxMemoryLimitKb     = 2097152
	MaxTitleChars        = 200
	MaxTags              = 30
	MaxTagChars          = 40
	MaxSummaryChars      = 5000
	MaxTextBytes         = 1 << 20 // body, notes, raw input
	MaxURLChars          = 2048
	MaxSourceNoteChars   = 2000
	// DefaultMaxNotesChars is the default bound, in characters, on an
	// item's notes; MaxNotesCharsCeiling is the highest an instance may set
	// it to (it stays well inside MaxTextBytes).
	DefaultMaxNotesChars = 4000
	MaxNotesCharsCeiling = 100000
)

// Limits are the instance-configurable size limits.
type Limits struct {
	MaxImportBytes int64
	MaxSourceBytes int
	// MaxNotesChars bounds an item's notes, in characters. It is checked
	// only when the notes are written (see ValidateNotes).
	MaxNotesChars int
}

// Source attributes an item to where it came from.
type Source struct {
	URL  *string `json:"url"`
	Note *string `json:"note"`
}

// Solution is a program in a given language. As problem.referenceSolution
// it is a view of the saved solution marked as reference, and carries that
// solution's id; elsewhere the id is empty and omitted.
type Solution struct {
	ID       string `json:"id,omitempty"`
	Language string `json:"language"`
	Source   string `json:"source"`
}

// HarnessCode is the hidden code of one language of a function problem:
// the program that runs is the prefix, the submitted source and the suffix
// (see package harness).
type HarnessCode struct {
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

// ProblemSpec holds the fields only problems have.
type ProblemSpec struct {
	Interface     ProblemInterface  `json:"interface"`
	TimeLimitMs   int               `json:"timeLimitMs"`
	MemoryLimitKb int               `json:"memoryLimitKb"`
	Compare       CompareMode       `json:"compare"`
	StarterCode   map[string]string `json:"starterCode"`
	// Harness is keyed by language id; empty for a program problem.
	Harness           map[string]HarnessCode `json:"harness"`
	ReferenceSolution *Solution              `json:"referenceSolution"`
}

// HarnessFor returns the harness a solution in lang runs in: nil for a
// program problem; for a function problem, the language's entry and
// whether there is one.
func (p *ProblemSpec) HarnessFor(lang string) (*HarnessCode, bool) {
	if p == nil || p.Interface != InterfaceFunction {
		return nil, true
	}
	h, ok := p.Harness[lang]
	if !ok {
		return nil, false
	}
	return &h, true
}

// DefaultProblemSpec returns the defaults for a new problem.
func DefaultProblemSpec() *ProblemSpec {
	return &ProblemSpec{
		Interface:     InterfaceProgram,
		TimeLimitMs:   DefaultTimeLimitMs,
		MemoryLimitKb: DefaultMemoryLimitKb,
		Compare:       CompareTokens,
		StarterCode:   map[string]string{},
		Harness:       map[string]HarnessCode{},
	}
}

// ItemSummary is the list representation of an item.
type ItemSummary struct {
	ID            string      `json:"id"`
	Type          ItemType    `json:"type"`
	Title         string      `json:"title"`
	Summary       string      `json:"summary"`
	Difficulty    *Difficulty `json:"difficulty"`
	Tags          []string    `json:"tags"`
	Status        ItemStatus  `json:"status"`
	Favorite      bool        `json:"favorite"`
	CollectionIDs []string    `json:"collectionIds"`
	VariantOf     *string     `json:"variantOf"`
	VariantCount  int         `json:"variantCount"`
	LinkCount     int         `json:"linkCount"`
	TestCaseCount int         `json:"testCaseCount"`
	SolutionCount int         `json:"solutionCount"`
	LastVerdict   *Verdict    `json:"lastVerdict"`
	Revision      int         `json:"revision"`
	CreatedAt     time.Time   `json:"createdAt"`
	UpdatedAt     time.Time   `json:"updatedAt"`
}

// Item is the full representation of an item.
type Item struct {
	ItemSummary
	Body     string       `json:"body"`
	Notes    string       `json:"notes"`
	RawInput *string      `json:"rawInput"`
	Source   Source       `json:"source"`
	Problem  *ProblemSpec `json:"problem"`
	// VariantOrigin describes the item VariantOf names, nil when it is
	// nil. It is filled on read and ignored on write.
	VariantOrigin *LinkedItem `json:"variantOrigin"`
}

// Normalize replaces nil slices and maps with empty ones so that they encode
// as [] and {}.
func (s *ItemSummary) Normalize() {
	if s.Tags == nil {
		s.Tags = []string{}
	}
	if s.CollectionIDs == nil {
		s.CollectionIDs = []string{}
	}
}

// Normalize replaces nil slices and maps with empty ones.
func (it *Item) Normalize() {
	it.ItemSummary.Normalize()
	if p := it.Problem; p != nil {
		if p.StarterCode == nil {
			p.StarterCode = map[string]string{}
		}
		if p.Harness == nil {
			p.Harness = map[string]HarnessCode{}
		}
		if p.Interface == "" {
			p.Interface = InterfaceProgram
		}
	}
}

// Clone returns a deep copy of the item.
func (it Item) Clone() Item {
	c := it
	c.Tags = slices.Clone(it.Tags)
	c.CollectionIDs = slices.Clone(it.CollectionIDs)
	c.Difficulty = clonePtr(it.Difficulty)
	c.VariantOf = clonePtr(it.VariantOf)
	c.VariantOrigin = clonePtr(it.VariantOrigin)
	c.LastVerdict = clonePtr(it.LastVerdict)
	c.RawInput = clonePtr(it.RawInput)
	c.Source = Source{URL: clonePtr(it.Source.URL), Note: clonePtr(it.Source.Note)}
	if it.Problem != nil {
		p := *it.Problem
		p.StarterCode = maps.Clone(it.Problem.StarterCode)
		p.Harness = maps.Clone(it.Problem.Harness)
		p.ReferenceSolution = clonePtr(it.Problem.ReferenceSolution)
		c.Problem = &p
	}
	return c
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// SourcePatch is a partial Source.
type SourcePatch struct {
	URL  Opt[string] `json:"url"`
	Note Opt[string] `json:"note"`
}

// ProblemPatch is a partial ProblemSpec.
type ProblemPatch struct {
	Interface         Opt[ProblemInterface]       `json:"interface"`
	TimeLimitMs       Opt[int]                    `json:"timeLimitMs"`
	MemoryLimitKb     Opt[int]                    `json:"memoryLimitKb"`
	Compare           Opt[CompareMode]            `json:"compare"`
	StarterCode       Opt[map[string]string]      `json:"starterCode"`
	Harness           Opt[map[string]HarnessCode] `json:"harness"`
	ReferenceSolution Opt[Solution]               `json:"referenceSolution"`
}

// ItemInput is the body of item create and update requests. Every field is
// optional; on create, omitted fields take their defaults.
type ItemInput struct {
	Type             Opt[ItemType]        `json:"type"`
	Title            Opt[string]          `json:"title"`
	Summary          Opt[string]          `json:"summary"`
	Body             Opt[string]          `json:"body"`
	Difficulty       Opt[Difficulty]      `json:"difficulty"`
	Tags             Opt[[]string]        `json:"tags"`
	Status           Opt[ItemStatus]      `json:"status"`
	Favorite         Opt[bool]            `json:"favorite"`
	Notes            Opt[string]          `json:"notes"`
	RawInput         Opt[string]          `json:"rawInput"`
	Source           Opt[SourcePatch]     `json:"source"`
	Problem          Opt[ProblemPatch]    `json:"problem"`
	CollectionIDs    Opt[[]string]        `json:"collectionIds"`
	VariantOf        Opt[string]          `json:"variantOf"`
	TestCases        Opt[[]TestCaseInput] `json:"testCases"`
	ExpectedRevision Opt[int]             `json:"expectedRevision"`
}

// FieldErrors maps a field path to a validation message.
type FieldErrors map[string]string

// Add records an error for a field unless one is already recorded.
func (f FieldErrors) Add(field, msg string) {
	if _, ok := f[field]; !ok {
		f[field] = msg
	}
}

// Merge adds all errors from other, prefixing their keys.
func (f FieldErrors) Merge(prefix string, other FieldErrors) {
	for k, v := range other {
		f.Add(prefix+k, v)
	}
}

// First returns a deterministic, readable summary of the errors: the first
// field in order as "field: message", followed by how many more there are.
func (f FieldErrors) First() string {
	keys := make([]string, 0, len(f))
	for k := range f {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	switch len(keys) {
	case 0:
		return "invalid input"
	case 1:
		return keys[0] + ": " + f[keys[0]]
	case 2:
		return keys[0] + ": " + f[keys[0]] + " (and 1 more problem)"
	}
	return fmt.Sprintf("%s: %s (and %d more problems)", keys[0], f[keys[0]], len(keys)-1)
}

// ApplyItemInput merges in onto it (merge semantics). It does not handle
// collectionIds, testCases or expectedRevision, and does not check that
// variantOf exists; those need the store. Null for a non-nullable field is reported as an error.
func ApplyItemInput(it *Item, in ItemInput) FieldErrors {
	errs := FieldErrors{}
	str := func(name string, o Opt[string], dst *string) {
		if !o.Set {
			return
		}
		if o.Null {
			errs.Add(name, "cannot be null")
			return
		}
		*dst = o.Val
	}
	str("title", in.Title, &it.Title)
	str("summary", in.Summary, &it.Summary)
	str("body", in.Body, &it.Body)
	str("notes", in.Notes, &it.Notes)
	if in.Difficulty.Set {
		it.Difficulty = in.Difficulty.Ptr()
	}
	if in.Tags.Set {
		if in.Tags.Null {
			errs.Add("tags", "cannot be null")
		} else {
			it.Tags = slices.Clone(in.Tags.Val)
		}
	}
	if in.Status.Set {
		if in.Status.Null {
			errs.Add("status", "cannot be null")
		} else {
			it.Status = in.Status.Val
		}
	}
	if in.Favorite.Set {
		if in.Favorite.Null {
			errs.Add("favorite", "cannot be null")
		} else {
			it.Favorite = in.Favorite.Val
		}
	}
	if in.RawInput.Set {
		it.RawInput = in.RawInput.Ptr()
	}
	if in.VariantOf.Set {
		it.VariantOf = in.VariantOf.Ptr()
	}
	if in.Source.Set {
		if in.Source.Null {
			it.Source = Source{}
		} else {
			if in.Source.Val.URL.Set {
				it.Source.URL = in.Source.Val.URL.Ptr()
			}
			if in.Source.Val.Note.Set {
				it.Source.Note = in.Source.Val.Note.Ptr()
			}
		}
	}
	if it.Type == TypeProblem && in.Problem.Set {
		if in.Problem.Null {
			errs.Add("problem", "cannot be null for a problem")
		} else {
			if it.Problem == nil {
				it.Problem = DefaultProblemSpec()
			}
			p := in.Problem.Val
			intField := func(name string, o Opt[int], dst *int) {
				if !o.Set {
					return
				}
				if o.Null {
					errs.Add("problem."+name, "cannot be null")
					return
				}
				*dst = o.Val
			}
			intField("timeLimitMs", p.TimeLimitMs, &it.Problem.TimeLimitMs)
			intField("memoryLimitKb", p.MemoryLimitKb, &it.Problem.MemoryLimitKb)
			if p.Compare.Set {
				if p.Compare.Null {
					errs.Add("problem.compare", "cannot be null")
				} else {
					it.Problem.Compare = p.Compare.Val
				}
			}
			if p.Interface.Set {
				if p.Interface.Null {
					errs.Add("problem.interface", "cannot be null")
				} else {
					it.Problem.Interface = p.Interface.Val
				}
			}
			if p.Harness.Set {
				// Like starterCode: null clears it, a value replaces it.
				it.Problem.Harness = maps.Clone(p.Harness.Val)
				if it.Problem.Harness == nil {
					it.Problem.Harness = map[string]HarnessCode{}
				}
			}
			if p.StarterCode.Set {
				if p.StarterCode.Null {
					it.Problem.StarterCode = map[string]string{}
				} else {
					m := make(map[string]string, len(p.StarterCode.Val))
					for k, v := range p.StarterCode.Val {
						m[k] = v
					}
					it.Problem.StarterCode = m
				}
			}
			if p.ReferenceSolution.Set {
				it.Problem.ReferenceSolution = p.ReferenceSolution.Ptr()
			}
		}
	}
	return errs
}

// NormalizeText converts \r\n and lone \r line endings to \n. Every text
// field goes through it except test-case stdin and expected output, which
// are kept byte for byte.
func NormalizeText(s string) string {
	if !strings.ContainsRune(s, '\r') {
		return s
	}
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
}

func normalizePtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := NormalizeText(*p)
	return &v
}

// NormalizeTag lower-cases and trims a tag.
func NormalizeTag(t string) string { return strings.ToLower(strings.TrimSpace(NormalizeText(t))) }

// NormalizeTags lower-cases, trims, de-duplicates and sorts tags. Empty tags
// are dropped.
func NormalizeTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	for _, t := range tags {
		t = NormalizeTag(t)
		if t != "" {
			out = append(out, t)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// ValidateTag checks a single normalized tag. Tags may not contain "/" or
// control characters.
func ValidateTag(t string) string {
	n := utf8.RuneCountInString(t)
	if n < 1 || n > MaxTagChars {
		return fmt.Sprintf("must be 1-%d characters", MaxTagChars)
	}
	if strings.ContainsRune(t, '/') || !IsSingleLine(t) {
		return "must be a single line without / or control characters"
	}
	return ""
}

// NormalizeItem trims and normalizes fields in place before validation.
func NormalizeItem(it *Item) {
	it.Title = strings.TrimSpace(NormalizeText(it.Title))
	it.Summary = NormalizeText(it.Summary)
	it.Body = NormalizeText(it.Body)
	it.Notes = NormalizeText(it.Notes)
	it.RawInput = normalizePtr(it.RawInput)
	it.Source.URL = normalizePtr(it.Source.URL)
	it.Source.Note = normalizePtr(it.Source.Note)
	if it.Problem != nil {
		for k, v := range it.Problem.StarterCode {
			it.Problem.StarterCode[k] = NormalizeText(v)
		}
		for k, h := range it.Problem.Harness {
			it.Problem.Harness[k] = HarnessCode{Prefix: NormalizeText(h.Prefix), Suffix: NormalizeText(h.Suffix)}
		}
		if rs := it.Problem.ReferenceSolution; rs != nil {
			rs.Source = NormalizeText(rs.Source)
		}
	}
	it.Tags = NormalizeTags(it.Tags)
	it.Source.URL = trimPtr(it.Source.URL)
	it.Source.Note = trimPtr(it.Source.Note)
	if it.Type == TypeReading {
		it.Problem = nil
	}
	it.Normalize()
}

func trimPtr(p *string) *string {
	if p == nil {
		return nil
	}
	s := strings.TrimSpace(*p)
	if s == "" {
		return nil
	}
	return &s
}

// ValidateItem checks an item's content and personal state.
func ValidateItem(it *Item, lim Limits) FieldErrors {
	errs := FieldErrors{}
	if !it.Type.Valid() {
		errs.Add("type", "must be problem or reading")
	}
	if n := utf8.RuneCountInString(it.Title); n < 1 || n > MaxTitleChars {
		if n == 0 {
			errs.Add("title", "is required")
		} else {
			errs.Add("title", fmt.Sprintf("must be at most %d characters", MaxTitleChars))
		}
	} else if !IsSingleLine(it.Title) {
		errs.Add("title", SingleLineMessage)
	}
	if utf8.RuneCountInString(it.Summary) > MaxSummaryChars {
		errs.Add("summary", fmt.Sprintf("must be at most %d characters", MaxSummaryChars))
	}
	if len(it.Body) > MaxTextBytes {
		errs.Add("body", "is too long")
	}
	if len(it.Notes) > MaxTextBytes {
		errs.Add("notes", "is too long")
	}
	if it.RawInput != nil && len(*it.RawInput) > MaxTextBytes {
		errs.Add("rawInput", "is too long")
	}
	if it.Difficulty != nil && !it.Difficulty.Valid() {
		errs.Add("difficulty", "must be easy, medium, hard or null")
	}
	if !it.Status.Valid() {
		errs.Add("status", "must be todo, in_progress or done")
	}
	if len(it.Tags) > MaxTags {
		errs.Add("tags", fmt.Sprintf("must have at most %d tags", MaxTags))
	}
	for _, t := range it.Tags {
		if msg := ValidateTag(t); msg != "" {
			errs.Add("tags", fmt.Sprintf("tag %q %s", t, msg))
		}
	}
	if it.Source.URL != nil {
		if msg := ValidateURL(*it.Source.URL); msg != "" {
			errs.Add("source.url", msg)
		}
	}
	if it.Source.Note != nil && utf8.RuneCountInString(*it.Source.Note) > MaxSourceNoteChars {
		errs.Add("source.note", "is too long")
	}
	if it.Type == TypeProblem {
		if it.Problem == nil {
			errs.Add("problem", "is required for a problem")
		} else {
			errs.Merge("problem.", ValidateProblem(it.Problem, lim))
		}
	}
	return errs
}

// ValidateNotes checks an item's notes, already normalized, against the
// instance's notes limit, counting characters (code points) as stored. It is
// checked only when the notes change, so notes written under a higher limit
// stay readable and editable in other fields; ValidateItem checks only their
// size in bytes.
func ValidateNotes(notes string, lim Limits) string {
	if lim.MaxNotesChars > 0 && utf8.RuneCountInString(notes) > lim.MaxNotesChars {
		return fmt.Sprintf("must be at most %d characters", lim.MaxNotesChars)
	}
	return ""
}

// ValidateURL checks an absolute http(s) URL.
func ValidateURL(s string) string {
	if utf8.RuneCountInString(s) > MaxURLChars {
		return "is too long"
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "must be an absolute http or https URL"
	}
	return ""
}

// ValidateProblem checks problem-specific fields.
func ValidateProblem(p *ProblemSpec, lim Limits) FieldErrors {
	errs := FieldErrors{}
	if p.TimeLimitMs < MinTimeLimitMs || p.TimeLimitMs > MaxTimeLimitMs {
		errs.Add("timeLimitMs", fmt.Sprintf("must be between %d and %d", MinTimeLimitMs, MaxTimeLimitMs))
	}
	if p.MemoryLimitKb < MinMemoryLimitKb || p.MemoryLimitKb > MaxMemoryLimitKb {
		errs.Add("memoryLimitKb", fmt.Sprintf("must be between %d and %d", MinMemoryLimitKb, MaxMemoryLimitKb))
	}
	if !p.Compare.Valid() {
		errs.Add("compare", "must be tokens or exact")
	}
	if !p.Interface.Valid() {
		errs.Add("interface", "must be program or function")
	}
	if p.Interface == InterfaceProgram && len(p.Harness) > 0 {
		errs.Add("harness", "must be {} for a program problem (send harness: {} with interface: program to discard the runner code)")
	}
	for lang, h := range p.Harness {
		if !KnownLanguage(lang) {
			errs.Add("harness."+lang, "unknown language")
			continue
		}
		if lim.MaxSourceBytes > 0 && len(h.Prefix) > lim.MaxSourceBytes {
			errs.Add("harness."+lang+".prefix", fmt.Sprintf("must be at most %d bytes", lim.MaxSourceBytes))
		}
		if lim.MaxSourceBytes > 0 && len(h.Suffix) > lim.MaxSourceBytes {
			errs.Add("harness."+lang+".suffix", fmt.Sprintf("must be at most %d bytes", lim.MaxSourceBytes))
		}
	}
	for lang, src := range p.StarterCode {
		if !KnownLanguage(lang) {
			errs.Add("starterCode."+lang, "unknown language")
			continue
		}
		if lim.MaxSourceBytes > 0 && len(src) > lim.MaxSourceBytes {
			errs.Add("starterCode."+lang, fmt.Sprintf("must be at most %d bytes", lim.MaxSourceBytes))
		}
	}
	if s := p.ReferenceSolution; s != nil {
		errs.Merge("referenceSolution.", ValidateSolution(*s, lim))
	}
	return errs
}

// ValidateSolution checks a {language, source} pair.
func ValidateSolution(s Solution, lim Limits) FieldErrors {
	errs := FieldErrors{}
	if !KnownLanguage(s.Language) {
		errs.Add("language", "unknown language")
	}
	if strings.TrimSpace(s.Source) == "" {
		errs.Add("source", "is required")
	} else if lim.MaxSourceBytes > 0 && len(s.Source) > lim.MaxSourceBytes {
		errs.Add("source", fmt.Sprintf("must be at most %d bytes", lim.MaxSourceBytes))
	}
	return errs
}

// ContentEqual reports whether two items have the same content, i.e. the
// fields whose change increases the revision: title, summary, body,
// difficulty, tags, source, variantOf and everything under problem.
func ContentEqual(a, b *Item) bool {
	if a.Type != b.Type || a.Title != b.Title || a.Summary != b.Summary || a.Body != b.Body {
		return false
	}
	if !ptrEq(a.Difficulty, b.Difficulty) || !ptrEq(a.VariantOf, b.VariantOf) {
		return false
	}
	if !ptrEq(a.Source.URL, b.Source.URL) || !ptrEq(a.Source.Note, b.Source.Note) {
		return false
	}
	if !slices.Equal(a.Tags, b.Tags) {
		return false
	}
	if (a.Problem == nil) != (b.Problem == nil) {
		return false
	}
	if a.Problem != nil {
		p, q := a.Problem, b.Problem
		if p.TimeLimitMs != q.TimeLimitMs || p.MemoryLimitKb != q.MemoryLimitKb || p.Compare != q.Compare ||
			p.Interface != q.Interface {
			return false
		}
		if !maps.Equal(p.StarterCode, q.StarterCode) || !maps.Equal(p.Harness, q.Harness) {
			return false
		}
		if !RefEqual(p.ReferenceSolution, q.ReferenceSolution) {
			return false
		}
	}
	return true
}

// PersonalEqual reports whether two items have the same personal state and
// raw input, the fields that change neither the revision nor updatedAt.
func PersonalEqual(a, b *Item) bool {
	return a.Status == b.Status && a.Favorite == b.Favorite && a.Notes == b.Notes && ptrEq(a.RawInput, b.RawInput)
}

func ptrEq[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
