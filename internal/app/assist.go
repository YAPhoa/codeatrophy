package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/judge"
)

// Input bounds for AI requests.
const (
	MaxDraftTextChars     = 50000
	MaxGeneratedCases     = 30
	DefaultGeneratedCases = 8
)

// DraftProblem is the problem part of a draft.
type DraftProblem struct {
	Interface     domain.ProblemInterface       `json:"interface"`
	TimeLimitMs   int                           `json:"timeLimitMs"`
	MemoryLimitKb int                           `json:"memoryLimitKb"`
	Compare       domain.CompareMode            `json:"compare"`
	StarterCode   map[string]string             `json:"starterCode"`
	Harness       map[string]domain.HarnessCode `json:"harness"`
	// ReferenceSolution is the model's own solution (for a function problem
	// the solution part only), or nil.
	ReferenceSolution *domain.Solution `json:"referenceSolution"`
}

// spec is the problem as it would be saved, for running code against it.
func (p *DraftProblem) spec() *domain.ProblemSpec {
	return &domain.ProblemSpec{Interface: p.Interface, TimeLimitMs: p.TimeLimitMs, MemoryLimitKb: p.MemoryLimitKb,
		Compare: p.Compare, StarterCode: p.StarterCode, Harness: p.Harness}
}

// DraftTestCase is a test case of a draft.
type DraftTestCase struct {
	Name           string `json:"name"`
	Stdin          string `json:"stdin"`
	ExpectedStdout string `json:"expectedStdout"`
	IsSample       bool   `json:"isSample"`
	// Verified is true when the draft's reference solution printed the
	// expected output.
	Verified bool `json:"verified"`
	// outcome is what the check found for this case (see CaseOutcome).
	outcome CaseOutcome
}

// CaseOutcome is what a check found for one test case: passed, wrong,
// failed (the reference solution did not compile, crashed or exceeded a
// limit) or not_run (the check did not get to it), with the reason for the
// last two.
type CaseOutcome struct {
	Outcome string  `json:"outcome"`
	Error   *string `json:"error"`
}

func outcome(o, msg string) CaseOutcome {
	if msg == "" {
		return CaseOutcome{Outcome: o}
	}
	return CaseOutcome{Outcome: o, Error: &msg}
}

// setOutcomes gives every case of d the same outcome.
func setOutcomes(d *ItemDraft, o, msg string) {
	for i := range d.TestCases {
		d.TestCases[i].outcome = outcome(o, msg)
	}
}

// DraftCheck summarises running a draft's reference solution on its test
// cases, and its starter code in each harness.
type DraftCheck struct {
	Attempted bool          `json:"attempted"`
	Engine    *string       `json:"engine"`
	Passed    int           `json:"passed"`
	Total     int           `json:"total"`
	Error     *string       `json:"error"`
	Runners   []RunnerCheck `json:"runners"`
	// LargeCases has one report per large test case asked for.
	LargeCases []*LargeCaseReport `json:"largeCases"`
}

// ItemDraft is a proposed item, mapping onto ItemInput.
type ItemDraft struct {
	Type        domain.ItemType    `json:"type"`
	Title       string             `json:"title"`
	Summary     string             `json:"summary"`
	Body        string             `json:"body"`
	Difficulty  *domain.Difficulty `json:"difficulty"`
	Tags        []string           `json:"tags"`
	Problem     *DraftProblem      `json:"problem"`
	TestCases   []DraftTestCase    `json:"testCases"`
	Assumptions []string           `json:"assumptions"`
}

// DraftResponse is the result of a draft or variant request.
type DraftResponse struct {
	Draft ItemDraft        `json:"draft"`
	Style *domain.StyleRef `json:"style"`
	// Check is nil for a reading.
	Check *DraftCheck `json:"check"`
	Usage Usage       `json:"usage"`
}

// DraftInput is the request of a capture draft's generation.
type DraftInput struct {
	Text          string             `json:"text"`
	TypeHint      string             `json:"typeHint"`
	InterfaceHint string             `json:"interfaceHint"`
	Instruction   domain.Opt[string] `json:"instruction"`
	PreviousDraft json.RawMessage    `json:"previousDraft"`
	StyleID       domain.Opt[string] `json:"styleId"`
	// ProviderID names the provider to use instead of the default.
	ProviderID domain.Opt[string] `json:"providerId"`
	// LargeTestCases asks for that many large test cases as well.
	LargeTestCases int `json:"largeTestCases"`
}

func styleOf(p *domain.StylePreset) (*ai.Style, *domain.StyleRef) {
	if p == nil {
		return nil, nil
	}
	return &ai.Style{Name: p.Name, Instructions: p.Instructions}, &domain.StyleRef{ID: p.ID, Name: p.Name}
}

func checkInstruction(o domain.Opt[string]) (string, error) {
	if !o.HasValue() {
		return "", nil
	}
	s := strings.TrimSpace(domain.NormalizeText(o.Val))
	if msg := domain.ValidateGenerationInstruction(s); msg != "" {
		return "", errField("instruction", msg)
	}
	return s, nil
}

// Draft turns rough input into a complete item draft. Nothing is saved.
func (a *App) Draft(ctx context.Context, in DraftInput) (DraftResponse, error) {
	t, err := a.prepareDraft(ctx, in)
	if err != nil {
		return DraftResponse{}, err
	}
	return t.run(ctx)
}

