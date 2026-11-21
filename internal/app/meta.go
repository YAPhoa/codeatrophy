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
	MaxPageSize                int   `json:"maxPageSize"`
	MaxRequestBytes            int   `json:"maxRequestBytes"`
}

// Meta returns the instance capabilities.
func (a *App) Meta(ctx context.Context) (Meta, error) {
	info, err := a.AIInfo(ctx)
	if err != nil {
		return Meta{}, err
	}
	path := a.mcp.Path
	if path == "" {
		path = "/mcp"
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
		Limits: MetaLimits{
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
			MaxGeneratedTestCases:      MaxGeneratedCases,
			MaxLargeInputBytes:         MaxLargeInputBytes,
			MaxLargeTestCases:          MaxLargeTestCases,
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
			MaxPageSize:                domain.MaxPageSize,
			MaxRequestBytes:            domain.MaxRequestBytes,
		},
	}, nil
}

// CollectionNode is a collection with its children, for tree views.
type CollectionNode struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	ItemCount int              `json:"itemCount"`
	Children  []CollectionNode `json:"children"`
}

// Overview is a compact summary of the whole library, for an assistant
// working on it: with the user's test case preferences and the bounds test
// cases must keep to.
type Overview struct {
	Stats       domain.Stats        `json:"stats"`
	Collections []CollectionNode    `json:"collections"`
	Tags        []domain.Tag        `json:"tags"`
	Judge       JudgeStatus         `json:"judge"`
	Preferences OverviewPreferences `json:"preferences"`
	Limits      TestLimits          `json:"limits"`
}

// OverviewPreferences are the user's preferences about test cases (see
// preferenceSchema), for an assistant to follow.
type OverviewPreferences struct {
	GeneratedTestCases int  `json:"generatedTestCases"`
	LargeTestCase      bool `json:"largeTestCase"`
	LargeTestCaseCount int  `json:"largeTestCaseCount"`
	HideTestCases      bool `json:"hideTestCases"`
}

// TestLimits are the bounds of test cases, named as in MetaLimits.
type TestLimits struct {
	MaxTestDataBytes    int   `json:"maxTestDataBytes"`
	MaxLargeInputBytes  int   `json:"maxLargeInputBytes"`
	MaxTestCasesPerItem int   `json:"maxTestCasesPerItem"`
	MaxSourceBytes      int   `json:"maxSourceBytes"`
	TimeLimitMs         Range `json:"timeLimitMs"`
	MemoryLimitKb       Range `json:"memoryLimitKb"`
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

// TestCasePreferences returns the user's test case preferences.
func (a *App) TestCasePreferences(ctx context.Context) (OverviewPreferences, error) {
	p, err := a.GetPreferences(ctx)
	if err != nil {
		return OverviewPreferences{}, err
	}
	return testCasePreferences(p), nil
}

// Overview returns statistics, the collection tree, tags, the judge's
// languages, the user's test case preferences and the test case limits.
func (a *App) Overview(ctx context.Context) (Overview, error) {
	out := Overview{Judge: a.JudgeStatus(), Limits: TestLimits{
		MaxTestDataBytes:    domain.MaxTestCaseBytes,
		MaxLargeInputBytes:  MaxLargeInputBytes,
		MaxTestCasesPerItem: domain.MaxTestCasesPerItem,
		MaxSourceBytes:      a.limits.MaxSourceBytes,
		TimeLimitMs:         Range{domain.MinTimeLimitMs, domain.MaxTimeLimitMs},
		MemoryLimitKb:       Range{domain.MinMemoryLimitKb, domain.MaxMemoryLimitKb},
	}}
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		if out.Stats, err = tx.Stats(); err != nil {
			return err
		}
		stored, err := a.storedPreferences(tx)
		if err != nil {
			return err
		}
		out.Preferences = testCasePreferences(renderPreferences(stored))
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
