package app

import (
	"context"
	"strings"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Meta describes the instance's capabilities.
type Meta struct {
	Version string      `json:"version"`
	AI      AIInfo      `json:"ai"`
	Judge   JudgeStatus `json:"judge"`
	MCP     MetaMCP     `json:"mcp"`
	Limits  MetaLimits  `json:"limits"`
}

// MetaMCP describes the MCP endpoint.
type MetaMCP struct {
	Enabled      bool    `json:"enabled"`
	Path         string  `json:"path"`
	URL          *string `json:"url"`
	AuthRequired bool    `json:"authRequired"`
}

// Range is an inclusive bound.
type Range struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// MetaLimits are the bounds the server enforces on user input, taken from
// the same constants the validators use.
type MetaLimits struct {
	MaxImportBytes             int64 `json:"maxImportBytes"`
	MaxSourceBytes             int   `json:"maxSourceBytes"`
	MaxTitleChars              int   `json:"maxTitleChars"`
	MaxSummaryChars            int   `json:"maxSummaryChars"`
	MaxTextBytes               int   `json:"maxTextBytes"`
	MaxSourceURLChars          int   `json:"maxSourceUrlChars"`
	MaxSourceNoteChars         int   `json:"maxSourceNoteChars"`
	MaxTags                    int   `json:"maxTags"`
	MaxTagChars                int   `json:"maxTagChars"`
	MaxCollectionNameChars     int   `json:"maxCollectionNameChars"`
	MaxCollectionDescription   int   `json:"maxCollectionDescriptionChars"`
	TimeLimitMs                Range `json:"timeLimitMs"`
	MemoryLimitKb              Range `json:"memoryLimitKb"`
	MaxTestCasesPerItem        int   `json:"maxTestCasesPerItem"`
	MaxTestDataBytes           int   `json:"maxTestDataBytes"`
	MaxTestCaseNameChars       int   `json:"maxTestCaseNameChars"`
	MaxDraftTextChars          int   `json:"maxDraftTextChars"`
	MaxInstructionChars        int   `json:"maxInstructionChars"`
	MaxPreviousDraftBytes      int   `json:"maxPreviousDraftBytes"`
	MaxGeneratedTestCases      int   `json:"maxGeneratedTestCases"`
	MaxLargeInputBytes         int   `json:"maxLargeInputBytes"`
	MaxLargeTestCases          int   `json:"maxLargeTestCases"`
	MaxStylePresets            int   `json:"maxStylePresets"`
	MaxStyleNameChars          int   `json:"maxStyleNameChars"`
	MaxStyleInstructionsChars  int   `json:"maxStyleInstructionsChars"`
	MaxSystemPromptChars       int   `json:"maxSystemPromptChars"`
	MaxModelIDChars            int   `json:"maxModelIdChars"`
	MaxAPIKeyChars             int   `json:"maxApiKeyChars"`
	MaxAIProviders             int   `json:"maxAiProviders"`
	MaxAIProviderNameChars     int   `json:"maxAiProviderNameChars"`
	MinAITimeoutSeconds        int   `json:"minAiTimeoutSeconds"`
	MaxAITimeoutSeconds        int   `json:"maxAiTimeoutSeconds"`
	MaxBundleNameChars         int   `json:"maxBundleNameChars"`
	MaxBundleDescriptionChars  int   `json:"maxBundleDescriptionChars"`
	MaxImportUncompressedBytes int64 `json:"maxImportUncompressedBytes"`
	MaxImportEntries           int   `json:"maxImportEntries"`
	MaxImportCollections       int   `json:"maxImportCollections"`
	MaxSolutionsPerItem        int   `json:"maxSolutionsPerItem"`
	MaxSolutionNameChars       int   `json:"maxSolutionNameChars"`
	MaxSolutionNotesChars      int   `json:"maxSolutionNotesChars"`
	MaxNotesChars              int   `json:"maxNotesChars"`
	MaxLinksPerItem            int   `json:"maxLinksPerItem"`
	MaxPageSize                int   `json:"maxPageSize"`
	MaxRequestBytes            int   `json:"maxRequestBytes"`
	MinPasswordChars           int   `json:"minPasswordChars"`
	MaxPasswordBytes           int   `json:"maxPasswordBytes"`
	MaxMCPTokens               int   `json:"maxMcpTokens"`
	MaxMCPTokenNameChars       int   `json:"maxMcpTokenNameChars"`
	MaxResultTextBytes         int   `json:"maxResultTextBytes"`
	MaxAILogTextBytes          int   `json:"maxAiLogTextBytes"`
}

// Meta returns the instance capabilities.
func (a *App) Meta(ctx context.Context) (Meta, error) {
	info, err := a.AIInfo(ctx)
	if err != nil {
		return Meta{}, err
	}
	path := a.mcp.Path
	if path == "" {
		path = DefaultMCPPath
	}
	m := MetaMCP{Enabled: a.mcp.Enabled, Path: path, AuthRequired: a.mcp.AuthRequired}
	if a.mcp.Enabled && a.mcp.PublicURL != "" {
		u := strings.TrimRight(a.mcp.PublicURL, "/") + path
		m.URL = &u
	}
	return Meta{
		Version: a.version,
		AI:      info,
		Judge:   a.JudgeStatus(),
		MCP:     m,
		Limits:  a.metaLimits(),
	}, nil
}

// metaLimits are the limits /meta publishes; Overview takes its limits from
// them too, so the two cannot disagree.
func (a *App) metaLimits() MetaLimits {
	return MetaLimits{
		MaxImportBytes:             a.limits.MaxImportBytes,
		MaxSourceBytes:             a.limits.MaxSourceBytes,
		MaxTitleChars:              domain.MaxTitleChars,
		MaxSummaryChars:            domain.MaxSummaryChars,
		MaxTextBytes:               domain.MaxTextBytes,
		MaxSourceURLChars:          domain.MaxURLChars,
		MaxSourceNoteChars:         domain.MaxSourceNoteChars,
		MaxTags:                    domain.MaxTags,
		MaxTagChars:                domain.MaxTagChars,
		MaxCollectionNameChars:     domain.MaxCollectionNameChars,
		MaxCollectionDescription:   domain.MaxCollectionDescriptionChars,
		TimeLimitMs:                Range{domain.MinTimeLimitMs, domain.MaxTimeLimitMs},
		MemoryLimitKb:              Range{domain.MinMemoryLimitKb, domain.MaxMemoryLimitKb},
		MaxTestCasesPerItem:        domain.MaxTestCasesPerItem,
		MaxTestDataBytes:           domain.MaxTestCaseBytes,
		MaxTestCaseNameChars:       domain.MaxTestCaseNameChars,
		MaxDraftTextChars:          MaxDraftTextChars,
		MaxInstructionChars:        domain.MaxGenerationInstructionChars,
		MaxPreviousDraftBytes:      domain.MaxPreviousDraftBytes,
		MaxGeneratedTestCases:      a.limits.MaxGeneratedTestCases,
		MaxLargeInputBytes:         MaxLargeInputBytes,
		MaxLargeTestCases:          a.limits.MaxLargeTestCases,
		MaxStylePresets:            domain.MaxStylePresets,
		MaxStyleNameChars:          domain.MaxStyleNameChars,
		MaxStyleInstructionsChars:  domain.MaxStyleInstructionsChars,
		MaxSystemPromptChars:       domain.MaxSystemPromptChars,
		MaxModelIDChars:            domain.MaxModelIDChars,
		MaxAPIKeyChars:             domain.MaxAPIKeyChars,
		MaxAIProviders:             domain.MaxAIProviders,
		MaxAIProviderNameChars:     domain.MaxAIProviderNameChars,
		MinAITimeoutSeconds:        domain.MinAITimeoutSeconds,
		MaxAITimeoutSeconds:        domain.MaxAITimeoutSeconds,
		MaxBundleNameChars:         domain.MaxBundleNameChars,
		MaxBundleDescriptionChars:  domain.MaxBundleDescriptionChars,
		MaxImportUncompressedBytes: domain.BundleExpansionFactor * a.limits.MaxImportBytes,
		MaxImportEntries:           domain.MaxBundleEntries,
		MaxImportCollections:       domain.MaxBundleCollections,
		MaxSolutionsPerItem:        domain.MaxSolutionsPerItem,
		MaxSolutionNameChars:       domain.MaxSolutionNameChars,
		MaxSolutionNotesChars:      domain.MaxSolutionNotesChars,
		MaxNotesChars:              a.limits.MaxNotesChars,
		MaxLinksPerItem:            a.limits.MaxLinksPerItem,
		MaxPageSize:                domain.MaxPageSize,
		MaxRequestBytes:            domain.MaxRequestBytes,
		MinPasswordChars:           MinPasswordChars,
		MaxPasswordBytes:           MaxPasswordBytes,
		MaxMCPTokens:               MaxMCPTokens,
		MaxMCPTokenNameChars:       maxMCPTokenName,
		MaxResultTextBytes:         domain.MaxResultTextBytes,
		MaxAILogTextBytes:          maxLogTextBytes,
	}
}

// CollectionNode is a collection with its children, for tree views.
type CollectionNode struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	ItemCount int              `json:"itemCount"`
	Children  []CollectionNode `json:"children"`
}

