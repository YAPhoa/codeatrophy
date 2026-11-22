package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ErrNewerSchema is returned when opening a database whose schema version is
// newer than this server knows. The database is left unchanged.
var ErrNewerSchema = errors.New("this database was last used by a newer Codeatrophy; upgrade the server")

// ErrOlderSchema is returned when opening a database last used by a
// Codeatrophy older than 1.0.0, which this server cannot migrate. The
// database is left unchanged.
var ErrOlderSchema = errors.New("this database was last used by a Codeatrophy older than 1.0.0; " +
	"upgrade it with Codeatrophy 1.0.0 first, then with this version")

// BaselineVersion is the schema version of Codeatrophy 1.0.0, the oldest
// this server migrates a database from.
const BaselineVersion = 22

// TooOld reports whether a database at the schema version is one this
// server cannot migrate: it has a schema, older than BaselineVersion.
func TooOld(version int) bool { return version > 0 && version < BaselineVersion }

// OlderSchemaError is the error for a database at a version that is
// TooOld. It matches ErrOlderSchema.
func OlderSchemaError(version int) error {
	return fmt.Errorf("database schema version %d is older than this server can migrate (%d, of Codeatrophy 1.0.0): %w",
		version, BaselineVersion, ErrOlderSchema)
}

// SchemaVersion is the logical schema version this server expects. Every
// backend keeps its own numbered migrations, and the latest migration of
// each must bring its database to this version: a schema change adds one
// migration per backend with the next number and bumps this constant (and
// Tables, when tables or columns change).
const SchemaVersion = 22

// Table is a table of the logical schema: the tables and columns every
// backend has, whatever their physical types. Backend-specific tables, such
// as the search index and the migration record, are not part of it.
type Table struct {
	Name    string
	Columns []string
	// Key orders the rows when copying: the insertion sequence for tables
	// that have one, otherwise the primary key.
	Key []string
}

