package postgres

import (
	"database/sql"
	"errors"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/internal/sqlrow"
)

const solutionColumns = `id, item_id, name, language, source, notes, is_reference, created_at, updated_at,
	last_run_passed, last_run_total, last_run_time_ms, last_run_memory_kb, last_run_at`

func scanSolution(sc interface{ Scan(...any) error }) (domain.ItemSolution, error) {
	var (
		s                                   domain.ItemSolution
		created, updated                    int64
		passed, total, timeMs, memKb, ranAt sql.NullInt64
	)
	err := sc.Scan(&s.ID, &s.ItemID, &s.Name, &s.Language, &s.Source, &s.Notes, &s.IsReference, &created, &updated,
		&passed, &total, &timeMs, &memKb, &ranAt)
	s.CreatedAt, s.UpdatedAt = sqlrow.FromUnix(created), sqlrow.FromUnix(updated)
	if ranAt.Valid {
		s.LastRun = &domain.SolutionRun{Passed: int(passed.Int64), Total: int(total.Int64), TimeMs: sqlrow.IntPtr(timeMs),
			MemoryKb: sqlrow.IntPtr(memKb), RanAt: sqlrow.FromUnix(ranAt.Int64)}
	}
	return s, err
}

// lastRunArgs are the values of the last_run_* columns, in column order.
func lastRunArgs(r *domain.SolutionRun) []any {
	if r == nil {
		return []any{nil, nil, nil, nil, nil}
	}
	return []any{r.Passed, r.Total, sqlrow.NullInt(r.TimeMs), sqlrow.NullInt(r.MemoryKb), sqlrow.ToUnix(r.RanAt)}
}

func (t *tx) ListSolutions(itemID string) ([]domain.ItemSolution, error) {
	rows, err := t.query(`SELECT `+solutionColumns+` FROM solutions WHERE item_id = $1 ORDER BY is_reference DESC, seq`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.ItemSolution{}
	for rows.Next() {
		s, err := scanSolution(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (t *tx) GetSolution(id string) (domain.ItemSolution, error) {
	s, err := scanSolution(t.queryRow(`SELECT `+solutionColumns+` FROM solutions WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, store.ErrNotFound
	}
	return s, err
}

func (t *tx) InsertSolution(s *domain.ItemSolution) error {
	args := append([]any{s.ID, s.ItemID, s.Name, s.Language, text(s.Source), text(s.Notes), s.IsReference,
		sqlrow.ToUnix(s.CreatedAt), sqlrow.ToUnix(s.UpdatedAt)}, lastRunArgs(s.LastRun)...)
	_, err := t.exec(`INSERT INTO solutions (`+solutionColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, args...)
	return err
}

func (t *tx) UpdateSolution(s *domain.ItemSolution) error {
	args := append([]any{s.Name, s.Language, text(s.Source), text(s.Notes), s.IsReference, sqlrow.ToUnix(s.UpdatedAt)},
		lastRunArgs(s.LastRun)...)
	res, err := t.exec(`UPDATE solutions SET name = $1, language = $2, source = $3, notes = $4, is_reference = $5, updated_at = $6,
		last_run_passed = $7, last_run_total = $8, last_run_time_ms = $9, last_run_memory_kb = $10, last_run_at = $11
		WHERE id = $12`, append(args, s.ID)...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteSolution(id string) error {
	res, err := t.exec(`DELETE FROM solutions WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteSolutions(itemID string) error {
	_, err := t.exec(`DELETE FROM solutions WHERE item_id = $1`, itemID)
	return err
}

func (t *tx) ClearReference(itemID string) error {
	_, err := t.exec(`UPDATE solutions SET is_reference = false WHERE item_id = $1 AND is_reference`, itemID)
	return err
}