// prepareDraft validates a draft request and resolves its style and
// provider; the generation itself is left to the task's run.
func (a *App) prepareDraft(ctx context.Context, in DraftInput) (task[DraftResponse], error) {
	type T = task[DraftResponse]
	fe := domain.FieldErrors{}
	// Line endings are normalized before counting, like every stored text.
	text := domain.NormalizeText(in.Text)
	if n := utf8.RuneCountInString(strings.TrimSpace(text)); n < 1 {
		fe.Add("text", "is required")
	} else if utf8.RuneCountInString(text) > MaxDraftTextChars {
		fe.Add("text", fmt.Sprintf("must be at most %d characters", MaxDraftTextChars))
	}
	hint := in.TypeHint
	if hint == "" {
		hint = "auto"
	}
	if hint != "auto" && hint != "problem" && hint != "reading" {
		fe.Add("typeHint", "must be auto, problem or reading")
	}
	iface := in.InterfaceHint
	if iface == "" {
		iface = "auto"
	}
	if iface != "auto" && !domain.ProblemInterface(iface).Valid() {
		fe.Add("interfaceHint", "must be auto, program or function")
	} else if iface != "auto" && hint == "reading" {
		fe.Add("interfaceHint", "does not apply to a reading")
	}
	instruction, err := checkInstruction(in.Instruction)
	if err != nil {
		return T{}, err
	}
	prev, msg := previousDraft(in.PreviousDraft)
	if msg != "" {
		fe.Add("previousDraft", msg)
	}
	if msg := validateLargeCount(in.LargeTestCases); msg != "" {
		fe.Add("largeTestCases", msg)
	}
	if err := errValidation(fe); err != nil {
		return T{}, err
	}
	preset, err := a.resolveStyle(ctx, in.StyleID)
	if err != nil {
		return T{}, err
	}
	provider, err := a.activeAI(ctx, in.ProviderID)
	if err != nil {
		return T{}, err
	}
	large := in.LargeTestCases
	if hint == "reading" {
		large = 0
	}
	run := func(ctx context.Context) (DraftResponse, error) {
		conventions, err := a.Conventions(ctx)
		if err != nil {
			return DraftResponse{}, err
		}
		style, ref := styleOf(preset)
		system, user := ai.DraftPrompt{Conventions: conventions, Style: style, Text: text, TypeHint: hint, InterfaceHint: iface, Instruction: instruction,
			PreviousDraft: prev, Toolchains: a.toolchains(ctx), Large: largeAsk(large)}.Build()
		var draft ItemDraft
		var gens []*ai.ModelLargeCase
		subject := &logSubject{}
		usage, err := a.generate(ctx, "draft", provider, subject, ai.GenerateRequest{
			System:     system,
			User:       user,
			Schema:     ai.DraftSchema(large),
			SchemaName: "item_draft",
		}, func(raw json.RawMessage) (err error) {
			if draft, gens, err = a.parseDraft(raw, hint, iface); err == nil {
				subject.Title = &draft.Title
			}
			return err
		})
		if err != nil {
			return DraftResponse{}, err
		}
		return DraftResponse{Draft: draft, Style: ref, Check: a.checkDraft(ctx, &draft, draftCheckBounds, large, gens), Usage: usage}, nil
	}
	// A draft is about the text until it has a title of its own.
	return T{title: jobTitle(text), run: run, retitle: func(r DraftResponse) string { return r.Draft.Title }}, nil
}

// previousDraft re-encodes an optional previous ItemDraft compactly for the
// prompt, or returns a validation message.
func previousDraft(raw json.RawMessage) (string, string) {
	p := bytes.TrimSpace(raw)
	if len(p) == 0 || bytes.Equal(p, []byte("null")) {
		return "", ""
	}
	var obj map[string]any
	if json.Unmarshal(p, &obj) != nil {
		return "", "must be an ItemDraft object"
	}
	// Large test data never goes into a prompt.
	elidePreviousDraft(obj)
	b, err := json.Marshal(obj)
	if err != nil {
		return "", "must be an ItemDraft object"
	}
	if len(b) > domain.MaxPreviousDraftBytes {
		return "", "is too large"
	}
	return domain.NormalizeText(string(b)), ""
}

// parseDraft decodes and normalizes a model draft. Recoverable problems are
// repaired (the draft is reviewed by the user before saving); structural
// problems are upstream errors. iface, unless "auto", is the interface a
// problem gets whatever the model chose.
// The generators of large test cases the model wrote are returned apart:
// they are not part of the draft.
func (a *App) parseDraft(raw json.RawMessage, hint, iface string) (ItemDraft, []*ai.ModelLargeCase, error) {
	d, m, err := a.decodeDraft(raw, hint, iface)
	if err != nil || d.Type != domain.TypeProblem {
		return d, nil, err
	}
	return d, m.LargeCases, nil
}