// Overview is a compact summary of the whole library, for an assistant
// working on it: with the user's test case preferences and the bounds items
// and test cases must keep to.
type Overview struct {
	Stats       domain.Stats        `json:"stats"`
	Collections []CollectionNode    `json:"collections"`
	Tags        []domain.Tag        `json:"tags"`
	Judge       JudgeStatus         `json:"judge"`
	Preferences OverviewPreferences `json:"preferences"`
	Limits      OverviewLimits      `json:"limits"`
}

// OverviewPreferences are the user's preferences about test cases (see
// preferenceSchema), for an assistant to follow.
type OverviewPreferences struct {
	GeneratedTestCases int  `json:"generatedTestCases"`
	LargeTestCase      bool `json:"largeTestCase"`
	LargeTestCaseCount int  `json:"largeTestCaseCount"`
	HideTestCases      bool `json:"hideTestCases"`
}

// OverviewLimits are the bounds an assistant writing items and test cases
// keeps to: a subset of MetaLimits, with the same names and values.
type OverviewLimits struct {
	MaxTestDataBytes       int   `json:"maxTestDataBytes"`
	MaxLargeInputBytes     int   `json:"maxLargeInputBytes"`
	MaxTestCasesPerItem    int   `json:"maxTestCasesPerItem"`
	MaxSourceBytes         int   `json:"maxSourceBytes"`
	TimeLimitMs            Range `json:"timeLimitMs"`
	MemoryLimitKb          Range `json:"memoryLimitKb"`
	MaxTitleChars          int   `json:"maxTitleChars"`
	MaxSummaryChars        int   `json:"maxSummaryChars"`
	MaxTags                int   `json:"maxTags"`
	MaxTagChars            int   `json:"maxTagChars"`
	MaxNotesChars          int   `json:"maxNotesChars"`
	MaxLinksPerItem        int   `json:"maxLinksPerItem"`
	MaxGeneratedTestCases  int   `json:"maxGeneratedTestCases"`
	MaxLargeTestCases      int   `json:"maxLargeTestCases"`
	MaxSolutionNameChars   int   `json:"maxSolutionNameChars"`
	MaxSolutionNotesChars  int   `json:"maxSolutionNotesChars"`
	MaxCollectionNameChars int   `json:"maxCollectionNameChars"`
}

