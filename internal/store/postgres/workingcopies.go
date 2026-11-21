package postgres

import (
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

func (t *tx) ListWorkingCopies(itemID string) ([]domain.WorkingCopy, error) {
	rows, err := t.query(`SELECT item_id, language, source, updated_at FROM working_copies WHERE item_id = $1
		ORDER BY write_seq DESC`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.WorkingCopy{}
	for rows.Next() {
		var (
			w       domain.WorkingCopy
			updated int64
		)
		if err := rows.Scan(&w.ItemID, &w.Language, &w.Source, &updated); err != nil {
			return nil, err
		}
		w.UpdatedAt = fromUnix(updated)
		out = append(out, w)
	}
	return out, rows.Err()
}

// PutWorkingCopy is one upsert that selects the item, so a missing item or
// a reading inserts no row, and a write replaces the whole row. Each write
// takes the next write_seq, which orders the list. The parameters are cast
// because a SELECT list does not take its types from the insert's columns.
func (t *tx) PutWorkingCopy(w *domain.WorkingCopy) error {
	res, err := t.exec(`INSERT INTO working_copies (item_id, language, source, updated_at, write_seq)
		SELECT id, $1::text, $2::bytea, $3::bigint, (SELECT COALESCE(MAX(write_seq), 0) + 1 FROM working_copies)
		FROM items WHERE id = $4 AND type = $5
		ON CONFLICT (item_id, language) DO UPDATE
		SET source = excluded.source, updated_at = excluded.updated_at, write_seq = excluded.write_seq`,
		w.Language, text(w.Source), toUnix(w.UpdatedAt), w.ItemID, string(domain.TypeProblem))
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteWorkingCopy(itemID, language string) (bool, error) {
	res, err := t.exec(`DELETE FROM working_copies WHERE item_id = $1 AND language = $2`, itemID, language)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
