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
	SortRelevance  = "relevance" // with no query, the latest added first
)

// Fields CountItemsBy groups by.
const (
	GroupType       = "type"
	GroupStatus     = "status"
	GroupDifficulty = "difficulty" // "none" for items without one
	GroupTag        = "tag"        // an item counts once for each of its tags
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
// stored), bound to the kind and APIKeyOrigin. Effort is "low", "medium" or
// "high", or "" (NULL in the database) for the model's own default.
type AIProvider struct {
	ID           string
	Name         string
	Kind         string
	Model        string
	BaseURL      string
	APIKey       string
	APIKeyOrigin string
	Effort       string
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
	UserID       string // the account whose request it was
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
	// UserID is the account whose entries to list; it always applies.
	UserID                        string
	ProviderID, Operation, Status string
	// Before starts the page after this entry (keyset paging).
	Before *AILogCursor
	Limit  int
	// Offset skips that many entries (after Before, if both are set).
	Offset int
}

// AILogCursor is a position in the AI log, which is ordered newest first
// by (created time, id).
type AILogCursor struct {
	CreatedAt time.Time
	ID        string
}

// AIJob is one AI request run in the background. Request, Result and Error
// are JSON documents; stores compress the request and the result (see
// CompressText). Result is set for a job that succeeded, Error for one that
// failed.
type AIJob struct {
	ID        string
	UserID    string // the account that asked for it
	CreatedAt time.Time
	Kind      string
	ItemID    *string
	// DraftID is the draft the job generates for, if any.
	DraftID *string
	Title   string
	Status  string
	// Origin is an opaque string the client gave (the screen to return to).
	Origin     *string
	Request    string
	Result     *string
	Error      *string
	StartedAt  *time.Time
	FinishedAt *time.Time
	PickedUpAt *time.Time
}

// AIJob statuses. Queued and running jobs are active; the others are
// finished.
const (
	JobQueued    = "queued"
	JobRunning   = "running"
	JobSucceeded = "succeeded"
	JobFailed    = "failed"
	JobCancelled = "cancelled"
)

// AIJobFilter selects AI jobs; zero values select everything.
type AIJobFilter struct {
	// UserID, when set, selects the jobs of that account only.
	UserID *string
	// Active selects queued and running jobs only.
	Active  bool
	Kind    string
	ItemID  string
	DraftID string
	// PickedUp, when set, selects jobs whose result was (true) or was not
	// (false) picked up.
	PickedUp *bool
	Limit    int
}

// Draft is a new item in progress. Request, Generation and Content are
// JSON documents, which stores compress (see CompressText); Error is JSON.
type Draft struct {
	ID        string
	UserID    string // the account it belongs to
	CreatedAt time.Time
	UpdatedAt time.Time
	Kind      string
	VariantOf *string
	// Title is the label lists show; ClientTitle the title the client set.
	Title         string
	ClientTitle   *string
	Revision      int
	Edited        bool
	Request       *string
	JobID         *string
	Error         *string
	Generation    *string
	GenerationSeq int
	Content       *string
	BasedOn       int
}

// DraftFilter selects drafts of one account; other zero values select
// everything.
type DraftFilter struct {
	UserID    string
	Kind      string
	VariantOf string
}

// LinkPair orders the ids of a link as it is stored: the smaller first.
func LinkPair(a, b string) (string, string) {
	if b < a {
		return b, a
	}
	return a, b
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

// User is an account that may sign in to the web UI. Email is stored in
// lower case and is unique. PasswordHash is a bcrypt hash.
type User struct {
	ID           string
	Email        string
	PasswordHash string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Session is a signed-in browser session. ID is the SHA-256 hash (hex) of
// the token in the browser's cookie; the token itself is never stored.
// UserAgent is the browser's User-Agent when the session started ("" when
// unknown). LastUsedAt moves with the expiry (see ExtendSession).
type Session struct {
	ID         string
	UserID     string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	UserAgent  string
	LastUsedAt time.Time
}

// MCPToken is a bearer token an account made for MCP clients. ID is the
// SHA-256 hash (hex) of the token; the token itself is never stored. Hint
// is the token's last characters, to tell tokens apart in a list.
type MCPToken struct {
	ID         string
	UserID     string
	Name       string
	Hint       string
	CreatedAt  time.Time
	LastUsedAt *time.Time
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
	// Items. Computed fields (collectionIds, variantCount, linkCount,
	// testCaseCount, lastVerdict, variantOrigin) are filled on read and
	// ignored on write. Inserting an item removes the record kept of a
	// deleted item with its id. Status, favorite, notes and lastVerdict are
	// those of the account in the transaction's context (see AccountOf),
	// in reads, filters and writes alike; an account that never set them
	// has todo, false and "".
	GetItem(id string) (domain.Item, error)
	ListItems(f ItemFilter) ([]domain.ItemSummary, int, error)
	// CountItemsBy counts the items ListItems selects for f (its order and
	// page are ignored) by the value of a Group field. Values no matching
	// item has are left out.
	CountItemsBy(f ItemFilter, group string) (map[string]int, error)
	AllItemIDs() ([]string, error)
	ExistingItemIDs(ids []string) (map[string]bool, error)
	InsertItem(it *domain.Item) error
	UpdateItem(it *domain.Item) error
	// DeleteItem removes an item with its test cases, solutions,
	// submissions, working copies and memberships, and keeps a record of it
	// (its id, title and type, and the time given) for the links and
	// variants that still name it. Its links and its variants' variantOf
	// are kept.
	DeleteItem(id string, at time.Time) (bool, error)
	// SetItemCollections makes the item a member of exactly these
	// collections; new memberships are appended at the end.
	SetItemCollections(itemID string, collectionIDs []string) error

	// Links between items: unordered pairs of different item ids. A link
	// stays when either item is deleted (or was never in this library), so
	// the other end may be unavailable. ItemLinks returns the links of an
	// item, available items first, each group oldest link first.
	ItemLinks(id string) ([]domain.LinkedItem, error)
	// LinkItems links two items; a pair already linked is left as it is.
	// It reports whether it added the link.
	LinkItems(a, b string, at time.Time) (bool, error)
	// UnlinkItems removes the link between two items, reporting whether
	// there was one.
	UnlinkItems(a, b string) (bool, error)

	// Tags are records of their own, and a tag stays when no item carries
	// it any more. Writing an item registers the tags it carries.
	// ListTags returns every tag, by name, with the number of items that
	// carry it (0 for an empty tag).
	ListTags() ([]domain.Tag, error)
	TagExists(name string) (bool, error)
	// InsertTag registers a tag; one that exists is left as it is.
	InsertTag(name string) error
	// DeleteTag removes a tag that no item carries.
	DeleteTag(name string) error
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

	// Collections, ordered by parent and position: those of the account in
	// the transaction's context (see AccountOf), which inserts write to.
	// Another account's collection is not found, and an item's
	// collectionIds and the collection filters and counts of items take
	// the account's collections only. CollectionIDTaken reports whether any
	// account has a collection with that id. The membership methods take a
	// collection the caller found.
	ListCollections() ([]domain.Collection, error)
	CollectionIDTaken(id string) (bool, error)
	GetCollection(id string) (domain.Collection, error)
	InsertCollection(c *domain.Collection) error
	UpdateCollection(c *domain.Collection) error
	DeleteCollection(id string) error
	CollectionItemIDs(id string) ([]string, error)
	SetCollectionItemIDs(id string, itemIDs []string) error
	AddCollectionItems(id string, itemIDs []string) error
	RemoveCollectionItem(id, itemID string) (bool, error)

	// Submissions, each of an account (UserID). GetSubmission includes
	// results, whoever owns it; ListSubmissions lists one account's.
	InsertSubmission(s *domain.Submission) error
	GetSubmission(id string) (domain.Submission, error)
	ListSubmissions(userID, itemID string, mode domain.SubmissionMode, limit, offset int) ([]domain.SubmissionSummary, int, error)
	UpdateSubmission(s *domain.Submission) error
	AddSubmissionResult(submissionID string, index int, r domain.SubmissionResult) error
	UnfinishedSubmissionIDs() ([]string, error)
	// DeleteCompletedRuns removes an account's completed run-mode
	// submissions of an item with their results. Submit-mode and
	// unfinished ones are kept.
	DeleteCompletedRuns(userID, itemID string) error

	// Stats counts the library, with the item statuses, favorites and
	// submissions of the account in the transaction's context.
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

	// Working copies: one per account, problem and language, deleted with
	// the item. ListWorkingCopies returns an account's working copies of an
	// item, the most recently written first.
	ListWorkingCopies(userID, itemID string) ([]domain.WorkingCopy, error)
	// PutWorkingCopy creates or replaces the working copy of w.UserID for
	// w.ItemID in w.Language, in one statement that writes the whole row. It returns
	// ErrNotFound, writing nothing, when no problem with that id exists (a
	// missing item or a reading).
	PutWorkingCopy(w *domain.WorkingCopy) error
	// DeleteWorkingCopy removes an account's working copy of an item in a
	// language, reporting whether there was one.
	DeleteWorkingCopy(userID, itemID, language string) (bool, error)

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
	// DeleteAILog removes an account's entries created before the time, or
	// all of them.
	DeleteAILog(userID string, before *time.Time) error

	// AI jobs, newest first by (created time, id). GetAIJob reads the
	// request and the result; ListAIJobs leaves them out (Request "",
	// Result nil). UpdateAIJob changes everything but the id, the creation
	// time, the kind and the request.
	InsertAIJob(j *AIJob) error
	GetAIJob(id string) (AIJob, error)
	ListAIJobs(f AIJobFilter) ([]AIJob, error)
	UpdateAIJob(j *AIJob) error
	DeleteAIJob(id string) (bool, error)
	// PruneAIJobs deletes finished jobs that finished before the time, and
	// then every finished job beyond the newest keep jobs (counting active
	// ones, which are never deleted). It returns how many it deleted.
	PruneAIJobs(finishedBefore time.Time, keep int) (int, error)

	// Drafts, most recently changed first by (updated time, id).
	// GetDraft reads every field; ListDrafts leaves out Request, Generation
	// and Content. UpdateDraft changes everything but the id, the creation
	// time and the kind.
	InsertDraft(d *Draft) error
	GetDraft(id string) (Draft, error)
	ListDrafts(f DraftFilter) ([]Draft, error)
	UpdateDraft(d *Draft) error
	DeleteDraft(id string) (bool, error)

	// Users, by email. InsertUser fails on an email already taken.
	// DeleteUser removes the user's sessions, tokens and personal data
	// too. ClaimUnowned gives the personal data of Unowned to the user.
	CountUsers() (int, error)
	ListUsers() ([]User, error)
	GetUser(id string) (User, error)
	GetUserByEmail(email string) (User, error)
	InsertUser(u *User) error
	UpdateUserPassword(id, passwordHash string, at time.Time) error
	DeleteUser(id string) (bool, error)
	ClaimUnowned(userID string) error

	// Sessions. GetSession and ListUserSessions return sessions whatever
	// their expiry; callers compare ExpiresAt. ListUserSessions orders a
	// user's sessions by last use, newest first. ExtendSession records a use
	// at usedAt and sets the expiry. DeleteUserSessions removes every
	// session of a user but except (which may be ""). DeleteExpiredSessions
	// removes those that expired before the time.
	InsertSession(s *Session) error
	GetSession(id string) (Session, error)
	ListUserSessions(userID string) ([]Session, error)
	ExtendSession(id string, usedAt, expiresAt time.Time) error
	// SetSessionUserAgent records the User-Agent of a session that has none
	// (one from before they were recorded); it leaves a recorded one alone.
	SetSessionUserAgent(id, userAgent string) error
	DeleteSession(id string) error
	DeleteUserSessions(userID, except string) error
	DeleteExpiredSessions(before time.Time) error

	// MCP tokens, per user, newest first. DeleteMCPToken removes a token
	// of that user only, reporting whether there was one.
	ListMCPTokens(userID string) ([]MCPToken, error)
	GetMCPToken(id string) (MCPToken, error)
	InsertMCPToken(t *MCPToken) error
	TouchMCPToken(id string, at time.Time) error
	DeleteMCPToken(userID, id string) (bool, error)

	// Settings are opaque key/value pairs.
	GetSetting(key string) (string, bool, error)
	SetSetting(key, value string) error
	DeleteSetting(key string) error
}