func (a *App) decodeDraft(raw json.RawMessage, hint, iface string) (ItemDraft, ai.ModelDraft, error) {
	var m ai.ModelDraft
	if err := json.Unmarshal(raw, &m); err != nil {
		return ItemDraft{}, m, &Error{Code: CodeUpstream, Message: "the AI provider returned a draft that does not match the schema"}
	}
	d := ItemDraft{Type: domain.ItemType(m.Type), Summary: strings.TrimSpace(m.Summary), Body: m.Body,
		Tags: []string{}, TestCases: []DraftTestCase{}, Assumptions: []string{}}
	if hint == "problem" || hint == "reading" {
		d.Type = domain.ItemType(hint)
	}
	if !d.Type.Valid() {
		if m.Problem != nil {
			d.Type = domain.TypeProblem
		} else {
			return ItemDraft{}, m, &Error{Code: CodeUpstream, Message: "the AI provider returned a draft without a valid type"}
		}
	}
	d.Title = truncateRunes(oneLine(m.Title), domain.MaxTitleChars)
	if d.Title == "" {
		return ItemDraft{}, m, &Error{Code: CodeUpstream, Message: "the AI provider returned a draft without a title"}
	}
	d.Summary = truncateRunes(d.Summary, domain.MaxSummaryChars)
	if len(d.Body) > domain.MaxTextBytes {
		return ItemDraft{}, m, &Error{Code: CodeUpstream, Message: "the AI provider returned a body that is too long"}
	}
	if m.Difficulty != nil {
		if diff := domain.Difficulty(*m.Difficulty); diff.Valid() {
			d.Difficulty = &diff
		}
	}
	suggested := make([]string, len(m.Tags))
	for i, t := range m.Tags {
		suggested[i] = hyphenateTag(t)
	}
	for _, t := range domain.NormalizeTags(suggested) {
		if domain.ValidateTag(t) == "" && len(d.Tags) < domain.MaxTags {
			d.Tags = append(d.Tags, t)
		}
	}
	for _, s := range m.Assumptions {
		if s = strings.TrimSpace(s); s != "" {
			d.Assumptions = append(d.Assumptions, s)
		}
	}
	if d.Type == domain.TypeProblem {
		p := &DraftProblem{Interface: domain.InterfaceProgram, TimeLimitMs: domain.DefaultTimeLimitMs,
			MemoryLimitKb: domain.DefaultMemoryLimitKb, Compare: domain.CompareTokens, StarterCode: map[string]string{},
			Harness: map[string]domain.HarnessCode{}}
		if mp := m.Problem; mp != nil {
			if f := domain.ProblemInterface(mp.Interface); f.Valid() {
				p.Interface = f
			}
			if mp.TimeLimitMs != 0 {
				p.TimeLimitMs = clamp(mp.TimeLimitMs, domain.MinTimeLimitMs, domain.MaxTimeLimitMs)
			}
			if mp.MemoryLimitKb != 0 {
				p.MemoryLimitKb = clamp(mp.MemoryLimitKb, domain.MinMemoryLimitKb, domain.MaxMemoryLimitKb)
			}
			if c := domain.CompareMode(mp.Compare); c.Valid() {
				p.Compare = c
			}
			for _, sc := range mp.StarterCode {
				if domain.KnownLanguage(sc.Language) && strings.TrimSpace(sc.Source) != "" && len(sc.Source) <= a.limits.MaxSourceBytes {
					p.StarterCode[sc.Language] = sc.Source
				}
			}
			for _, h := range mp.Harness {
				code := domain.HarnessCode{Prefix: domain.NormalizeText(h.Prefix), Suffix: domain.NormalizeText(h.Suffix)}
				if h.Language == "python" {
					code.Prefix = withFutureAnnotations(code.Prefix)
				}
				if domain.KnownLanguage(h.Language) && len(code.Prefix) <= a.limits.MaxSourceBytes &&
					len(code.Suffix) <= a.limits.MaxSourceBytes {
					p.Harness[h.Language] = code
				}
			}
			if rs := mp.ReferenceSolution; rs != nil {
				sol := domain.Solution{Language: rs.Language, Source: domain.NormalizeText(rs.Source)}
				if len(domain.ValidateSolution(sol, a.limits)) == 0 {
					p.ReferenceSolution = &sol
				}
			}
		}
		if iface != "auto" {
			p.Interface = domain.ProblemInterface(iface)
		}
		if p.Interface == domain.InterfaceProgram {
			p.Harness = map[string]domain.HarnessCode{}
		}
		d.Problem = p
		seen := map[string]bool{}
		for _, tc := range m.TestCases {
			if len(d.TestCases) >= MaxGeneratedCases {
				break
			}
			if len(tc.Stdin) > domain.MaxTestCaseBytes || len(tc.ExpectedStdout) > domain.MaxTestCaseBytes {
				continue
			}
			if key := sameInput(tc.Stdin); seen[key] {
				continue // the same input twice tests nothing new
			} else {
				seen[key] = true
			}
			d.TestCases = append(d.TestCases, DraftTestCase{Name: truncateRunes(tc.Name, domain.MaxTestCaseNameChars),
				Stdin: tc.Stdin, ExpectedStdout: tc.ExpectedStdout, IsSample: tc.IsSample})
		}
	}
	return d, m, nil
}

// oneLine joins a model-written single-line value onto one line.
func oneLine(s string) string {
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || !domain.IsSingleLine(string(r))
	}), " ")
}

func clamp(v, lo, hi int) int { return max(lo, min(v, hi)) }

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// futureAnnotations must be the first statement of a Python program whose
// solver code uses annotations such as list[int] on Python 3.8.
const futureAnnotations = "from __future__ import annotations"

// withFutureAnnotations puts the future import at the top of a Python
// harness prefix that lacks it. Models forget it, and then every annotated
// stub fails at import on the judge's Python 3.8. Placing it first is always
// valid: only a docstring, comments and other future imports may precede
// it, and all of them may follow it too.
func withFutureAnnotations(prefix string) string {
	for _, l := range strings.Split(prefix, "\n") {
		if l = strings.TrimSpace(l); strings.HasPrefix(l, "from __future__ import") && strings.Contains(l, "annotations") {
			return prefix
		}
	}
	return futureAnnotations + "\n" + prefix
}

// VariantInput is the request of a variant draft's generation.
type VariantInput struct {
	Mode           string             `json:"mode"`
	InterfaceHint  string             `json:"interfaceHint"`
	Instruction    domain.Opt[string] `json:"instruction"`
	PreviousDraft  json.RawMessage    `json:"previousDraft"`
	StyleID        domain.Opt[string] `json:"styleId"`
	ProviderID     domain.Opt[string] `json:"providerId"`
	LargeTestCases int                `json:"largeTestCases"`
}

// Variant drafts a new item derived from an existing one. Nothing is saved.
func (a *App) Variant(ctx context.Context, itemID string, in VariantInput) (DraftResponse, error) {
	t, err := a.prepareVariant(ctx, itemID, in)
	if err != nil {
		return DraftResponse{}, err
	}
	return t.run(ctx)
}

