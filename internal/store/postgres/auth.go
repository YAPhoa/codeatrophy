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
	return n > 0, err
}

func (t *tx) InsertSession(s *store.Session) error {
	_, err := t.exec(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
		s.ID, s.UserID, toUnix(s.CreatedAt), toUnix(s.ExpiresAt))
	return err
}

func (t *tx) GetSession(id string) (store.Session, error) {
	var (
		s                store.Session
		created, expires int64
	)
	err := t.queryRow(`SELECT id, user_id, created_at, expires_at FROM sessions WHERE id = $1`, id).
		Scan(&s.ID, &s.UserID, &created, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return s, store.ErrNotFound
	}
	if err != nil {
		return s, err
	}
	s.CreatedAt, s.ExpiresAt = fromUnix(created), fromUnix(expires)
	return s, nil
}

func (t *tx) ExtendSession(id string, expiresAt time.Time) error {
	_, err := t.exec(`UPDATE sessions SET expires_at = $1 WHERE id = $2`, toUnix(expiresAt), id)
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
