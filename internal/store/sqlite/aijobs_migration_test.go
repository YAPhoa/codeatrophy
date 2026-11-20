package sqlite

import (
	"context"
	"path/filepath"
	"testing"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/storetest"
)

// Migration 12 adds the AI jobs and drafts tables and keeps every other row.
func TestAIJobsMigrationKeepsEverything(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v11.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	storetest.Populate(t, db)
	storetest.ClearNewerData(t, db)
	want := storetest.Dump(t, db)
	undoMigrationsFrom(t, db, 12)
	db.Close()

	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if v, _ := db.SchemaVersion(ctx); v != store.SchemaVersion {
		t.Fatalf("version %d after migrating", v)
	}
	storetest.SameDump(t, "after migration 12", want, storetest.Dump(t, db))
	if _, err := db.writer.Exec(`INSERT INTO ai_jobs (id, created_at, kind, title, status, request) VALUES ('j', 0, 'draft', '', 'queued', x'00')`); err != nil {
		t.Errorf("a job after migrating: %v", err)
	}
	if _, err := db.writer.Exec(`INSERT INTO drafts (id, created_at, updated_at, kind, title, revision) VALUES ('d', 0, 0, 'capture', '', 1)`); err != nil {
		t.Errorf("a draft after migrating: %v", err)
	}
}