// prepareVariant validates a variant request and reads its original; the
// generation is left to the task's run.
func (a *App) prepareVariant(ctx context.Context, itemID string, in VariantInput) (task[DraftResponse], error) {
	type T = task[DraftResponse]
	mode := in.Mode
	if mode == "" {
		mode = "similar"
	}
	if _, ok := ai.VariantModes[mode]; !ok {
		return T{}, errField("mode", "must be similar, easier, harder or twist")
	}
	instruction, err := checkInstruction(in.Instruction)
	if err != nil {
		return T{}, err
	}
	prev, msg := previousDraft(in.PreviousDraft)
	if msg != "" {
		return T{}, errField("previousDraft", msg)
	}
	if msg := validateLargeCount(in.LargeTestCases); msg != "" {
		return T{}, errField("largeTestCases", msg)
	}
	it, err := a.GetItem(ctx, itemID)
	if err != nil {
		return T{}, err
	}
	if it.Type == domain.TypeReading && mode != "similar" {
		return T{}, errField("mode", "readings only support the similar mode")
	}
	// A variant keeps the original's interface unless asked for the other.
	iface := ""
	switch {
	case in.InterfaceHint != "" && it.Type == domain.TypeReading:
		return T{}, errField("interfaceHint", "does not apply to a reading")
	case in.InterfaceHint == "" || in.InterfaceHint == "auto":
		if it.Problem != nil {
			iface = string(it.Problem.Interface)
		}
	case !domain.ProblemInterface(in.InterfaceHint).Valid():
		return T{}, errField("interfaceHint", "must be auto, program or function")
	default:
		iface = in.InterfaceHint
	}
	var samples []map[string]any
	if it.Type == domain.TypeProblem {
		cases, err := a.ListTestCases(ctx, itemID)
		if err != nil {
			return T{}, err
		}
		for _, c := range cases.Items {
			if !c.IsSample || len(samples) >= 3 {
				continue
			}
			if isLargeData(c.Stdin, c.ExpectedStdout) {
				samples = append(samples, map[string]any{"name": c.Name, "omitted": largeCaseInfo(c.Stdin, c.ExpectedStdout)})
				continue
			}
			samples = append(samples, map[string]any{"stdin": c.Stdin, "expectedStdout": c.ExpectedStdout})
		}
	}
	preset, err := a.resolveStyle(ctx, in.StyleID)
	if err != nil {
		return T{}, err
	}
	provider, err := a.activeAI(ctx, in.ProviderID)
	if err != nil {
		return T{}, err
	}
	orig := map[string]any{
		"type": it.Type, "title": it.Title, "summary": it.Summary, "body": it.Body,
		"difficulty": it.Difficulty, "tags": it.Tags,
	}
	if it.Problem != nil {
		langs := make([]string, 0, len(it.Problem.StarterCode))
		for l := range it.Problem.StarterCode {
			langs = append(langs, l)
		}
		slices.Sort(langs)
		op := map[string]any{
			"interface": it.Problem.Interface, "timeLimitMs": it.Problem.TimeLimitMs,
			"memoryLimitKb": it.Problem.MemoryLimitKb, "compare": it.Problem.Compare, "starterLanguages": langs,
		}
		if it.Problem.Interface == domain.InterfaceFunction {
			// The stubs and runners show the conventions the original uses.
			op["starterCode"], op["harness"] = it.Problem.StarterCode, it.Problem.Harness
		}
		orig["problem"] = op
		orig["sampleTestCases"] = samples
	}
	origJSON, _ := json.MarshalIndent(orig, "", "  ")
	large := in.LargeTestCases
	if it.Type != domain.TypeProblem {
		large = 0
	}
	forced := iface
	if forced == "" {
		forced = "auto"
	}
	run := func(ctx context.Context) (DraftResponse, error) {
		conventions, err := a.Conventions(ctx)
		if err != nil {
			return DraftResponse{}, err
		}
		style, ref := styleOf(preset)
		system, user := ai.VariantPrompt{Conventions: conventions, Style: style, Original: string(origJSON), Mode: mode, Interface: iface,
			Instruction: instruction, PreviousDraft: prev, Toolchains: a.toolchains(ctx), Large: largeAsk(large)}.Build()
		var draft ItemDraft
		var gens []*ai.ModelLargeCase
		usage, err := a.generate(ctx, "variant", provider, &logSubject{ItemID: &it.ID, Title: &it.Title}, ai.GenerateRequest{
			System:     system,
			User:       user,
			Schema:     ai.DraftSchema(large),
			SchemaName: "item_draft",
		}, func(raw json.RawMessage) (err error) {
			draft, gens, err = a.parseDraft(raw, string(it.Type), forced)
			return err
		})
		if err != nil {
			return DraftResponse{}, err
		}
		return DraftResponse{Draft: draft, Style: ref, Check: a.checkDraft(ctx, &draft, draftCheckBounds, large, gens), Usage: usage}, nil
	}
	return T{itemID: &it.ID, title: it.Title, run: run}, nil
}

// GenerateTestCasesInput is the body of POST /items/{id}/ai/testcases.
type GenerateTestCasesInput struct {
	LargeTestCases int                `json:"largeTestCases"`
	Count          domain.Opt[int]    `json:"count"`
	Language       string             `json:"language"`
	Instruction    domain.Opt[string] `json:"instruction"`
	ProviderID     domain.Opt[string] `json:"providerId"`
}

// GeneratedCase is one proposed test case.
type GeneratedCase struct {
	Name            string  `json:"name"`
	Rationale       string  `json:"rationale"`
	Stdin           string  `json:"stdin"`
	ExpectedStdout  string  `json:"expectedStdout"`
	PredictedStdout *string `json:"predictedStdout"` // nil for a large case

	IsSample          bool    `json:"isSample"`
	Verified          bool    `json:"verified"`
	PredictionMatched *bool   `json:"predictionMatched"`
	Error             *string `json:"error"`
}

