// Package sqlitetest helps tests take a SQLite database back to an older
// schema version, so that they can run later migrations on a database that
// already holds data.
package sqlitetest

import (
	"database/sql"
	"testing"

	"codeatrophy/internal/store"
)

// DownMigrations undo a migration, so that tests can run it again on a
// database that already holds data. A new migration that cannot simply run
// twice adds its reverse here.
var DownMigrations = map[int]string{
	6: `ALTER TABLE items DROP COLUMN problem_interface;
		ALTER TABLE items DROP COLUMN harness;
		ALTER TABLE submissions DROP COLUMN line_offset;
		ALTER TABLE submissions DROP COLUMN harness;`,
	7: `DROP TABLE ai_usage; DROP TABLE ai_log_bodies; DROP TABLE ai_log_texts; DROP TABLE ai_log;`,
	// The ai_providers table of 0004, which knew two kinds.
	8: `CREATE TABLE ai_providers_old (
			seq            INTEGER PRIMARY KEY,
			id             TEXT    NOT NULL UNIQUE,
			name           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
			name_key       TEXT    NOT NULL UNIQUE,
			kind           TEXT    NOT NULL CHECK (kind IN ('anthropic', 'openai_compatible')),
			model          TEXT    NOT NULL DEFAULT '',
			base_url       TEXT    NOT NULL DEFAULT '',
			api_key        TEXT    NOT NULL DEFAULT '',
			api_key_origin TEXT    NOT NULL DEFAULT '',
			created_at     INTEGER NOT NULL,
			updated_at     INTEGER NOT NULL);
		INSERT INTO ai_providers_old SELECT * FROM ai_providers;
		DROP TABLE ai_providers;
		ALTER TABLE ai_providers_old RENAME TO ai_providers;
		CREATE TRIGGER ai_providers_kind_immutable BEFORE UPDATE OF kind ON ai_providers
		WHEN NEW.kind != OLD.kind BEGIN SELECT RAISE(ABORT, 'the kind of an AI provider cannot be changed'); END;
		CREATE TRIGGER ai_providers_name_single_line_insert BEFORE INSERT ON ai_providers
		WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
		BEGIN SELECT RAISE(ABORT, 'AI provider name must be a single line'); END;
		CREATE TRIGGER ai_providers_name_single_line_update BEFORE UPDATE OF name ON ai_providers
		WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
		BEGIN SELECT RAISE(ABORT, 'AI provider name must be a single line'); END;
		CREATE TRIGGER ai_providers_max_count BEFORE INSERT ON ai_providers
		WHEN (SELECT COUNT(*) FROM ai_providers) >= 20
		BEGIN SELECT RAISE(ABORT, 'too many AI providers'); END;`,
	// The item_tags table of 0001, which referred to no tags table.
	9: `CREATE TABLE item_tags_old (
			item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
			tag     TEXT NOT NULL,
			PRIMARY KEY (item_id, tag)) WITHOUT ROWID;
		INSERT INTO item_tags_old SELECT item_id, tag FROM item_tags;
		DROP TABLE item_tags;
		ALTER TABLE item_tags_old RENAME TO item_tags;
		CREATE INDEX item_tags_tag ON item_tags (tag);
		DROP TABLE tags;`,
	10: `ALTER TABLE ai_providers DROP COLUMN effort;`,
	11: `ALTER TABLE solutions DROP COLUMN last_run_at;
		ALTER TABLE solutions DROP COLUMN last_run_passed;
		ALTER TABLE solutions DROP COLUMN last_run_total;
		ALTER TABLE solutions DROP COLUMN last_run_time_ms;
		ALTER TABLE solutions DROP COLUMN last_run_memory_kb;`,
	12: `DROP TABLE ai_jobs; DROP TABLE drafts;`,
	13: `ALTER TABLE test_cases DROP COLUMN generator_source;
		ALTER TABLE test_cases DROP COLUMN generator_language;`,
}

// Execer runs SQL directly on a database, such as a *sql.DB.
type Execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// UndoMigrationsFrom takes the database back to the version before from:
// it runs the down migrations from the latest one to from and forgets that
// those migrations ran.
func UndoMigrationsFrom(t testing.TB, db Execer, from int) {
	t.Helper()
	for v := store.SchemaVersion; v >= from; v-- {
		if down, ok := DownMigrations[v]; ok {
			if _, err := db.Exec(down); err != nil {
				t.Fatalf("undo migration %d: %v", v, err)
			}
		}
	}
	if _, err := db.Exec(`DELETE FROM schema_migrations WHERE version >= ?`, from); err != nil {
		t.Fatal(err)
	}
}
