package app

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
)

// maxCodeSamples is how many of a code request's sample test cases the
// model is shown.
const maxCodeSamples = 5

// CodeSample is a sample test case of a problem whose code is generated.
type CodeSample struct {
	Stdin          string `json:"stdin"`
	ExpectedStdout string `json:"expectedStdout"`
}

// CodeInput is the body of POST /ai/code: a problem as it stands in an
// editor, saved or not, and the languages to write its code in.
type CodeInput struct {
	// ItemID is the saved item the problem is, if any; it only labels the
	// request in the AI log.
	ItemID     domain.Opt[string] `json:"itemId"`
	Title      string             `json:"title"`
	Body       string             `json:"body"`
	Interface  string             `json:"interface"`
	Languages  []string           `json:"languages"`
	Samples    []CodeSample       `json:"samples"`
	StyleID    domain.Opt[string] `json:"styleId"`
	ProviderID domain.Opt[string] `json:"providerId"`
}

// CodeCheck says whether each generated runner ran its stub on the first
// sample test case.
type CodeCheck struct {
	Attempted bool          `json:"attempted"`
	Engine    *string       `json:"engine"`
	Runners   []RunnerCheck `json:"runners"`
}

// CodeResponse is the result of code generation.
type CodeResponse struct {
	StarterCode map[string]string             `json:"starterCode"`
	Harness     map[string]domain.HarnessCode `json:"harness"`
	// Check is nil for a program problem.
	Check *CodeCheck       `json:"check"`
	Style *domain.StyleRef `json:"style"`
	Usage Usage            `json:"usage"`
}

// GenerateCode asks the model for the starter code of a problem in the
// given languages, and for a function problem the harness too, then runs
// each runner the way the draft check does. Only languages that were asked
// for come back. Nothing is saved; the problem need not be saved either.
func (a *App) GenerateCode(ctx context.Context, in CodeInput) (CodeResponse, error) {
	fe := domain.FieldErrors{}
	title := strings.TrimSpace(domain.NormalizeText(in.Title))
	body := domain.NormalizeText(in.Body)
	if utf8.RuneCountInString(title) > domain.MaxTitleChars {
		fe.Add("title", fmt.Sprintf("must be at most %d characters", domain.MaxTitleChars))
	}
	if len(body) > domain.MaxTextBytes {
		fe.Add("body", fmt.Sprintf("must be at most %d bytes", domain.MaxTextBytes))
	}
	if title == "" && strings.TrimSpace(body) == "" {
		fe.Add("body", "is required")
	}
	iface := domain.ProblemInterface(in.Interface)
	if in.Interface == "" {
		iface = domain.InterfaceProgram
	}
	if !iface.Valid() {
		fe.Add("interface", "must be program or function")
	}
	var langs []string
	for _, l := range in.Languages {
		if !domain.KnownLanguage(l) {
			fe.Add("languages", fmt.Sprintf("unknown language %q", l))
		} else if !slices.Contains(langs, l) {
			langs = append(langs, l)
		}
	}
	if len(in.Languages) == 0 {
		fe.Add("languages", "is required")
	}
	if len(in.Samples) > domain.MaxTestCasesPerItem {
		fe.Add("samples", fmt.Sprintf("at most %d test cases", domain.MaxTestCasesPerItem))
	}
	for i, s := range in.Samples {
		if len(s.Stdin) > domain.MaxTestCaseBytes || len(s.ExpectedStdout) > domain.MaxTestCaseBytes {
			fe.Add(fmt.Sprintf("samples.%d", i), fmt.Sprintf("stdin and expectedStdout must each be at most %d bytes", domain.MaxTestCaseBytes))
		}
	}
	if err := errValidation(fe); err != nil {
		return CodeResponse{}, err
	}
	subject := &logSubject{}
	if title != "" {
		subject.Title = &title
	}
	if in.ItemID.HasValue() {
		it, err := a.GetItem(ctx, in.ItemID.Val)
		if err != nil {
			if AsError(err).Code == CodeNotFound {
				return CodeResponse{}, errField("itemId", "item does not exist")
			}
			return CodeResponse{}, err
		}
		subject.ItemID = &it.ID
		if subject.Title == nil {
			subject.Title = &it.Title
		}
	}
	preset, err := a.resolveStyle(ctx, in.StyleID)
	if err != nil {
		return CodeResponse{}, err
	}
	provider, err := a.activeAI(ctx, in.ProviderID)
	if err != nil {
		return CodeResponse{}, err
	}
	conventions, err := a.Conventions(ctx)
	if err != nil {
		return CodeResponse{}, err
	}
	// Large test data never goes into a prompt.
	samples := []map[string]any{}
	for _, s := range in.Samples[:min(len(in.Samples), maxCodeSamples)] {
		if isLargeData(s.Stdin, s.ExpectedStdout) {
			samples = append(samples, map[string]any{"omitted": largeCaseInfo(s.Stdin, s.ExpectedStdout)})
			continue
		}
		samples = append(samples, map[string]any{"stdin": s.Stdin, "expectedStdout": s.ExpectedStdout})
	}
	problemJSON, _ := json.MarshalIndent(map[string]any{"title": title, "body": body, "interface": iface, "sampleTestCases": samples}, "", "  ")
	function := iface == domain.InterfaceFunction
	style, ref := styleOf(preset)
	system, user := ai.CodePrompt{Conventions: conventions, Style: style, Problem: string(problemJSON), Function: function,
		Languages: langs, Toolchains: a.toolchains(ctx)}.Build()
	out := CodeResponse{StarterCode: map[string]string{}, Harness: map[string]domain.HarnessCode{}, Style: ref}
	out.Usage, err = a.generate(ctx, "code", provider, subject, ai.GenerateRequest{
		System:     system,
		User:       user,
		Schema:     ai.CodeSchema(langs, function),
		SchemaName: "code",
	}, func(raw json.RawMessage) error { return a.parseCode(raw, langs, function, &out) })
	if err != nil {
		return CodeResponse{}, err
	}
	if function {
		out.Check = a.checkCode(ctx, &out, in.Samples)
	}
	return out, nil
}

