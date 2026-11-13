package postgres

import (
	"database/sql"
	"errors"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

const solutionColumns = `id, item_id, name, language, source, notes, is_reference, created_at, updated_at`

func scanSolution(sc interface{ Scan(...any) error }) (domain.ItemSolution, error) {
	var (
		s                domain.ItemSolution
		created, updated int64
	)
	err := sc.Scan(&s.ID, &s.ItemID, &s.Name, &s.Language, &s.Source, &s.Notes, &s.IsReference, &created, &updated)
	s.CreatedAt, s.UpdatedAt = fromUnix(created), fromUnix(updated)
	return s, err
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
	_, err := t.exec(`INSERT INTO solutions (`+solutionColumns+`) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		s.ID, s.ItemID, s.Name, s.Language, text(s.Source), text(s.Notes), s.IsReference, toUnix(s.CreatedAt), toUnix(s.UpdatedAt))
	return err
}

func (t *tx) UpdateSolution(s *domain.ItemSolution) error {
	res, err := t.exec(`UPDATE solutions SET name = $1, language = $2, source = $3, notes = $4, is_reference = $5, updated_at = $6
		WHERE id = $7`, s.Name, s.Language, text(s.Source), text(s.Notes), s.IsReference, toUnix(s.UpdatedAt), s.ID)
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