// Verification reports whether proposed cases were run.
type Verification struct {
	Attempted bool    `json:"attempted"`
	Engine    *string `json:"engine"`
	Error     *string `json:"error"`
}

// GenerateTestCasesResponse is the result of test-case generation.
type GenerateTestCasesResponse struct {
	ReferenceSolution domain.Solution `json:"referenceSolution"`
	Verification      Verification    `json:"verification"`
	// DuplicatesDropped counts proposed cases whose stdin the problem, or
	// an earlier proposal, already had.
	DuplicatesDropped int   `json:"duplicatesDropped"`
	Usage             Usage `json:"usage"`
	// LargeCases has one report per large test case asked for.
	LargeCases []*LargeCaseReport `json:"largeCases"`
	Cases      []GeneratedCase    `json:"cases"`
}

// GenerateTestCases asks the model for a reference solution and inputs, then
// runs the solution to compute the expected outputs when an engine is
// available. Nothing is saved. Style presets and the custom system prompt
// do not apply; a custom test case prompt does.
func (a *App) GenerateTestCases(ctx context.Context, itemID string, in GenerateTestCasesInput) (GenerateTestCasesResponse, error) {
	t, err := a.prepareTestCases(ctx, itemID, in)
	if err != nil {
		return GenerateTestCasesResponse{}, err
	}
	return t.run(ctx)
}

// prepareTestCases validates a test generation request and reads the
// problem; the generation is left to the task's run.
func (a *App) prepareTestCases(ctx context.Context, itemID string, in GenerateTestCasesInput) (task[GenerateTestCasesResponse], error) {
	type T = task[GenerateTestCasesResponse]
	count := DefaultGeneratedCases
	if in.Count.HasValue() {
		count = in.Count.Val
	}
	if count < 1 || count > MaxGeneratedCases {
		return T{}, errField("count", fmt.Sprintf("must be between 1 and %d", MaxGeneratedCases))
	}
	if msg := validateLargeCount(in.LargeTestCases); msg != "" {
		return T{}, errField("largeTestCases", msg)
	}
	lang := in.Language
	if lang == "" {
		lang = "python"
	}
	if !domain.KnownLanguage(lang) {
		return T{}, errField("language", "unknown language")
	}
	instruction, err := checkInstruction(in.Instruction)
	if err != nil {
		return T{}, err
	}
	it, err := a.GetItem(ctx, itemID)
	if err != nil {
		return T{}, err
	}
	if it.Type != domain.TypeProblem {
		return T{}, errField("type", "readings have no test cases")
	}
	h, err := harnessFor(it.Problem, lang, "language")
	if err != nil {
		return T{}, err
	}
	existingCases, err := a.ListTestCases(ctx, itemID)
	if err != nil {
		return T{}, err
	}
	provider, err := a.activeAI(ctx, in.ProviderID)
	if err != nil {
		return T{}, err
	}
	function := it.Problem.Interface == domain.InterfaceFunction
	problem := map[string]any{
		"title": it.Title, "body": it.Body, "interface": it.Problem.Interface,
		"timeLimitMs": it.Problem.TimeLimitMs, "memoryLimitKb": it.Problem.MemoryLimitKb, "compare": it.Problem.Compare,
	}
	if function {
		problem["stub"], problem["harness"] = it.Problem.StarterCode[lang], h
	}
	problemJSON, _ := json.MarshalIndent(problem, "", "  ")
	existing := ""
	if rs := it.Problem.ReferenceSolution; rs != nil {
		existing = "language: " + rs.Language + "\n" + rs.Source
	}
	run := func(ctx context.Context) (GenerateTestCasesResponse, error) {
		guidance, err := a.testCaseGuidance(ctx)
		if err != nil {
			return GenerateTestCasesResponse{}, err
		}
		system, user := ai.TestCasesPrompt{Guidance: guidance, Problem: string(problemJSON), Function: function, Count: count, Language: lang,
			ExistingSolution: existing, ExistingCases: existingCasesText(existingCases.Items), Instruction: instruction,
			Toolchains: a.toolchains(ctx), Large: largeAsk(in.LargeTestCases)}.Build()
		out := GenerateTestCasesResponse{Cases: []GeneratedCase{}, LargeCases: []*LargeCaseReport{}}
		var gens []*ai.ModelLargeCase
		out.Usage, err = a.generate(ctx, "testcases", provider, &logSubject{ItemID: &it.ID, Title: &it.Title}, ai.GenerateRequest{
			System:     system,
			User:       user,
			Schema:     ai.TestCasesSchema(lang, function, in.LargeTestCases),
			SchemaName: "test_cases",
		}, func(raw json.RawMessage) error {
			var err error
			gens, err = a.parseTestCases(raw, lang, count, existingCases.Items, &out)
			return err
		})
		if err != nil {
			return GenerateTestCasesResponse{}, err
		}
		if len(out.Cases) > 0 {
			a.verifyGenerated(ctx, it, h, &out)
		}
		if in.LargeTestCases > 0 {
			// After the proposed cases, never repeating them or the stored ones.
			var known []namedInput
			for _, c := range existingCases.Items {
				known = append(known, namedInput{c.Name, c.Stdin})
			}
			for _, c := range out.Cases {
				known = append(known, namedInput{c.Name, c.Stdin})
			}
			ref := out.ReferenceSolution
			reports, built := a.buildLargeCases(ctx, it.Problem, gens, in.LargeTestCases, &ref, known)
			for i, lc := range built {
				if lc == nil {
					continue
				}
				out.Cases = append(out.Cases, GeneratedCase{Name: lc.Name, Rationale: lc.Rationale, Stdin: lc.Stdin,
					ExpectedStdout: lc.Expected, Verified: true})
				at := len(out.Cases) - 1
				reports[i].Index = &at
			}
			out.LargeCases = reports
		}
		return out, nil
	}
	return T{itemID: &it.ID, title: it.Title, run: run}, nil
}