// Tables is the logical schema, ordered so that a table comes after the
// tables it references.
var Tables = []Table{
	{Name: "settings", Columns: []string{"key", "value"}, Key: []string{"key"}},
	{Name: "users", Columns: []string{"id", "email", "password_hash", "created_at", "updated_at"}, Key: []string{"id"}},
	{Name: "sessions", Columns: []string{"id", "user_id", "created_at", "expires_at", "user_agent", "last_used_at"},
		Key: []string{"id"}},
	{Name: "mcp_tokens", Columns: []string{"id", "user_id", "name", "hint", "created_at", "last_used_at"},
		Key: []string{"id"}},
	{Name: "ai_providers", Columns: []string{"seq", "id", "name", "name_key", "kind", "model", "base_url", "api_key",
		"api_key_origin", "created_at", "updated_at", "effort"}, Key: []string{"seq"}},
	{Name: "ai_usage", Columns: []string{"provider_id", "day", "requests", "failed", "input_tokens", "output_tokens",
		"last_used_at"}, Key: []string{"provider_id", "day"}},
	{Name: "ai_log", Columns: []string{"id", "created_at", "operation", "item_id", "title", "provider_id",
		"provider_name", "kind", "model", "status", "error", "duration_ms", "input_tokens", "output_tokens",
		"reasoning_tokens", "cache_read_tokens", "cache_write_tokens", "user_id"}, Key: []string{"created_at", "id"}},
	{Name: "ai_log_texts", Columns: []string{"hash", "text"}, Key: []string{"hash"}},
	{Name: "ai_log_bodies", Columns: []string{"entry_id", "system_hash", "request", "response", "truncated"},
		Key: []string{"entry_id"}},
	{Name: "ai_jobs", Columns: []string{"id", "created_at", "kind", "item_id", "draft_id", "title", "status", "origin",
		"request", "result", "error", "started_at", "finished_at", "picked_up_at", "user_id"}, Key: []string{"created_at", "id"}},
	{Name: "drafts", Columns: []string{"id", "created_at", "updated_at", "kind", "variant_of", "title", "client_title",
		"revision", "edited", "request", "job_id", "error", "generation", "generation_seq", "content", "based_on",
		"user_id"},
		Key: []string{"created_at", "id"}},
	{Name: "style_presets", Columns: []string{"seq", "id", "name", "name_key", "instructions", "is_default",
		"created_at", "updated_at"}, Key: []string{"seq"}},
	{Name: "items", Columns: []string{"seq", "id", "type", "title", "summary", "body", "difficulty",
		"raw_input", "source_url", "source_note", "variant_of", "revision", "time_limit_ms",
		"memory_limit_kb", "compare_mode", "starter_code", "created_at", "updated_at", "problem_interface", "harness",
		"created_via", "created_client", "created_model", "updated_via", "updated_client", "updated_model"},
		Key: []string{"seq"}},
	{Name: "item_states", Columns: []string{"user_id", "item_id", "status", "favorite", "notes"},
		Key: []string{"user_id", "item_id"}},
	{Name: "item_links", Columns: []string{"seq", "item_a", "item_b", "created_at"}, Key: []string{"seq"}},
	{Name: "deleted_items", Columns: []string{"id", "title", "type", "deleted_at"}, Key: []string{"id"}},
	{Name: "tags", Columns: []string{"name"}, Key: []string{"name"}},
	{Name: "item_tags", Columns: []string{"item_id", "tag"}, Key: []string{"item_id", "tag"}},
	{Name: "collections", Columns: []string{"seq", "id", "name", "description", "parent_id", "position",
		"created_at", "updated_at", "user_id"}, Key: []string{"seq"}},
	{Name: "collection_items", Columns: []string{"collection_id", "item_id", "position"},
		Key: []string{"collection_id", "item_id"}},
	{Name: "test_cases", Columns: []string{"seq", "id", "item_id", "position", "name", "stdin", "expected_stdout",
		"is_sample", "origin", "verified", "created_at", "updated_at", "generator_language", "generator_source"},
		Key: []string{"seq"}},
	{Name: "solutions", Columns: []string{"seq", "id", "item_id", "name", "language", "source", "notes",
		"is_reference", "created_at", "updated_at", "last_run_passed", "last_run_total", "last_run_time_ms",
		"last_run_memory_kb", "last_run_at"}, Key: []string{"seq"}},
	{Name: "working_copies", Columns: []string{"item_id", "language", "source", "updated_at", "write_seq", "user_id"},
		Key: []string{"user_id", "item_id", "language"}},
	{Name: "submissions", Columns: []string{"seq", "id", "item_id", "mode", "language", "source", "stdin",
		"case_ids", "status", "verdict", "passed_count", "total_count", "time_ms", "memory_kb", "compile_output",
		"error", "created_at", "finished_at", "line_offset", "harness", "user_id"}, Key: []string{"seq"}},
	{Name: "submission_results", Columns: []string{"submission_id", "idx", "test_case_id", "name", "is_sample",
		"verdict", "stdin", "expected_stdout", "stdout", "stderr", "time_ms", "memory_kb"},
		Key: []string{"submission_id", "idx"}},
}

// TableByName returns the logical table with that name.
func TableByName(name string) (Table, bool) {
	for _, t := range Tables {
		if t.Name == name {
			return t, true
		}
	}
	return Table{}, false
}

// ErrMigrationNeeded is returned when a database opened without migrating
// is behind this server's schema, or has no schema yet.
var ErrMigrationNeeded = errors.New("the database needs migrating")

// MigrationNeededError describes a database that needs migrating. It
// matches ErrMigrationNeeded.
type MigrationNeededError struct {
	// Version is the database's schema version, 0 when it has none yet.
	Version int
	// Expected is the version this server's migrations reach.
	Expected int
	// Pending are the names of the migrations not applied yet.
	Pending []string
}

func (e *MigrationNeededError) Error() string {
	at := fmt.Sprintf("the database is at schema version %d", e.Version)
	if e.Version == 0 {
		at = "the database has no schema yet (version 0)"
	}
	return fmt.Sprintf("%s and this server expects version %d (pending: %s)", at, e.Expected,
		strings.Join(e.Pending, ", "))
}

func (e *MigrationNeededError) Unwrap() error { return ErrMigrationNeeded }

