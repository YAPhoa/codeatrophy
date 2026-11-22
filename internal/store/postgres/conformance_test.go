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

// Both backends start from the baseline of 1.0.0, end at the same logical
// schema version, and have one migration for each schema change between.
func TestSchemaVersionsMatch(t *testing.T) {
	lite, pg := sqlite.MigrationVersions(), postgres.MigrationVersions()
	if lite[0] != store.BaselineVersion || pg[0] != store.BaselineVersion {
		t.Fatalf("first versions: SQLite %d, PostgreSQL %d, store.BaselineVersion %d", lite[0], pg[0],
			store.BaselineVersion)
	}
	if lite[len(lite)-1] != store.SchemaVersion || pg[len(pg)-1] != store.SchemaVersion {
		t.Fatalf("latest versions: SQLite %d, PostgreSQL %d, store.SchemaVersion %d",
			lite[len(lite)-1], pg[len(pg)-1], store.SchemaVersion)
	}
	if !slices.Equal(lite, pg) {
		t.Errorf("SQLite migrations %v, PostgreSQL migrations %v: every schema change needs one migration per backend, "+
			"with the same number", lite, pg)
	}
}