// parseCode decodes the model's code into out, keeping one entry for each
// language that was asked for and leaving out any other, and any entry
// without starter code or over the source limit.
func (a *App) parseCode(raw json.RawMessage, langs []string, function bool, out *CodeResponse) error {
	var m ai.ModelCode
	if err := json.Unmarshal(raw, &m); err != nil {
		return &Error{Code: CodeUpstream, Message: "the AI provider returned code that does not match the schema"}
	}
	for _, c := range m.Code {
		if _, done := out.StarterCode[c.Language]; done || !slices.Contains(langs, c.Language) {
			continue
		}
		src := domain.NormalizeText(c.StarterCode)
		if strings.TrimSpace(src) == "" || len(src) > a.limits.MaxSourceBytes {
			continue
		}
		if function {
			h := domain.HarnessCode{Prefix: domain.NormalizeText(c.Prefix), Suffix: domain.NormalizeText(c.Suffix)}
			if c.Language == "python" {
				h.Prefix = withFutureAnnotations(h.Prefix)
			}
			if len(h.Prefix) > a.limits.MaxSourceBytes || len(h.Suffix) > a.limits.MaxSourceBytes {
				continue
			}
			out.Harness[c.Language] = h
		}
		out.StarterCode[c.Language] = src
	}
	if len(out.StarterCode) == 0 {
		return &Error{Code: CodeUpstream, Message: "the AI provider wrote no usable code for the languages asked for"}
	}
	return nil
}

// checkCode runs each generated stub unchanged in its harness on the first
// sample test case, as the draft check proves a draft's runners. Nothing is
// attempted without an engine or a sample.
func (a *App) checkCode(ctx context.Context, out *CodeResponse, samples []CodeSample) *CodeCheck {
	c := &CodeCheck{Runners: []RunnerCheck{}}
	if a.engine == nil || len(samples) == 0 {
		return c
	}
	name := a.engine.Name()
	c.Attempted, c.Engine = true, &name
	ctx, cancel := context.WithTimeout(ctx, draftCheckBounds.timeout)
	defer cancel()
	d := &ItemDraft{Type: domain.TypeProblem, TestCases: []DraftTestCase{{Stdin: samples[0].Stdin}}, Problem: &DraftProblem{
		Interface: domain.InterfaceFunction, TimeLimitMs: domain.DefaultTimeLimitMs, MemoryLimitKb: domain.DefaultMemoryLimitKb,
		Compare: domain.CompareTokens, StarterCode: out.StarterCode, Harness: out.Harness}}
	c.Runners = a.checkRunners(ctx, d)
	return c
}