// parseTestCases decodes the model's test cases into out, leaving out those
// whose stdin repeats an existing case or an earlier proposal.
func (a *App) parseTestCases(raw json.RawMessage, lang string, count int, existing []domain.TestCase,
	out *GenerateTestCasesResponse) ([]*ai.ModelLargeCase, error) {
	var m ai.ModelTestCases
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, &Error{Code: CodeUpstream, Message: "the AI provider returned test cases that do not match the schema"}
	}
	if m.ReferenceSolution.Language != lang {
		return nil, &Error{Code: CodeUpstream, Message: fmt.Sprintf(
			"the AI provider wrote the reference solution in %q instead of the requested %q", m.ReferenceSolution.Language, lang)}
	}
	out.ReferenceSolution = domain.Solution{Language: lang, Source: m.ReferenceSolution.Source}
	if fe := domain.ValidateSolution(out.ReferenceSolution, a.limits); len(fe) > 0 {
		return nil, &Error{Code: CodeUpstream, Message: "the AI provider returned an unusable reference solution: " + fe.First()}
	}
	seen := map[string]bool{}
	for _, c := range existing {
		seen[sameInput(c.Stdin)] = true
	}
	for _, c := range m.Cases {
		if len(out.Cases) >= count {
			break
		}
		if len(c.Stdin) > domain.MaxTestCaseBytes || len(c.PredictedStdout) > domain.MaxTestCaseBytes {
			continue
		}
		if key := sameInput(c.Stdin); seen[key] {
			out.DuplicatesDropped++
			continue
		} else {
			seen[key] = true
		}
		predicted := c.PredictedStdout
		out.Cases = append(out.Cases, GeneratedCase{
			Name: truncateRunes(strings.TrimSpace(c.Name), domain.MaxTestCaseNameChars), Rationale: strings.TrimSpace(c.Rationale),
			Stdin: c.Stdin, PredictedStdout: &predicted, ExpectedStdout: c.PredictedStdout, IsSample: c.IsSample,
		})
	}
	if len(out.Cases) == 0 && out.DuplicatesDropped == 0 && len(m.LargeCases) == 0 {
		return nil, &Error{Code: CodeUpstream, Message: "the AI provider proposed no usable test cases"}
	}
	return m.LargeCases, nil
}

// sameInput is what two test inputs are compared by: trailing whitespace
// does not make an input new.
func sameInput(stdin string) string { return strings.TrimRight(stdin, " \t\r\n") }

// Bounds on the existing cases shown to the model when it proposes more.
const (
	maxShownCases      = 40
	maxShownCasesBytes = 32 << 10
)

// existingCasesText lists a problem's test inputs for the model, so that
// it adds to them rather than repeating them: names and stdin, in order,
// a large case by its name and size only, and the list bounded.
func existingCasesText(cases []domain.TestCase) string {
	var b strings.Builder
	for i, c := range cases {
		if i >= maxShownCases || b.Len() >= maxShownCasesBytes {
			fmt.Fprintf(&b, "(%d more test cases not shown)\n", len(cases)-i)
			break
		}
		stdin := c.Stdin
		if isLargeData(c.Stdin, c.ExpectedStdout) {
			stdin = largeCaseInfo(c.Stdin, c.ExpectedStdout)
		}
		name := oneLine(c.Name)
		if name == "" {
			name = fmt.Sprintf("test case %d", i+1)
		}
		kind := "hidden"
		if c.IsSample {
			kind = "sample"
		}
		fmt.Fprintf(&b, "--- %s (%s)\n%s\n", name, kind, strings.TrimRight(stdin, "\n"))
	}
	return b.String()
}

func (a *App) verifyGenerated(ctx context.Context, it domain.Item, h *domain.HarnessCode, out *GenerateTestCasesResponse) {
	if a.engine == nil {
		return
	}
	name := a.engine.Name()
	out.Verification = Verification{Attempted: true, Engine: &name}
	setErr := func(msg string) {
		out.Verification.Error = &msg
		for i := range out.Cases {
			e := msg
			out.Cases[i].Error = &e
		}
	}
	if err := a.requireLanguage(ctx, out.ReferenceSolution.Language); err != nil {
		setErr(AsError(err).Message)
		return
	}
	prog, _, err := a.runnable(ctx, it.Problem, out.ReferenceSolution.Language, h, out.ReferenceSolution.Source, "referenceSolution")
	if err != nil {
		setErr("the reference solution cannot run: " + validationText(err))
		return
	}
	stdins := make([]string, len(out.Cases))
	for i, c := range out.Cases {
		stdins[i] = c.Stdin
	}
	execs := a.grader.RunAll(ctx, prog, stdins, nil)
	if execs[0].CompileFailed() {
		setErr("the reference solution does not compile: " + domain.Truncate(strings.TrimSpace(execs[0].Result.CompileOutput), 2000))
		return
	}
	allFailed := true
	for i, e := range execs {
		c := &out.Cases[i]
		v := grader.Verdict(it.Problem.Compare, e, nil)
		if v == domain.VerdictExecuted && utf8.ValidString(e.Result.Stdout) {
			allFailed = false
			c.ExpectedStdout = e.Result.Stdout
			c.Verified = true
			matched := grader.Match(it.Problem.Compare, *c.PredictedStdout, e.Result.Stdout)
			c.PredictionMatched = &matched
			continue
		}
		msg := describeFailure(v, e)
		c.Error = &msg
	}
	if allFailed && execs[0].Err != nil {
		msg := "verification could not run: " + grader.ErrorMessage(execs[0])
		out.Verification.Error = &msg
	}
}

