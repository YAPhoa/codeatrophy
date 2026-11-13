package sqlite_test

import (
	"testing"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/storetest"
	"codeatrophy/internal/store/teststore"
)

func TestConformance(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store { return teststore.OpenSQLite(t) })
}
