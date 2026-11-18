// Package store defines the persistence interface used by the application
// services. Implementations live in sub-packages.
package store

import (
	"context"
	"errors"
	"time"

	"codeatrophy/internal/domain"
)

// ErrNotFound is returned when a requested record does not exist.
var ErrNotFound = errors.New("not found")

// Sort orders for ListItems.
const (
	SortUpdated    = "updated"
	SortCreated    = "created"
	SortTitle      = "title"
	SortDifficulty = "difficulty"
	SortPosition   = "position"
	SortRelevance  = "relevance"
)

// ItemFilter selects and orders items. Zero values mean "no constraint".
type ItemFilter struct {
	Query        string
	IDs          []string // any of these ids
	Type         domain.ItemType
	Statuses     []domain.ItemStatus
	Difficulties []string // difficulty values, or "none" for no difficulty
	Tags         []string // item must carry all of them
	CollectionID string
	Recursive    bool
	Uncollected  bool
	VariantOf    string
	Favorite     *bool
	Sort         string
	Desc         bool
	Limit        int // 0 means no limit
	Offset       int
}

// AIProvider is a saved AI provider as stored. Model and BaseURL are ""
// when the kind's default applies. APIKey is ciphertext ("" when no key is
// stored), bound to the kind and APIKeyOrigin.
type AIProvider struct {
	ID           string
	Name         string
	Kind         string
	Model        string
	BaseURL      string
	APIKey       string
	APIKeyOrigin string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// AIUsageRecord is one finished request to an AI provider.
type AIUsageRecord struct {
	ProviderID string
	At         time.Time
	Failed     bool
	// Token counts the service reported; 0 when it reported none.
	InputTokens, OutputTokens int64
}

// AIUsageTotals sums the requests of a period.
type AIUsageTotals struct {
	Requests, Failed, InputTokens, OutputTokens int64
}

// AIUsage is one provider's usage: over the recent days asked for, over all
// time, and when it was last used.
type AIUsage struct {
	Recent, AllTime AIUsageTotals
	LastUsedAt      time.Time
}

// AILogEntry is the index row of one request in the AI activity log.
type AILogEntry struct {
	ID           string
	CreatedAt    time.Time
	Operation    string
	ItemID       *string
	Title        *string
	ProviderID   string
	ProviderName string
	Kind         string
	Model        string
	Status       string
	Error        *string
	DurationMs   int
	// Token counts, nil where the provider reported none.
	InputTokens, OutputTokens, ReasoningTokens, CacheReadTokens, CacheWriteTokens *int
}

// AILogBody is what an AI log entry sent and received. Stores keep the
// system text once per distinct text and compress everything (see
// CompressText).
type AILogBody struct {
	System string
	// Request is the rest of the request, JSON.
	Request   string
	Response  *string
	Truncated bool
}

// AILogFilter selects AI log entries; zero values select everything.
type AILogFilter struct {
	ProviderID, Operation, Status string
	// Before starts the page after this entry (keyset paging).
	Before *AILogCursor
	Limit  int
}

// AILogCursor is a position in the AI log, which is ordered newest first
// by (created time, id).
type AILogCursor struct {
	CreatedAt time.Time
	ID        string
}

// UsageDay is the UTC day of t, in days since 1970-01-01: the unit AI usage
// is kept in.
func UsageDay(t time.Time) int64 {
	sec := t.Unix()
	if sec < 0 {
		return (sec - 86399) / 86400
	}
	return sec / 86400
}

// Store gives transactional access to the library.
type Store interface {
	// Read runs fn in a read-only transaction with a consistent snapshot.
	Read(ctx context.Context, fn func(Tx) error) error
	// Write runs fn in a read-write transaction. Writers are serialized.
	// If fn returns an error the transaction is rolled back.
	Write(ctx context.Context, fn func(Tx) error) error
	Close() error
}

// Tx is the set of operations available inside a transaction. Methods
// returning a single record return ErrNotFound when it does not exist.
type Tx interface {
	// Items. Computed fields (collectionIds, variantCount, testCaseCount,
	// lastVerdict) are filled on read and ignored on write.
	GetItem(id string) (domain.Item, error)
	ListItems(f ItemFilter) ([]domain.ItemSummary, int, error)
	AllItemIDs() ([]string, error)
	ExistingItemIDs(ids []string) (map[string]bool, error)
	InsertItem(it *domain.Item) error
	UpdateItem(it *domain.Item) error
	// DeleteItem removes an item with its test cases, submissions and
	// memberships, and clears variantOf on its variants.
	DeleteItem(id string) (bool, error)
	// SetItemCollections makes the item a member of exactly these
	// collections; new memberships are appended at the end.
	SetItemCollections(itemID string, collectionIDs []string) error

	// Tags.
	ListTags() ([]domain.Tag, error)
	ItemIDsWithTag(name string) ([]string, error)

	// Test cases, ordered by position.
	ListTestCases(itemID string) ([]domain.TestCase, error)
	GetTestCase(id string) (domain.TestCase, error)
	InsertTestCase(tc *domain.TestCase) error
	UpdateTestCase(tc *domain.TestCase) error
	DeleteTestCase(id string) error
	DeleteTestCases(itemID string) error
	// SetTestCasePositions renumbers the item's cases in the given order.
	SetTestCasePositions(itemID string, ids []string) error

	// Collections, ordered by parent and position.
	ListCollections() ([]domain.Collection, error)
	GetCollection(id string) (domain.Collection, error)
	InsertCollection(c *domain.Collection) error
	UpdateCollection(c *domain.Collection) error
	DeleteCollection(id string) error
	CollectionItemIDs(id string) ([]string, error)
	SetCollectionItemIDs(id string, itemIDs []string) error
	AddCollectionItems(id string, itemIDs []string) error
	RemoveCollectionItem(id, itemID string) (bool, error)

	// Submissions. GetSubmission includes results.
	InsertSubmission(s *domain.Submission) error
	GetSubmission(id string) (domain.Submission, error)
	ListSubmissions(itemID string, mode domain.SubmissionMode, limit, offset int) ([]domain.SubmissionSummary, int, error)
	UpdateSubmission(s *domain.Submission) error
	AddSubmissionResult(submissionID string, index int, r domain.SubmissionResult) error
	UnfinishedSubmissionIDs() ([]string, error)
	// DeleteCompletedRuns removes an item's completed run-mode submissions
	// with their results. Submit-mode and unfinished ones are kept.
	DeleteCompletedRuns(itemID string) error

	Stats() (domain.Stats, error)

	// Solutions of a problem: the reference first, then oldest first.
	// Item reads fill problem.referenceSolution from them; item writes
	// ignore it.
	ListSolutions(itemID string) ([]domain.ItemSolution, error)
	GetSolution(id string) (domain.ItemSolution, error)
	InsertSolution(s *domain.ItemSolution) error
	UpdateSolution(s *domain.ItemSolution) error
	DeleteSolution(id string) error
	DeleteSolutions(itemID string) error
	// ClearReference unsets isReference on every solution of the item.
	ClearReference(itemID string) error

	// Style presets, default first, then by name.
	ListStylePresets() ([]domain.StylePreset, error)
	GetStylePreset(id string) (domain.StylePreset, error)
	InsertStylePreset(p *domain.StylePreset) error
	UpdateStylePreset(p *domain.StylePreset) error
	DeleteStylePreset(id string) error
	// ClearDefaultStylePreset unsets isDefault on every preset.
	ClearDefaultStylePreset() error

	// Saved AI providers, by name.
	ListAIProviders() ([]AIProvider, error)
	GetAIProvider(id string) (AIProvider, error)
	InsertAIProvider(p *AIProvider) error
	// UpdateAIProvider changes everything but the id and the kind.
	UpdateAIProvider(p *AIProvider) error
	DeleteAIProvider(id string) error

	// AI usage, per provider id (saved or environment provider) and UTC
	// day. RecordAIUsage adds one request to its day.
	RecordAIUsage(r AIUsageRecord) error
	// AIUsage returns the usage of every provider that has any; Recent sums
	// the days from sinceDay (see UsageDay) on.
	AIUsage(sinceDay int64) (map[string]AIUsage, error)
	DeleteAIUsage(providerID string) error

	// The AI activity log, newest first by (created time, id). It is
	// append-only: entries are inserted once and removed only by
	// DeleteAILog, which also drops system texts no entry uses any more.
	InsertAILogEntry(e AILogEntry, body AILogBody) error
	// ListAILog returns at most f.Limit entries and the number of entries
	// matching the filters (ignoring Before); it reads no bodies.
	ListAILog(f AILogFilter) ([]AILogEntry, int, error)
	GetAILogEntry(id string) (AILogEntry, AILogBody, error)
	// DeleteAILog removes the entries created before the time, or all.
	DeleteAILog(before *time.Time) error

	// Settings are opaque key/value pairs.
	GetSetting(key string) (string, bool, error)
	SetSetting(key, value string) error
	DeleteSetting(key string) error
}
