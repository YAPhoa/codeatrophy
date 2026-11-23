package sqlite

import (
	"database/sql"
	"errors"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/internal/sqlrow"
)

const styleColumns = `id, name, instructions, is_default, created_at, updated_at`

func scanStyle(sc interface{ Scan(...any) error }) (domain.StylePreset, error) {
	var (
		p                domain.StylePreset
		def              int
		created, updated int64
	)
	err := sc.Scan(&p.ID, &p.Name, &p.Instructions, &def, &created, &updated)
	p.IsDefault = def != 0
	p.CreatedAt, p.UpdatedAt = sqlrow.FromUnix(created), sqlrow.FromUnix(updated)
	return p, err
}

func (t *tx) ListStylePresets() ([]domain.StylePreset, error) {
	rows, err := t.query(`SELECT ` + styleColumns + ` FROM style_presets ORDER BY is_default DESC, name_key, seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.StylePreset{}
	for rows.Next() {
		p, err := scanStyle(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (t *tx) GetStylePreset(id string) (domain.StylePreset, error) {
	p, err := scanStyle(t.queryRow(`SELECT `+styleColumns+` FROM style_presets WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, store.ErrNotFound
	}
	return p, err
}

func (t *tx) InsertStylePreset(p *domain.StylePreset) error {
	_, err := t.exec(`INSERT INTO style_presets (id, name, name_key, instructions, is_default, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, p.ID, p.Name, domain.StyleNameKey(p.Name), p.Instructions, boolInt(p.IsDefault),
		sqlrow.ToUnix(p.CreatedAt), sqlrow.ToUnix(p.UpdatedAt))
	return err
}

func (t *tx) UpdateStylePreset(p *domain.StylePreset) error {
	res, err := t.exec(`UPDATE style_presets SET name = ?, name_key = ?, instructions = ?, is_default = ?, updated_at = ?
		WHERE id = ?`, p.Name, domain.StyleNameKey(p.Name), p.Instructions, boolInt(p.IsDefault), sqlrow.ToUnix(p.UpdatedAt), p.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteStylePreset(id string) error {
	res, err := t.exec(`DELETE FROM style_presets WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) ClearDefaultStylePreset() error {
	_, err := t.exec(`UPDATE style_presets SET is_default = 0 WHERE is_default = 1`)
	return err
}
