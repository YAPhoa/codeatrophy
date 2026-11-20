package sqlite

import (
	"database/sql"
	"errors"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

const solutionColumns = `id, item_id, name, language, source, notes, is_reference, created_at, updated_at,
	last_run_passed, last_run_total, last_run_time_ms, last_run_memory_kb, last_run_at`

func scanSolution(sc interface{ Scan(...any) error }) (domain.ItemSolution, error) {
	var (
		s                                   domain.ItemSolution
		ref                                 int
		created, updated                    int64
		passed, total, timeMs, memKb, ranAt sql.NullInt64
	)
	err := sc.Scan(&s.ID, &s.ItemID, &s.Name, &s.Language, &s.Source, &s.Notes, &ref, &created, &updated,
		&passed, &total, &timeMs, &memKb, &ranAt)
	s.IsReference = ref != 0
	s.CreatedAt, s.UpdatedAt = fromUnix(created), fromUnix(updated)
	if ranAt.Valid {
		s.LastRun = &domain.SolutionRun{Passed: int(passed.Int64), Total: int(total.Int64), TimeMs: intPtr(timeMs),
			MemoryKb: intPtr(memKb), RanAt: fromUnix(ranAt.Int64)}
	}
	return s, err
}

// lastRunArgs are the values of the last_run_* columns, in column order.
func lastRunArgs(r *domain.SolutionRun) []any {
	if r == nil {
		return []any{nil, nil, nil, nil, nil}
	}
	return []any{r.Passed, r.Total, nullInt(r.TimeMs), nullInt(r.MemoryKb), toUnix(r.RanAt)}
}

func (t *tx) ListSolutions(itemID string) ([]domain.ItemSolution, error) {
	rows, err := t.query(`SELECT `+solutionColumns+` FROM solutions WHERE item_id = ? ORDER BY is_reference DESC, seq`, itemID)
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
	s, err := scanSolution(t.queryRow(`SELECT `+solutionColumns+` FROM solutions WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, store.ErrNotFound
	}
	return s, err
}

func (t *tx) InsertSolution(s *domain.ItemSolution) error {
	args := append([]any{s.ID, s.ItemID, s.Name, s.Language, s.Source, s.Notes, boolInt(s.IsReference),
		toUnix(s.CreatedAt), toUnix(s.UpdatedAt)}, lastRunArgs(s.LastRun)...)
	_, err := t.exec(`INSERT INTO solutions (`+solutionColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args...)
	return err
}

func (t *tx) UpdateSolution(s *domain.ItemSolution) error {
	args := append([]any{s.Name, s.Language, s.Source, s.Notes, boolInt(s.IsReference), toUnix(s.UpdatedAt)},
		lastRunArgs(s.LastRun)...)
	res, err := t.exec(`UPDATE solutions SET name = ?, language = ?, source = ?, notes = ?, is_reference = ?, updated_at = ?,
		last_run_passed = ?, last_run_total = ?, last_run_time_ms = ?, last_run_memory_kb = ?, last_run_at = ?
		WHERE id = ?`, append(args, s.ID)...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteSolution(id string) error {
	res, err := t.exec(`DELETE FROM solutions WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteSolutions(itemID string) error {
	_, err := t.exec(`DELETE FROM solutions WHERE item_id = ?`, itemID)
	return err
}

func (t *tx) ClearReference(itemID string) error {
	_, err := t.exec(`UPDATE solutions SET is_reference = 0 WHERE item_id = ? AND is_reference = 1`, itemID)
	return err
}