func describeFailure(v domain.Verdict, e grader.Execution) string {
	switch {
	case e.Err != nil || e.Result.Status == judge.StatusInternalError:
		return "the judge engine failed: " + grader.ErrorMessage(e)
	case v == domain.VerdictExecuted:
		return "the reference solution printed output that is not valid UTF-8"
	}
	msg := "the reference solution failed: " + strings.ReplaceAll(string(v), "_", " ")
	if s := strings.TrimSpace(e.Result.Stderr); s != "" {
		msg += ": " + domain.Truncate(s, 1000)
	} else if e.Result.Message != "" {
		msg += " (" + e.Result.Message + ")"
	}
	return msg
}

// hyphenateTag replaces each run of whitespace inside a tag the model
// suggested with "-", so "shortest path" becomes "shortest-path" like a tag
// typed in the UI.
func hyphenateTag(t string) string { return strings.Join(strings.Fields(domain.NormalizeText(t)), "-") }

// validationText is a validation error's message without its field name,
// for reporting inside a response rather than as an error.
func validationText(err error) string {
	ae := AsError(err)
	if len(ae.Fields) == 1 {
		for _, v := range ae.Fields {
			if s, ok := v.(string); ok {
				return s
			}
		}
	}
	return ae.Message
}

// Bounds on the draft check. A draft carries its sample cases only, but a
// model can return up to MaxGeneratedCases of them. The time bound keeps a
// draft that took the provider's whole timeout (5 minutes by default)
// within the HTTP API's 6-minute deadline for AI requests.
var draftCheckBounds = checkBounds{maxCases: 10, timeout: 50 * time.Second}

// checkBounds bound a check: how many test cases it runs (0: all) and for
// how long.
type checkBounds struct {
	maxCases int
	timeout  time.Duration
}

// checkDraft runs a problem draft's reference solution on its test cases
// (through the harness for a function problem) and marks each case that
// printed its expected output as verified; then, for a function problem,
// it runs each language's unchanged starter code on the first case to
// prove that language's harness (see checkRunners). It never fails the
// draft: an absent or unreachable engine, a compile error or a timeout are
// reported in the check. Nothing in the draft other than the flags is
// changed. Both parts share one time bound, the reference solution first.
//
// With large > 0, that many large test cases are built from gens after
// the other cases and before the runners, in the same time bound; the
// 10-case cap does not apply to them. Each one added is appended to the
// draft's test cases, in the model's order, and counts in passed and total.
func (a *App) checkDraft(ctx context.Context, d *ItemDraft, b checkBounds, large int, gens []*ai.ModelLargeCase) *DraftCheck {
	if d.Type != domain.TypeProblem || d.Problem == nil {
		return nil
	}
	c := &DraftCheck{Total: len(d.TestCases), Runners: []RunnerCheck{}, LargeCases: []*LargeCaseReport{}}
	ref := d.Problem.ReferenceSolution
	if a.engine == nil || ref == nil || len(d.TestCases) == 0 {
		// Nothing runs when the check is not attempted.
		reason := "the draft has no test case to check the reference solution on"
		switch {
		case a.engine == nil:
			reason = "no judge engine is configured"
		case ref == nil:
			reason = "there is no reference solution to compute the expected output"
		}
		c.LargeCases = failAll(newLargeCaseReports(gens, large), "skipped", reason)
		return c
	}
	name := a.engine.Name()
	c.Attempted, c.Engine = true, &name
	ctx, cancel := context.WithTimeout(ctx, b.timeout)
	defer cancel()
	msg, refFailed := a.checkReference(ctx, d, c, b.maxCases)
	if msg != "" {
		c.Error = &msg
	}
	if large > 0 && refFailed {
		// Their expected output would come from a reference solution that
		// just failed: they would be marked verified and probably be wrong.
		c.LargeCases = failAll(newLargeCaseReports(gens, large), "skipped", "the reference solution did not pass the other test cases")
	} else if large > 0 {
		known := make([]namedInput, len(d.TestCases))
		for i, tc := range d.TestCases {
			known[i] = namedInput{tc.Name, tc.Stdin}
		}
		reports, built := a.buildLargeCases(ctx, d.Problem.spec(), gens, large, ref, known)
		for i, lc := range built {
			if lc == nil {
				continue
			}
			d.TestCases = append(d.TestCases, DraftTestCase{Name: lc.Name, Stdin: lc.Stdin, ExpectedStdout: lc.Expected,
				Verified: true})
			at := len(d.TestCases) - 1
			reports[i].Index = &at
			c.Passed++
			c.Total++
		}
		c.LargeCases = reports
	}
	if d.Problem.Interface == domain.InterfaceFunction {
		c.Runners = a.checkRunners(ctx, d)
	}
	return c
}

