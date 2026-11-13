package postgres

import (
	"database/sql"
	"errors"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

const styleColumns = `id, name, instructions, is_default, created_at, updated_at`

func scanStyle(sc interface{ Scan(...any) error }) (domain.StylePreset, error) {
	var (
		p                domain.StylePreset
		created, updated int64
	)
	err := sc.Scan(&p.ID, &p.Name, &p.Instructions, &p.IsDefault, &created, &updated)
	p.CreatedAt, p.UpdatedAt = fromUnix(created), fromUnix(updated)
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
	p, err := scanStyle(t.queryRow(`SELECT `+styleColumns+` FROM style_presets WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, store.ErrNotFound
	}
	return p, err
}

func (t *tx) InsertStylePreset(p *domain.StylePreset) error {
	_, err := t.exec(`INSERT INTO style_presets (id, name, name_key, instructions, is_default, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, p.ID, p.Name, domain.StyleNameKey(p.Name), p.Instructions, p.IsDefault,
		toUnix(p.CreatedAt), toUnix(p.UpdatedAt))
	return err
}

func (t *tx) UpdateStylePreset(p *domain.StylePreset) error {
	res, err := t.exec(`UPDATE style_presets SET name = $1, name_key = $2, instructions = $3, is_default = $4, updated_at = $5
		WHERE id = $6`, p.Name, domain.StyleNameKey(p.Name), p.Instructions, p.IsDefault, toUnix(p.UpdatedAt), p.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteStylePreset(id string) error {
	res, err := t.exec(`DELETE FROM style_presets WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) ClearDefaultStylePreset() error {
	_, err := t.exec(`UPDATE style_presets SET is_default = false WHERE is_default`)
	return err
}
