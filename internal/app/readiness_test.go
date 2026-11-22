package app_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/judge/judgetest"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/teststore"
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
	ctx := context.Background()
	logs := &jsonLog{}
	db := &failingStore{Store: teststore.Open(t)}
	engine := judgetest.New()
	// Not started, so that no background probe races the ones below.
	a := app.New(app.Options{Store: db, Engine: engine, HealthInterval: time.Hour,
		Logger: slog.New(slog.NewJSONHandler(logs, nil))})
	want := func(status, database, judge string) {
		t.Helper()
		if r := a.Ready(ctx); r != (app.Readiness{Status: status, Database: database, Judge: judge}) {
			t.Errorf("readiness: %+v, want %s/%s/%s", r, status, database, judge)
		}
	}

	// Before the first probe the judge counts as down.
	want("ok", "ok", "down")
	a.RefreshJudgeStatus(ctx)
	want("ok", "ok", "ok")
	engine.SetHealth(errors.New("down"))
	a.RefreshJudgeStatus(ctx)
	want("ok", "ok", "down")
	engine.SetHealth(nil)
	a.RefreshJudgeStatus(ctx)

	// The database going down is logged once, and so is its return.
	db.fail.Store(true)
	want("unavailable", "down", "ok")
	want("unavailable", "down", "ok")
	if n := strings.Count(logs.String(), `"msg":"database not ready"`); n != 1 {
		t.Errorf("%d warnings for a database that stays down", n)
	}
	if r := logs.find(t, "database not ready"); r == nil || r["level"] != "WARN" || r["error"] != "database is gone" {
		t.Errorf("warning: %v", r)
	}
	db.fail.Store(false)
	want("ok", "ok", "ok")
	want("ok", "ok", "ok")
	if n := strings.Count(logs.String(), `"msg":"database ready again"`); n != 1 {
		t.Errorf("%d records of the database coming back", n)
	}
	if r := logs.find(t, "database ready again"); r == nil || r["level"] != "INFO" {
		t.Errorf("recovery: %v", r)
	}

	// Without a judge engine the judge is none, and readiness is the
	// database's alone.
	noJudge := &failingStore{Store: teststore.Open(t)}
	b := app.New(app.Options{Store: noJudge, HealthInterval: time.Hour})
	if r := b.Ready(ctx); r != (app.Readiness{Status: "ok", Database: "ok", Judge: "none"}) {
		t.Errorf("without a judge: %+v", r)
	}
	noJudge.fail.Store(true)
	if r := b.Ready(ctx); r != (app.Readiness{Status: "unavailable", Database: "down", Judge: "none"}) {
		t.Errorf("without a judge, database down: %+v", r)
	}
}