// Status describes a database without changing it.
type Status struct {
	Backend string
	// Location is the file path, or the URL without its password.
	Location string
	// Exists is false when there is no database there yet.
	Exists bool
	// Version is the schema version, 0 when there is no schema yet.
	Version int
	// Latest is the version this server's migrations reach.
	Latest int
	// Pending are the names of the migrations not applied yet; none for a
	// database that is TooOld.
	Pending []string
	// Counts are the row counts of the logical tables that exist.
	Counts []TableCount
}

// TableCount is the number of rows of a table.
type TableCount struct {
	Table string
	Rows  int64
}

// Bulk is implemented by stores whose complete contents can be copied to
// another store, of the same backend or another one. Row values are
// backend-neutral: nil, int64 (integers and flags, as 0 or 1) or string.
type Bulk interface {
	// Backend names the backend, such as "SQLite" or "PostgreSQL".
	Backend() string
	// SchemaVersion is the logical schema version of the open database.
	SchemaVersion(ctx context.Context) (int, error)
	// Export runs fn with read access to every row, in one consistent
	// snapshot.
	Export(ctx context.Context, fn func(Dump) error) error
	// Import runs fn in one write transaction that may replace every row;
	// it commits only if fn returns nil.
	Import(ctx context.Context, fn func(Load) error) error
}

// Dump reads rows of the logical tables.
type Dump interface {
	// Rows calls fn for each row of t in key order, with the values in the
	// order of t.Columns. The slice is only valid during the call.
	Rows(t Table, fn func(row []any) error) error
	// Count returns the number of rows of t.
	Count(t Table) (int64, error)
}

// Load writes rows of the logical tables, inside an Import transaction.
// Reads see the rows written so far.
type Load interface {
	Dump
	// Clear deletes every row of every table, including derived data such
	// as the search index.
	Clear() error
	// Insert adds a row to t, values in the order of t.Columns. Foreign
	// keys are checked when Finish is called, so rows may refer to rows
	// inserted later.
	Insert(t Table, row []any) error
	// Finish writes pending rows, rebuilds derived data (the search index,
	// insertion sequences) and checks the foreign keys.
	Finish() error
}

// BuiltinStylePreset is one of the style presets a new database is seeded
// with by its schema migrations.
type BuiltinStylePreset struct {
	Name         string
	Instructions string
	IsDefault    bool
}

// BuiltinStylePresets are the presets a new database holds once every
// migration of its backend has run, in insertion order: migration 5 seeds
// them and migration 15 refreshes the text of each one still as seeded. The
// migrations hold their own copy of the text (a migration never changes
// once released); tests check that the copies agree.
var BuiltinStylePresets = []BuiltinStylePreset{
	{Name: "Interview practice", IsDefault: true,
		Instructions: `Write the statement the way an interviewer would pose it: two or three short paragraphs in plain language, with no back-story. Name the inputs and say exactly what to return or print. Give two or three small examples, each followed by one or two sentences explaining why that output is correct. Keep the constraints to a short list, chosen so that the intended time complexity matters. Under Notes, add a "Follow-up" line that asks for a better complexity or a harder twist without giving the approach away, then one collapsed "Hint" that points toward the approach without naming it. For a reading: close with "Likely questions", three questions an interviewer might ask, each with its answer collapsed. Starter code in Python and Java.`},
	{Name: "Contest style",
		Instructions: `Write in the style of a programming-contest problem: a short, concrete scenario of at most one paragraph, then a precise formal statement. Use math notation for every bound, and put a formula the statement defines in a display equation. Choose the limits so that the intended complexity is implied but never named. Give at least two examples and explain only the non-obvious one, under Notes. When that example is a small graph or tree, draw it there as a small Mermaid diagram with plain labels. No hints. Starter code in C++ and Python.`},
	{Name: "Study notes",
		Instructions: `Write for revision rather than for a test. For a reading: open with a two-sentence summary, then short sections with descriptive headings, each with a small worked example or code sample, and close with "Key takeaways" (three to five bullets) and "Check yourself" (three questions, each with its answer collapsed). Where the topic has a flow, a sequence or states, include one small Mermaid diagram. For a problem: keep the statement brief, and use Notes to point to related topics and, in a collapsed "Hint", name the underlying technique, without giving the solution. Prefer plain words to jargon, and define each term the first time it appears.`},
}
