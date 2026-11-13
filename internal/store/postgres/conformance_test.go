package postgres_test

import (
	"slices"
	"testing"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/postgres"
	"codeatrophy/internal/store/sqlite"
	"codeatrophy/internal/store/storetest"
	"codeatrophy/internal/store/teststore"
)

func TestConformance(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store { return teststore.OpenPostgres(t) })
}

// Both backends' migrations end at the same logical schema version, and
// after its consolidated first migration PostgreSQL has one migration for
// each later SQLite one.
func TestSchemaVersionsMatch(t *testing.T) {
	lite, pg := sqlite.MigrationVersions(), postgres.MigrationVersions()
	if lite[len(lite)-1] != store.SchemaVersion || pg[len(pg)-1] != store.SchemaVersion {
		t.Fatalf("latest versions: SQLite %d, PostgreSQL %d, store.SchemaVersion %d",
			lite[len(lite)-1], pg[len(pg)-1], store.SchemaVersion)
	}
	i := slices.Index(lite, pg[0])
	if i < 0 || !slices.Equal(lite[i:], pg) {
		t.Errorf("SQLite migrations %v, PostgreSQL migrations %v: every schema change needs one migration per backend, "+
			"with the same number", lite, pg)
	}
}
