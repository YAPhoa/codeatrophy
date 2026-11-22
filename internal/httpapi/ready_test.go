package httpapi_test

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"testing"

	"codeatrophy/internal/app"
	"codeatrophy/internal/httpapi"
	"codeatrophy/internal/store"
)

// failingStore is a store whose reads fail while fail is set.
type failingStore struct {
	store.Store
	fail atomic.Bool
}

func (s *failingStore) Read(ctx context.Context, fn func(store.Tx) error) error {
	if s.fail.Load() {
		return errors.New("database is gone")
	}
	return s.Store.Read(ctx, fn)
}

func TestReadiness(t *testing.T) {
	var db *failingStore
	logs := &logBuffer{}
	c := newServerWith(t, func(o *app.Options) {
		db = &failingStore{Store: o.Store}
		o.Store = db
	}, func(o *httpapi.Options) {
		o.AccessLog = true
		o.Logger = slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	c.app.RefreshJudgeStatus(context.Background())

	r := c.expect("GET", api+"/health/ready", "", 200)
	if m := r.json(t); len(m) != 3 || m["status"] != "ok" || m["database"] != "ok" || m["judge"] != "ok" {
		t.Errorf("ready: %s", r.body)
	}
	db.fail.Store(true)
	r = c.expect("GET", api+"/health/ready", "", 503)
	if m := r.json(t); len(m) != 3 || m["status"] != "unavailable" || m["database"] != "down" || m["judge"] != "ok" {
		t.Errorf("database down: %s", r.body)
	}
	// The liveness check reads nothing, so it still answers (sign-in is off here).
	c.expect("GET", api+"/health", "", 200)

	// Polled: at debug, also while not ready (the app logs the change).
	recs := logs.records(t, "request")
	if len(recs) != 3 {
		t.Fatalf("records: %v", recs)
	}
	for _, rec := range recs {
		if (rec["path"] != api+"/health/ready" && rec["path"] != api+"/health") || rec["level"] != "DEBUG" {
			t.Errorf("readiness check logged as %v", rec)
		}
	}
}
