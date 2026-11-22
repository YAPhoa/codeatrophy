package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"codeatrophy/internal/store"
	"codeatrophy/internal/useragent"
)

// Sessions on the account page: an account sees the browsers signed in to
// it, when each signed in and was last used, and ends any of them.

// maxUserAgentBytes is how much of a User-Agent header a session keeps.
const maxUserAgentBytes = 256

// AuthSession is a session as clients see it. ID identifies it in the API:
// it is derived from the stored id one way, so it is neither the cookie's
// token nor the key the store finds a session by.
type AuthSession struct {
	ID string `json:"id"`
	// Browser describes the browser, such as "Firefox on Linux".
	Browser   string    `json:"browser"`
	CreatedAt time.Time `json:"createdAt"`
	// LastUsedAt is accurate to about an hour (see sessionRefresh); the
	// current session's is now.
	LastUsedAt time.Time `json:"lastUsedAt"`
	// Current is true for the session of the request.
	Current bool `json:"current"`
}

// sessionPublicID is a session's id in the API.
func sessionPublicID(storeID string) string {
	h := sha256.Sum256([]byte("codeatrophy session " + storeID))
	return hex.EncodeToString(h[:8])
}

// cleanUserAgent keeps at most maxUserAgentBytes of a User-Agent header,
// as valid UTF-8 without control characters.
func cleanUserAgent(ua string) string {
	ua = strings.ToValidUTF8(ua, "")
	ua = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, ua)
	ua = strings.TrimSpace(ua)
	if len(ua) > maxUserAgentBytes {
		ua = ua[:maxUserAgentBytes]
		for !utf8.ValidString(ua) {
			ua = ua[:len(ua)-1]
		}
	}
	return ua
}

// liveSessions returns the unexpired sessions of the account of s, last
// used first.
func (a *App) liveSessions(tx store.Tx, s Session) ([]store.Session, error) {
	all, err := tx.ListUserSessions(s.User.ID)
	if err != nil {
		return nil, err
	}
	now := a.now().UTC()
	live := all[:0]
	for _, x := range all {
		if now.Before(x.ExpiresAt) {
			live = append(live, x)
		}
	}
	return live, nil
}

// ListSessions returns the live sessions of the account signed in with
// token, last used first (and so that one first).
func (a *App) ListSessions(ctx context.Context, token string) ([]AuthSession, error) {
	s, err := a.Authenticate(ctx, token)
	if err != nil {
		return nil, err
	}
	var ss []store.Session
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { ss, err = a.liveSessions(tx, s); return }); err != nil {
		return nil, err
	}
	now := a.now().UTC()
	out := make([]AuthSession, len(ss))
	for i, x := range ss {
		out[i] = AuthSession{ID: sessionPublicID(x.ID), Browser: useragent.Describe(x.UserAgent),
			CreatedAt: x.CreatedAt, LastUsedAt: x.LastUsedAt, Current: x.ID == s.id}
		if out[i].Current {
			// This request uses it, though the store records uses only
			// hourly.
			out[i].LastUsedAt = now
		}
	}
	// So the current session comes first; the rest keep the store's order.
	slices.SortStableFunc(out, func(x, y AuthSession) int { return y.LastUsedAt.Compare(x.LastUsedAt) })
	return out, nil
}

// EndSession ends a session of the account signed in with token; id is
// the session's id as listed. It reports whether that was the token's own
// session, which is then signed out. Another account's session, or an
// unknown id, is not found.
func (a *App) EndSession(ctx context.Context, token, id string) (current bool, err error) {
	s, err := a.Authenticate(ctx, token)
	if err != nil {
		return false, err
	}
	err = a.store.Write(ctx, func(tx store.Tx) error {
		ss, err := a.liveSessions(tx, s)
		if err != nil {
			return err
		}
		for _, x := range ss {
			if id != "" && sessionPublicID(x.ID) == id {
				current = x.ID == s.id
				return tx.DeleteSession(x.ID)
			}
		}
		return errNotFound("session")
	})
	return current, err
}

// EndOtherSessions ends every session of the account signed in with token
// except that one.
func (a *App) EndOtherSessions(ctx context.Context, token string) error {
	s, err := a.Authenticate(ctx, token)
	if err != nil {
		return err
	}
	return a.store.Write(ctx, func(tx store.Tx) error { return tx.DeleteUserSessions(s.User.ID, s.id) })
}