// checkReference runs the reference solution on the cases and returns the
// first problem in plain words, or "", and whether the reference solution
// failed: did not run or compile, or failed a case it reached. Cases left
// out by the cap or the time bound are not failures.
func (a *App) checkReference(ctx context.Context, d *ItemDraft, c *DraftCheck, maxCases int) (msg string, failed bool) {
	ref := d.Problem.ReferenceSolution
	spec := d.Problem.spec()
	h, ok := spec.HarnessFor(ref.Language)
	if !ok {
		msg := "the reference solution cannot run: " + noHarnessMessage(spec, ref.Language)
		setOutcomes(d, "failed", msg)
		return msg, true
	}
	if err := a.requireLanguage(ctx, ref.Language); err != nil {
		msg := "the reference solution could not be run: " + validationText(err)
		if AsError(err).Code == CodeJudgeUnavailable {
			setOutcomes(d, "not_run", msg)
		} else {
			setOutcomes(d, "failed", msg)
		}
		return msg, false
	}
	prog, _, err := a.runnable(ctx, spec, ref.Language, h, ref.Source, "referenceSolution")
	if err != nil {
		msg := "the reference solution cannot run: " + validationText(err)
		setOutcomes(d, "failed", msg)
		return msg, true
	}
	cases := d.TestCases
	if maxCases > 0 {
		cases = cases[:min(len(cases), maxCases)]
	}
	setOutcomes(d, "not_run", fmt.Sprintf("only the first %d test cases are checked", len(cases)))
	stdins := make([]string, len(cases))
	for i, tc := range cases {
		stdins[i] = tc.Stdin
	}
	execs := a.grader.RunAll(ctx, prog, stdins, nil)
	if execs[0].CompileFailed() {
		msg := "the reference solution does not compile: " +
			domain.Truncate(strings.TrimSpace(execs[0].Result.CompileOutput), 2000)
		setOutcomes(d, "failed", msg)
		return msg, true
	}
	first, reached := "", 0
	for i, e := range execs {
		tc := &d.TestCases[i]
		if e.Err != nil && ctx.Err() != nil {
			tc.outcome = outcome("not_run", "the check's time ran out")
			continue
		}
		reached++
		exp := tc.ExpectedStdout
		v := grader.Verdict(d.Problem.Compare, e, &exp)
		switch {
		case v == domain.VerdictAccepted:
			tc.outcome = outcome("passed", "")
		case v == domain.VerdictWrongAnswer:
			tc.outcome = outcome("wrong", "")
		case errors.Is(e.Err, judge.ErrNotRun):
			tc.outcome = outcome("not_run", "the judge engine failed on an earlier test case, so this one was not run")
		case e.Err != nil || e.Result.Status == judge.StatusInternalError:
			tc.outcome = outcome("not_run", describeFailure(v, e))
		default:
			tc.outcome = outcome("failed", describeFailure(v, e))
		}
		if v == domain.VerdictAccepted {
			tc.Verified = true
			c.Passed++
			continue
		}
		if first == "" {
			first = caseLabel(tc.Name, i) + ": " + checkFailure(v, e, exp)
		}
	}
	switch {
	case first != "":
		return first, true
	case reached < len(cases):
		return fmt.Sprintf("the check ran out of time after %d of %d test cases", reached, len(d.TestCases)), false
	case len(cases) < len(d.TestCases):
		return fmt.Sprintf("only the first %d test cases were checked", len(cases)), false
	}
	return "", false
}

// RunnerCheck says whether one language's starter code ran in its harness.
type RunnerCheck struct {
	Language string  `json:"language"`
	Status   string  `json:"status"` // ok, failed or skipped
	Error    *string `json:"error"`
}

// checkRunners runs, for every harness language of a function draft, that
// language's starter code unchanged on the first test case. A stub is
// written to run as it stands, so any answer counts as ok; a compile error
// or a crash is failed. A language the engine does not offer, one without
// starter code, and every language not reached before the check's time
// ran out are skipped. The languages run in parallel, in the time the
// reference solution left.
func (a *App) checkRunners(ctx context.Context, d *ItemDraft) []RunnerCheck {
	langs := slices.Sorted(maps.Keys(d.Problem.Harness))
	out := make([]RunnerCheck, len(langs))
	spec := d.Problem.spec()
	stdin := d.TestCases[0].Stdin
	var wg sync.WaitGroup
	for i, lang := range langs {
		out[i] = RunnerCheck{Language: lang, Status: "skipped"}
		set := func(status, msg string) {
			out[i].Status = status
			if msg != "" {
				out[i].Error = &msg
			}
		}
		stub, ok := spec.StarterCode[lang]
		switch {
		case ctx.Err() != nil:
			set("skipped", "the check ran out of time")
			continue
		case !ok || strings.TrimSpace(stub) == "":
			set("skipped", "there is no starter code for "+lang)
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := a.requireLanguage(ctx, lang); err != nil {
				set("skipped", validationText(err))
				return
			}
			h := spec.Harness[lang]
			prog, _, err := a.runnable(ctx, spec, lang, &h, stub, "starterCode")
			if err != nil {
				set("failed", validationText(err))
				return
			}
			e := a.grader.RunAll(ctx, prog, []string{stdin}, nil)[0]
			switch {
			case e.Err != nil && ctx.Err() != nil:
				set("skipped", "the check ran out of time")
			case e.Err != nil || e.Result.Status == judge.StatusInternalError:
				set("skipped", "the judge engine failed: "+grader.ErrorMessage(e))
			case e.CompileFailed():
				set("failed", "does not compile: "+domain.Truncate(strings.TrimSpace(e.Result.CompileOutput), 1000))
			case e.Result.Status != judge.StatusOK:
				set("failed", strings.TrimPrefix(describeFailure(grader.Verdict(spec.Compare, e, nil), e), "the reference solution failed: "))
			default:
				set("ok", "")
			}
		}()
	}
	wg.Wait()
	return out
}

func caseLabel(name string, i int) string {
	if name = strings.TrimSpace(name); name != "" {
		return fmt.Sprintf("%q", name)
	}
	return fmt.Sprintf("test case %d", i+1)
}

// checkFailure says in plain words why a case failed the draft check.
func checkFailure(v domain.Verdict, e grader.Execution, expected string) string {
	if v != domain.VerdictWrongAnswer {
		return describeFailure(v, e)
	}
	return fmt.Sprintf("the reference solution printed %q, but the expected output is %q",
		domain.Truncate(strings.TrimSpace(e.Result.Stdout), 300), domain.Truncate(strings.TrimSpace(expected), 300))
}
