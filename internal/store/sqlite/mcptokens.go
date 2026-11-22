package sqlite

import (
	"database/sql"
	"errors"
	"time"

	"codeatrophy/internal/store"
)

const mcpTokenColumns = `id, user_id, name, hint, created_at, last_used_at`

func scanMCPToken(row interface{ Scan(...any) error }) (store.MCPToken, error) {
	var (
		t       store.MCPToken
		created int64
		used    sql.NullInt64
	)
	if err := row.Scan(&t.ID, &t.UserID, &t.Name, &t.Hint, &created, &used); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return t, store.ErrNotFound
		}
		return t, err
	}
	t.CreatedAt = fromUnix(created)
	if used.Valid {
		u := fromUnix(used.Int64)
		t.LastUsedAt = &u
	}
	return t, nil
}

func (t *tx) ListMCPTokens(userID string) ([]store.MCPToken, error) {
	rows, err := t.query(`SELECT `+mcpTokenColumns+` FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC, id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.MCPToken{}
	for rows.Next() {
		m, err := scanMCPToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (t *tx) GetMCPToken(id string) (store.MCPToken, error) {
	return scanMCPToken(t.queryRow(`SELECT `+mcpTokenColumns+` FROM mcp_tokens WHERE id = ?`, id))
}

func (t *tx) InsertMCPToken(m *store.MCPToken) error {
	_, err := t.exec(`INSERT INTO mcp_tokens (`+mcpTokenColumns+`) VALUES (?, ?, ?, ?, ?, ?)`,
		m.ID, m.UserID, m.Name, m.Hint, toUnix(m.CreatedAt), nullUnix(m.LastUsedAt))
	return err
}

func (t *tx) TouchMCPToken(id string, at time.Time) error {
	_, err := t.exec(`UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?`, toUnix(at), id)
	return err
}

func (t *tx) DeleteMCPToken(userID, id string) (bool, error) {
	res, err := t.exec(`DELETE FROM mcp_tokens WHERE user_id = ? AND id = ?`, userID, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