// overviewLimits picks the overview's limits out of /meta's.
func (a *App) overviewLimits() OverviewLimits {
	m := a.metaLimits()
	return OverviewLimits{
		MaxTestDataBytes:       m.MaxTestDataBytes,
		MaxLargeInputBytes:     m.MaxLargeInputBytes,
		MaxTestCasesPerItem:    m.MaxTestCasesPerItem,
		MaxSourceBytes:         m.MaxSourceBytes,
		TimeLimitMs:            m.TimeLimitMs,
		MemoryLimitKb:          m.MemoryLimitKb,
		MaxTitleChars:          m.MaxTitleChars,
		MaxSummaryChars:        m.MaxSummaryChars,
		MaxTags:                m.MaxTags,
		MaxTagChars:            m.MaxTagChars,
		MaxNotesChars:          m.MaxNotesChars,
		MaxLinksPerItem:        m.MaxLinksPerItem,
		MaxGeneratedTestCases:  m.MaxGeneratedTestCases,
		MaxLargeTestCases:      m.MaxLargeTestCases,
		MaxSolutionNameChars:   m.MaxSolutionNameChars,
		MaxSolutionNotesChars:  m.MaxSolutionNotesChars,
		MaxCollectionNameChars: m.MaxCollectionNameChars,
	}
}

func testCasePreferences(p Preferences) OverviewPreferences {
	out := OverviewPreferences{GeneratedTestCases: DefaultGeneratedCases, LargeTestCaseCount: DefaultLargeTestCases, HideTestCases: true}
	if v, ok := p["generatedTestCases"].(int); ok {
		out.GeneratedTestCases = v
	}
	if v, ok := p["largeTestCase"].(bool); ok {
		out.LargeTestCase = v
	}
	if v, ok := p["largeTestCaseCount"].(int); ok {
		out.LargeTestCaseCount = v
	}
	if v, ok := p["hideTestCases"].(bool); ok {
		out.HideTestCases = v
	}
	return out
}

// TestCasePreferences returns the user's test case preferences, or their
// defaults if the preferences cannot be read.
func (a *App) TestCasePreferences(ctx context.Context) OverviewPreferences {
	p, err := a.GetPreferences(ctx)
	if err != nil {
		p = renderPreferences(nil, a.limits)
	}
	return testCasePreferences(p)
}

// Overview returns statistics, the collection tree, tags, the judge's
// languages, the user's test case preferences and the limits of items and
// test cases.
func (a *App) Overview(ctx context.Context) (Overview, error) {
	out := Overview{Judge: a.JudgeStatus(), Limits: a.overviewLimits()}
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		if out.Stats, err = tx.Stats(); err != nil {
			return err
		}
		stored, err := a.storedPreferences(ctx, tx)
		if err != nil {
			return err
		}
		out.Preferences = testCasePreferences(renderPreferences(stored, a.limits))
		if out.Tags, err = tx.ListTags(); err != nil {
			return err
		}
		all, err := tx.ListCollections()
		if err != nil {
			return err
		}
		out.Collections = tree(all, nil)
		return nil
	})
	return out, err
}

func tree(all []domain.Collection, parent *string) []CollectionNode {
	out := []CollectionNode{}
	for _, c := range siblings(all, parent, "") {
		id := c.ID
		out = append(out, CollectionNode{ID: c.ID, Name: c.Name, ItemCount: c.ItemCount, Children: tree(all, &id)})
	}
	return out
}
