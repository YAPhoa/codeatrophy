package sqlite

import (
	"database/sql"
	"errors"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// linkedItemColumns describe the item or deleted item with the id in
// column "other", joined as i and d.
const linkedItemColumns = `i.id IS NOT NULL, COALESCE(i.title, d.title), COALESCE(i.type, d.type), i.status, i.difficulty`

// scanLinkedItem scans linkedItemColumns, after the columns scanned into
// first.
func scanLinkedItem(sc interface{ Scan(...any) error }, first ...any) (domain.LinkedItem, error) {
	var (
		li                             domain.LinkedItem
		available                      int
		title, typ, status, difficulty sql.NullString
	)
	if err := sc.Scan(append(first, &available, &title, &typ, &status, &difficulty)...); err != nil {
		return li, err
	}
	li.Available = available != 0
	li.Title = strPtr(title)
	if typ.Valid {
		v := domain.ItemType(typ.String)
		li.Type = &v
	}
	if status.Valid {
		v := domain.ItemStatus(status.String)
		li.Status = &v
	}
	if difficulty.Valid {
		v := domain.Difficulty(difficulty.String)
		li.Difficulty = &v
	}
	return li, nil
}

// linkedItem describes the item with that id, whether it exists or not.
func (t *tx) linkedItem(id string) (domain.LinkedItem, error) {
	li, err := scanLinkedItem(t.queryRow(`SELECT `+linkedItemColumns+` FROM (SELECT ? AS other) l
		LEFT JOIN items i ON i.id = l.other LEFT JOIN deleted_items d ON d.id = l.other`, id))
	if err != nil {
		return li, err
	}
	li.ID = id
	return li, nil
}

func (t *tx) ItemLinks(id string) ([]domain.LinkedItem, error) {
	rows, err := t.query(`SELECT l.other, l.created_at, `+linkedItemColumns+` FROM (
			SELECT seq, item_b AS other, created_at FROM item_links WHERE item_a = ?
			UNION ALL SELECT seq, item_a, created_at FROM item_links WHERE item_b = ?) l
		LEFT JOIN items i ON i.id = l.other LEFT JOIN deleted_items d ON d.id = l.other
		ORDER BY i.id IS NULL, l.created_at, l.seq`, id, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.LinkedItem{}
	for rows.Next() {
		var other string
		var at int64
		li, err := scanLinkedItem(rows, &other, &at)
		if err != nil {
			return nil, err
		}
		li.ID = other
		when := fromUnix(at)
		li.LinkedAt = &when
		out = append(out, li)
	}
	return out, rows.Err()
}

func (t *tx) LinkItems(a, b string, at time.Time) (bool, error) {
	if a == b {
		return false, errors.New("an item cannot be linked to itself")
	}
	lo, hi := store.LinkPair(a, b)
	res, err := t.exec(`INSERT INTO item_links (item_a, item_b, created_at) VALUES (?, ?, ?)
		ON CONFLICT (item_a, item_b) DO NOTHING`, lo, hi, toUnix(at))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (t *tx) UnlinkItems(a, b string) (bool, error) {
	lo, hi := store.LinkPair(a, b)
	res, err := t.exec(`DELETE FROM item_links WHERE item_a = ? AND item_b = ?`, lo, hi)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
