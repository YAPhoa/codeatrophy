package postgres

import (
	"database/sql"
	"errors"
	"time"

	"codeatrophy/internal/store"
)

const userColumns = `id, email, password_hash, created_at, updated_at`

func scanUser(row interface{ Scan(...any) error }) (store.User, error) {
	var (
		u                store.User
		created, updated int64
	)
	if err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return u, store.ErrNotFound
		}
		return u, err
	}
	u.CreatedAt, u.UpdatedAt = fromUnix(created), fromUnix(updated)
	return u, nil
}

func (t *tx) CountUsers() (int, error) {
	var n int
	err := t.queryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (t *tx) ListUsers() ([]store.User, error) {
	rows, err := t.query(`SELECT ` + userColumns + ` FROM users ORDER BY email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (t *tx) GetUser(id string) (store.User, error) {
	return scanUser(t.queryRow(`SELECT `+userColumns+` FROM users WHERE id = $1`, id))
}

func (t *tx) GetUserByEmail(email string) (store.User, error) {
	return scanUser(t.queryRow(`SELECT `+userColumns+` FROM users WHERE email = $1`, email))
}

func (t *tx) InsertUser(u *store.User) error {
	_, err := t.exec(`INSERT INTO users (`+userColumns+`) VALUES ($1, $2, $3, $4, $5)`,
		u.ID, u.Email, u.PasswordHash, toUnix(u.CreatedAt), toUnix(u.UpdatedAt))
	return err
}

func (t *tx) UpdateUserPassword(id, passwordHash string, at time.Time) error {
	res, err := t.exec(`UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3`, passwordHash, toUnix(at), id)
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

func (t *tx) DeleteUser(id string) (bool, error) {
	res, err := t.exec(`DELETE FROM users WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil || n == 0 {
		return false, err
	}
	if _, err := t.exec(`DELETE FROM ai_log_bodies WHERE entry_id IN (SELECT id FROM ai_log WHERE user_id = $1)`, id); err != nil {
		return false, err
	}
	for _, table := range store.PersonalTables {
		if _, err := t.exec(`DELETE FROM `+table+` WHERE user_id = $1`, id); err != nil {
			return false, err
		}
	}
	if _, err := t.exec(`DELETE FROM ai_log_texts WHERE hash NOT IN
		(SELECT system_hash FROM ai_log_bodies WHERE system_hash IS NOT NULL)`); err != nil {
		return false, err
	}
	_, err = t.exec(`DELETE FROM settings WHERE key = $1`, store.PreferencesKey(id))
	return true, err
}

func (t *tx) ClaimUnowned(userID string) error {
	for _, table := range store.PersonalTables {
		if _, err := t.exec(`UPDATE `+table+` SET user_id = $1 WHERE user_id = $2`, userID, store.Unowned); err != nil {
			return err
		}
	}
	_, err := t.exec(`UPDATE settings SET key = $1 WHERE key = $2
		AND NOT EXISTS (SELECT 1 FROM settings WHERE key = $3)`,
		store.PreferencesKey(userID), store.PreferencesKey(store.Unowned), store.PreferencesKey(userID))
	return err
}

const sessionColumns = `id, user_id, created_at, expires_at, user_agent, last_used_at`

func scanSession(row interface{ Scan(...any) error }) (store.Session, error) {
	var (
		s                      store.Session
		created, expires, used int64
	)
	if err := row.Scan(&s.ID, &s.UserID, &created, &expires, &s.UserAgent, &used); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return s, store.ErrNotFound
		}
		return s, err
	}
	s.CreatedAt, s.ExpiresAt, s.LastUsedAt = fromUnix(created), fromUnix(expires), fromUnix(used)
	return s, nil
}

func (t *tx) InsertSession(s *store.Session) error {
	_, err := t.exec(`INSERT INTO sessions (`+sessionColumns+`) VALUES ($1, $2, $3, $4, $5, $6)`,
		s.ID, s.UserID, toUnix(s.CreatedAt), toUnix(s.ExpiresAt), s.UserAgent, toUnix(s.LastUsedAt))
	return err
}

func (t *tx) GetSession(id string) (store.Session, error) {
	return scanSession(t.queryRow(`SELECT `+sessionColumns+` FROM sessions WHERE id = $1`, id))
}

func (t *tx) ListUserSessions(userID string) ([]store.Session, error) {
	rows, err := t.query(`SELECT `+sessionColumns+` FROM sessions WHERE user_id = $1
		ORDER BY last_used_at DESC, created_at DESC, id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.Session{}
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (t *tx) ExtendSession(id string, usedAt, expiresAt time.Time) error {
	_, err := t.exec(`UPDATE sessions SET last_used_at = $1, expires_at = $2 WHERE id = $3`, toUnix(usedAt), toUnix(expiresAt), id)
	return err
}

func (t *tx) SetSessionUserAgent(id, userAgent string) error {
	_, err := t.exec(`UPDATE sessions SET user_agent = $1 WHERE id = $2 AND user_agent = ''`, userAgent, id)
	return err
}

func (t *tx) DeleteSession(id string) error {
	_, err := t.exec(`DELETE FROM sessions WHERE id = $1`, id)
	return err
}

func (t *tx) DeleteUserSessions(userID, except string) error {
	_, err := t.exec(`DELETE FROM sessions WHERE user_id = $1 AND id != $2`, userID, except)
	return err
}

func (t *tx) DeleteExpiredSessions(before time.Time) error {
	_, err := t.exec(`DELETE FROM sessions WHERE expires_at < $1`, toUnix(before))
	return err
}
