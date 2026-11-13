package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"regexp"
	"testing"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Migration 0003 turns each item's reference solution into a saved
// solution marked as reference, and drops the old columns.
func TestMigrationMovesReferenceSolutions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	migs, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := raw.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	mustExec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
	for _, m := range migs[:2] {
		mustExec(m.sql)
		mustExec(`INSERT INTO schema_migrations VALUES (?, ?, 0)`, m.version, m.name)
	}
	insert := `INSERT INTO items (id, type, title, status, time_limit_ms, memory_limit_kb, compare_mode, starter_code,
		reference_language, reference_source, created_at, updated_at) VALUES (?, ?, ?, 'todo', ?, ?, ?, '{}', ?, ?, 100, 200)`
	mustExec(insert, "with-ref", "problem", "A", 1000, 65536, "tokens", "python", "print(1)")
	mustExec(insert, "no-ref", "problem", "B", 1000, 65536, "tokens", nil, nil)
	mustExec(insert, "empty-ref", "problem", "C", 1000, 65536, "tokens", "python", "")
	mustExec(`INSERT INTO items (id, type, title, status, created_at, updated_at) VALUES ('reading', 'reading', 'R', 'todo', 1, 1)`)
	raw.Close()

	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	got := read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("with-ref") })
	ref := got.Problem.ReferenceSolution
	if ref == nil || ref.Language != "python" || ref.Source != "print(1)" || got.SolutionCount != 1 {
		t.Fatalf("migrated reference: %+v", ref)
	}
	sols := read(t, db, func(tx store.Tx) ([]domain.ItemSolution, error) { return tx.ListSolutions("with-ref") })
	uuid4 := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if len(sols) != 1 || !uuid4.MatchString(sols[0].ID) || sols[0].Name != domain.ReferenceSolutionName || !sols[0].IsReference ||
		sols[0].CreatedAt.Unix() != 200 {
		t.Errorf("migrated solution: %+v", sols)
	}
	for _, id := range []string{"no-ref", "empty-ref"} {
		if it := read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem(id) }); it.Problem.ReferenceSolution != nil || it.SolutionCount != 0 {
			t.Errorf("%s: %+v", id, it.Problem.ReferenceSolution)
		}
	}
	var n int
	if err := db.writer.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('items') WHERE name LIKE 'reference_%'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("old columns remain: %d %v", n, err)
	}
}
