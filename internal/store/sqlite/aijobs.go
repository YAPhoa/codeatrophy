package sqlite

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/internal/sqlrow"
)

// AI jobs: one row each in ai_jobs, the request and the result compressed.

const aiJobColumns = `id, created_at, kind, item_id, draft_id, title, status, origin, error, started_at, finished_at, picked_up_at, user_id`

func scanAIJob(sc interface{ Scan(...any) error }, extra ...any) (store.AIJob, error) {
	var (
		j                                store.AIJob
		itemID, draftID, origin, errBody sql.NullString
		created                          int64
		started, finished, pickedUp      sql.NullInt64
	)
	dest := append([]any{&j.ID, &created, &j.Kind, &itemID, &draftID, &j.Title, &j.Status, &origin, &errBody, &started, &finished,
		&pickedUp, &j.UserID}, extra...)
	if err := sc.Scan(dest...); err != nil {
		return j, err
	}
	j.CreatedAt = sqlrow.FromUnix(created)
	j.ItemID, j.DraftID, j.Origin, j.Error = sqlrow.StrPtr(itemID), sqlrow.StrPtr(draftID), sqlrow.StrPtr(origin), sqlrow.StrPtr(errBody)
	j.StartedAt, j.FinishedAt, j.PickedUpAt = sqlrow.TimePtr(started), sqlrow.TimePtr(finished), sqlrow.TimePtr(pickedUp)
	return j, nil
}

func compressedOrNil(p *string) any {
	if p == nil {
		return nil
	}
	return store.CompressText(*p)
}

func (t *tx) InsertAIJob(j *store.AIJob) error {
	_, err := t.exec(`INSERT INTO ai_jobs (`+aiJobColumns+`, request, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		j.ID, sqlrow.ToUnix(j.CreatedAt), j.Kind, sqlrow.NullStr(j.ItemID), sqlrow.NullStr(j.DraftID), j.Title, j.Status, sqlrow.NullStr(j.Origin), sqlrow.NullStr(j.Error),
		sqlrow.NullUnix(j.StartedAt), sqlrow.NullUnix(j.FinishedAt), sqlrow.NullUnix(j.PickedUpAt), j.UserID, store.CompressText(j.Request),
		compressedOrNil(j.Result))
	return err
}

func (t *tx) GetAIJob(id string) (store.AIJob, error) {
	var req, res []byte
	j, err := scanAIJob(t.queryRow(`SELECT `+aiJobColumns+`, request, result FROM ai_jobs WHERE id = ?`, id), &req, &res)
	if errors.Is(err, sql.ErrNoRows) {
		return j, store.ErrNotFound
	}
	if err != nil {
		return j, err
	}
	if j.Request, err = store.DecompressText(req); err != nil {
		return j, fmt.Errorf("ai job %s: request: %w", id, err)
	}
	if res != nil {
		s, err := store.DecompressText(res)
		if err != nil {
			return j, fmt.Errorf("ai job %s: result: %w", id, err)
		}
		j.Result = &s
	}
	return j, nil
}

func (t *tx) ListAIJobs(f store.AIJobFilter) ([]store.AIJob, error) {
	where := []string{"TRUE"}
	var args []any
	if f.Active {
		where = append(where, "status IN ('queued', 'running')")
	}
	if f.UserID != nil {
		where, args = append(where, "user_id = ?"), append(args, *f.UserID)
	}
	if f.Kind != "" {
		where, args = append(where, "kind = ?"), append(args, f.Kind)
	}
	if f.ItemID != "" {
		where, args = append(where, "item_id = ?"), append(args, f.ItemID)
	}
	if f.DraftID != "" {
		where, args = append(where, "draft_id = ?"), append(args, f.DraftID)
	}
	if f.PickedUp != nil {
		where = append(where, map[bool]string{true: "picked_up_at IS NOT NULL", false: "picked_up_at IS NULL"}[*f.PickedUp])
	}
	q := `SELECT ` + aiJobColumns + ` FROM ai_jobs WHERE ` + strings.Join(where, " AND ") + ` ORDER BY created_at DESC, id DESC`
	if f.Limit > 0 {
		q, args = q+" LIMIT ?", append(args, f.Limit)
	}
	out := []store.AIJob{}
	err := t.eachRow(q, args, func(rows *sql.Rows) error {
		j, err := scanAIJob(rows)
		out = append(out, j)
		return err
	})
	return out, err
}

func (t *tx) UpdateAIJob(j *store.AIJob) error {
	res, err := t.exec(`UPDATE ai_jobs SET item_id = ?, draft_id = ?, title = ?, status = ?, origin = ?, result = ?, error = ?,
		started_at = ?, finished_at = ?, picked_up_at = ? WHERE id = ?`,
		sqlrow.NullStr(j.ItemID), sqlrow.NullStr(j.DraftID), j.Title, j.Status, sqlrow.NullStr(j.Origin), compressedOrNil(j.Result), sqlrow.NullStr(j.Error),
		sqlrow.NullUnix(j.StartedAt), sqlrow.NullUnix(j.FinishedAt), sqlrow.NullUnix(j.PickedUpAt), j.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteAIJob(id string) (bool, error) {
	res, err := t.exec(`DELETE FROM ai_jobs WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (t *tx) PruneAIJobs(finishedBefore time.Time, keep int) (int, error) {
	res, err := t.exec(`DELETE FROM ai_jobs WHERE finished_at IS NOT NULL AND finished_at < ?`, sqlrow.ToUnix(finishedBefore))
	if err != nil {
		return 0, err
	}
	old, _ := res.RowsAffected()
	res, err = t.exec(`DELETE FROM ai_jobs WHERE finished_at IS NOT NULL AND id NOT IN
		(SELECT id FROM ai_jobs ORDER BY created_at DESC, id DESC LIMIT ?)`, max(keep, 0))
	if err != nil {
		return 0, err
	}
	extra, _ := res.RowsAffected()
	return int(old + extra), nil
}
