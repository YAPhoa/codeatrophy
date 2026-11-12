package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
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
	TimeLimitMs   int                `json:"timeLimitMs"`
	MemoryLimitKb int                `json:"memoryLimitKb"`
	Compare       domain.CompareMode `json:"compare"`
	StarterCode   map[string]string  `json:"starterCode"`
}

// DraftTestCase is a test case of a draft.
type DraftTestCase struct {
	Name           string `json:"name"`
	Stdin          string `json:"stdin"`
	ExpectedStdout string `json:"expectedStdout"`
	IsSample       bool   `json:"isSample"`
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
}

// DraftInput is the body of POST /ai/draft.
type DraftInput struct {
	Text          string             `json:"text"`
	TypeHint      string             `json:"typeHint"`
	Instruction   domain.Opt[string] `json:"instruction"`
	PreviousDraft json.RawMessage    `json:"previousDraft"`
	StyleID       domain.Opt[string] `json:"styleId"`
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
	instruction, err := checkInstruction(in.Instruction)
	if err != nil {
		return DraftResponse{}, err
	}
	prev, msg := previousDraft(in.PreviousDraft)
	if msg != "" {
		fe.Add("previousDraft", msg)
	}
	if err := errValidation(fe); err != nil {
		return DraftResponse{}, err
	}
	preset, err := a.resolveStyle(ctx, in.StyleID)
	if err != nil {
		return DraftResponse{}, err
	}
	provider, secret, err := a.activeAI(ctx)
	if err != nil {
		return DraftResponse{}, err
	}
	style, ref := styleOf(preset)
	system, user := ai.DraftPrompt{Style: style, Text: text, TypeHint: hint, Instruction: instruction, PreviousDraft: prev}.Build()
	resp, err := provider.Generate(ctx, ai.GenerateRequest{
		System:     system,
		User:       user,
		Schema:     ai.DraftSchema(),
		SchemaName: "item_draft",
	})
	if err != nil {
		return DraftResponse{}, errUpstream(err, secret)
	}
	draft, err := a.parseDraft(resp.JSON, hint)
	if err != nil {
		return DraftResponse{}, err
	}
	return DraftResponse{Draft: draft, Style: ref}, nil
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
// problems are upstream errors.
func (a *App) parseDraft(raw json.RawMessage, hint string) (ItemDraft, error) {
	var m ai.ModelDraft
	if err := json.Unmarshal(raw, &m); err != nil {
		return ItemDraft{}, &Error{Code: CodeUpstream, Message: "the AI provider returned a draft that does not match the schema"}
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
			return ItemDraft{}, &Error{Code: CodeUpstream, Message: "the AI provider returned a draft without a valid type"}
		}
	}
	d.Title = truncateRunes(oneLine(m.Title), domain.MaxTitleChars)
	if d.Title == "" {
		return ItemDraft{}, &Error{Code: CodeUpstream, Message: "the AI provider returned a draft without a title"}
	}
	d.Summary = truncateRunes(d.Summary, domain.MaxSummaryChars)
	if len(d.Body) > domain.MaxTextBytes {
		return ItemDraft{}, &Error{Code: CodeUpstream, Message: "the AI provider returned a body that is too long"}
	}
	if m.Difficulty != nil {
		if diff := domain.Difficulty(*m.Difficulty); diff.Valid() {
			d.Difficulty = &diff
		}
	}
	for _, t := range domain.NormalizeTags(m.Tags) {
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
		p := &DraftProblem{TimeLimitMs: domain.DefaultTimeLimitMs, MemoryLimitKb: domain.DefaultMemoryLimitKb,
			Compare: domain.CompareTokens, StarterCode: map[string]string{}}
		if mp := m.Problem; mp != nil {
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
		}
		d.Problem = p
		for _, tc := range m.TestCases {
			if len(d.TestCases) >= MaxGeneratedCases {
				break
			}
			if len(tc.Stdin) > domain.MaxTestCaseBytes || len(tc.ExpectedStdout) > domain.MaxTestCaseBytes {
				continue
			}
			d.TestCases = append(d.TestCases, DraftTestCase{Name: truncateRunes(tc.Name, domain.MaxTestCaseNameChars),
				Stdin: tc.Stdin, ExpectedStdout: tc.ExpectedStdout, IsSample: tc.IsSample})
		}
	}
	return d, nil
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

// VariantInput is the body of POST /items/{id}/ai/variant.
type VariantInput struct {
	Mode          string             `json:"mode"`
	Instruction   domain.Opt[string] `json:"instruction"`
	PreviousDraft json.RawMessage    `json:"previousDraft"`
	StyleID       domain.Opt[string] `json:"styleId"`
}

// Variant drafts a new item derived from an existing one. Nothing is saved.
func (a *App) Variant(ctx context.Context, itemID string, in VariantInput) (DraftResponse, error) {
	mode := in.Mode
	if mode == "" {
		mode = "similar"
	}
	if _, ok := ai.VariantModes[mode]; !ok {
		return DraftResponse{}, errField("mode", "must be similar, easier, harder or twist")
	}
	instruction, err := checkInstruction(in.Instruction)
	if err != nil {
		return DraftResponse{}, err
	}
	prev, msg := previousDraft(in.PreviousDraft)
	if msg != "" {
		return DraftResponse{}, errField("previousDraft", msg)
	}
	it, err := a.GetItem(ctx, itemID)
	if err != nil {
		return DraftResponse{}, err
	}
	if it.Type == domain.TypeReading && mode != "similar" {
		return DraftResponse{}, errField("mode", "readings only support the similar mode")
	}
	var samples []map[string]any
	if it.Type == domain.TypeProblem {
		cases, err := a.ListTestCases(ctx, itemID)
		if err != nil {
			return DraftResponse{}, err
		}
		for _, c := range cases.Items {
			if c.IsSample && len(samples) < 3 {
				samples = append(samples, map[string]any{
					"stdin": domain.Truncate(c.Stdin, 4096), "expectedStdout": domain.Truncate(c.ExpectedStdout, 4096)})
			}
		}
	}
	preset, err := a.resolveStyle(ctx, in.StyleID)
	if err != nil {
		return DraftResponse{}, err
	}
	provider, secret, err := a.activeAI(ctx)
	if err != nil {
		return DraftResponse{}, err
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
		orig["problem"] = map[string]any{
			"timeLimitMs": it.Problem.TimeLimitMs, "memoryLimitKb": it.Problem.MemoryLimitKb,
			"compare": it.Problem.Compare, "starterLanguages": langs,
		}
		orig["sampleTestCases"] = samples
	}
	origJSON, _ := json.MarshalIndent(orig, "", "  ")
	style, ref := styleOf(preset)
	system, user := ai.VariantPrompt{Style: style, Original: string(origJSON), Mode: mode, Instruction: instruction,
		PreviousDraft: prev}.Build()
	resp, err := provider.Generate(ctx, ai.GenerateRequest{
		System:     system,
		User:       user,
		Schema:     ai.DraftSchema(),
		SchemaName: "item_draft",
	})
	if err != nil {
		return DraftResponse{}, errUpstream(err, secret)
	}
	draft, err := a.parseDraft(resp.JSON, string(it.Type))
	if err != nil {
		return DraftResponse{}, err
	}
	return DraftResponse{Draft: draft, Style: ref}, nil
}

// GenerateTestCasesInput is the body of POST /items/{id}/ai/testcases.
type GenerateTestCasesInput struct {
	Count       domain.Opt[int]    `json:"count"`
	Language    string             `json:"language"`
	Instruction domain.Opt[string] `json:"instruction"`
}

// GeneratedCase is one proposed test case.
type GeneratedCase struct {
	Name              string  `json:"name"`
	Rationale         string  `json:"rationale"`
	Stdin             string  `json:"stdin"`
	ExpectedStdout    string  `json:"expectedStdout"`
	PredictedStdout   string  `json:"predictedStdout"`
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
	Cases             []GeneratedCase `json:"cases"`
}

// GenerateTestCases asks the model for a reference solution and inputs, then
// runs the solution to compute the expected outputs when an engine is
// available. Nothing is saved. Style presets do not apply.
func (a *App) GenerateTestCases(ctx context.Context, itemID string, in GenerateTestCasesInput) (GenerateTestCasesResponse, error) {
	count := DefaultGeneratedCases
	if in.Count.HasValue() {
		count = in.Count.Val
	}
	if count < 1 || count > MaxGeneratedCases {
		return GenerateTestCasesResponse{}, errField("count", fmt.Sprintf("must be between 1 and %d", MaxGeneratedCases))
	}
	lang := in.Language
	if lang == "" {
		lang = "python"
	}
	if !domain.KnownLanguage(lang) {
		return GenerateTestCasesResponse{}, errField("language", "unknown language")
	}
	instruction, err := checkInstruction(in.Instruction)
	if err != nil {
		return GenerateTestCasesResponse{}, err
	}
	it, err := a.GetItem(ctx, itemID)
	if err != nil {
		return GenerateTestCasesResponse{}, err
	}
	if it.Type != domain.TypeProblem {
		return GenerateTestCasesResponse{}, errField("type", "readings have no test cases")
	}
	provider, secret, err := a.activeAI(ctx)
	if err != nil {
		return GenerateTestCasesResponse{}, err
	}
	problemJSON, _ := json.MarshalIndent(map[string]any{
		"title": it.Title, "body": it.Body,
		"timeLimitMs": it.Problem.TimeLimitMs, "memoryLimitKb": it.Problem.MemoryLimitKb, "compare": it.Problem.Compare,
	}, "", "  ")
	existing := ""
	if rs := it.Problem.ReferenceSolution; rs != nil {
		existing = "language: " + rs.Language + "\n" + rs.Source
	}
	system, user := ai.TestCasesPrompt{Problem: string(problemJSON), Count: count, Language: lang,
		ExistingSolution: existing, Instruction: instruction}.Build()
	resp, err := provider.Generate(ctx, ai.GenerateRequest{
		System:     system,
		User:       user,
		Schema:     ai.TestCasesSchema(lang),
		SchemaName: "test_cases",
	})
	if err != nil {
		return GenerateTestCasesResponse{}, errUpstream(err, secret)
	}
	var m ai.ModelTestCases
	if err := json.Unmarshal(resp.JSON, &m); err != nil {
		return GenerateTestCasesResponse{}, &Error{Code: CodeUpstream, Message: "the AI provider returned test cases that do not match the schema"}
	}
	if m.ReferenceSolution.Language != lang {
		return GenerateTestCasesResponse{}, &Error{Code: CodeUpstream, Message: fmt.Sprintf(
			"the AI provider wrote the reference solution in %q instead of the requested %q", m.ReferenceSolution.Language, lang)}
	}
	out := GenerateTestCasesResponse{
		ReferenceSolution: domain.Solution{Language: lang, Source: m.ReferenceSolution.Source},
		Cases:             []GeneratedCase{},
	}
	if fe := domain.ValidateSolution(out.ReferenceSolution, a.limits); len(fe) > 0 {
		return GenerateTestCasesResponse{}, &Error{Code: CodeUpstream, Message: "the AI provider returned an unusable reference solution: " + fe.First()}
	}
	for _, c := range m.Cases {
		if len(out.Cases) >= count {
			break
		}
		if len(c.Stdin) > domain.MaxTestCaseBytes || len(c.PredictedStdout) > domain.MaxTestCaseBytes {
			continue
		}
		out.Cases = append(out.Cases, GeneratedCase{
			Name: truncateRunes(strings.TrimSpace(c.Name), domain.MaxTestCaseNameChars), Rationale: strings.TrimSpace(c.Rationale),
			Stdin: c.Stdin, PredictedStdout: c.PredictedStdout, ExpectedStdout: c.PredictedStdout, IsSample: c.IsSample,
		})
	}
	if len(out.Cases) == 0 {
		return GenerateTestCasesResponse{}, &Error{Code: CodeUpstream, Message: "the AI provider proposed no usable test cases"}
	}
	a.verifyGenerated(ctx, it, &out)
	return out, nil
}

func (a *App) verifyGenerated(ctx context.Context, it domain.Item, out *GenerateTestCasesResponse) {
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
	stdins := make([]string, len(out.Cases))
	for i, c := range out.Cases {
		stdins[i] = c.Stdin
	}
	prog := grader.Program{Language: out.ReferenceSolution.Language, Source: out.ReferenceSolution.Source,
		TimeLimitMs: it.Problem.TimeLimitMs, MemoryLimitKb: it.Problem.MemoryLimitKb}
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
			matched := grader.Match(it.Problem.Compare, c.PredictedStdout, e.Result.Stdout)
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
