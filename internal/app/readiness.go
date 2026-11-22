package app

import (
	"context"
	"time"

	"codeatrophy/internal/store"
)

// Readiness is whether the server can serve the library, for uptime
// monitors and orchestrators. It carries no error text: it is public.
type Readiness struct {
	// Status is "ok", or "unavailable" when the database is down.
	Status string `json:"status"`
	// Database is "ok" or "down".
	Database string `json:"database"`
	// Judge is "ok", "down" or "none" (no engine configured), from the
	// cached probe. The library works without a judge, so it never makes
	// the server unavailable.
	Judge string `json:"judge"`
}

// Ready reports whether the server is ready: whether the database answers
// a read within 2 seconds, and the judge engine's cached status. A change
// of the database's state is logged, not every failed check.
func (a *App) Ready(ctx context.Context) Readiness {
	// A client that goes away does not count as the database failing.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	err := a.store.Read(ctx, func(tx store.Tx) error {
		_, err := tx.CountUsers()
		return err
	})
	down := err != nil
	if wasDown := a.dbDown.Swap(down); down && !wasDown {
		a.log.Warn("database not ready", "error", err)
	} else if !down && wasDown {
		a.log.Info("database ready again")
	}

	r := Readiness{Status: "ok", Database: "ok", Judge: "ok"}
	if down {
		r.Status, r.Database = "unavailable", "down"
	}
	switch st := a.JudgeStatus(); {
	case !st.Enabled:
		r.Judge = "none"
	case !st.Healthy:
		r.Judge = "down"
	}
	return r
}
