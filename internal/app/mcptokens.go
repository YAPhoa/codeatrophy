package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// MCP tokens: each account makes its own bearer tokens for its MCP
// clients, sees when each was last used, and revokes them. The store keeps
// only a token's SHA-256 hash; the token is shown once, when it is made.

const (
	// MCPTokenPrefix starts every account MCP token, so that one is
	// recognisable in a config file or a leak scanner.
	MCPTokenPrefix = "cat_"
	// MaxMCPTokens is how many tokens one account may hold.
	MaxMCPTokens       = 20
	maxMCPTokenName    = 60
	mcpTokenTouchEvery = time.Hour
)

// MCPToken is an account's MCP token as clients see it; the token itself
// is only in MCPTokenCreated.
type MCPToken struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Hint       string     `json:"hint"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
}

// MCPTokenCreated is a new token, the one time it is shown.
type MCPTokenCreated struct {
	MCPToken
	Token string `json:"token"`
}

// MCPTokenInput names a new token.
type MCPTokenInput struct {
	Name string `json:"name"`
}

func mcpToken(t store.MCPToken) MCPToken {
	return MCPToken{ID: t.ID[:16], Name: t.Name, Hint: t.Hint, CreatedAt: t.CreatedAt, LastUsedAt: t.LastUsedAt}
}

// ListMCPTokens returns the tokens of the account signed in with session
// token, newest first.
func (a *App) ListMCPTokens(ctx context.Context, session string) ([]MCPToken, error) {
	s, err := a.Authenticate(ctx, session)
	if err != nil {
		return nil, err
	}
	var ts []store.MCPToken
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { ts, err = tx.ListMCPTokens(s.User.ID); return }); err != nil {
		return nil, err
	}
	out := make([]MCPToken, len(ts))
	for i, t := range ts {
		out[i] = mcpToken(t)
	}
	return out, nil
}

// CreateMCPToken makes a token for the account signed in with session.
func (a *App) CreateMCPToken(ctx context.Context, session string, in MCPTokenInput) (MCPTokenCreated, error) {
	s, err := a.Authenticate(ctx, session)
	if err != nil {
		return MCPTokenCreated{}, err
	}
	name := strings.TrimSpace(domain.NormalizeText(in.Name))
	switch n := len([]rune(name)); {
	case n == 0:
		return MCPTokenCreated{}, errField("name", "is required")
	case n > maxMCPTokenName:
		return MCPTokenCreated{}, errField("name", fmt.Sprintf("must be at most %d characters", maxMCPTokenName))
	case strings.ContainsFunc(name, func(r rune) bool { return r < 0x20 || r == 0x7f || r == ' ' || r == ' ' }):
		return MCPTokenCreated{}, errField("name", "must be a single line")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return MCPTokenCreated{}, err
	}
	token := MCPTokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	t := store.MCPToken{ID: sessionID(token), UserID: s.User.ID, Name: name, Hint: token[len(token)-4:],
		CreatedAt: a.now().UTC()}
	err = a.store.Write(ctx, func(tx store.Tx) error {
		ts, err := tx.ListMCPTokens(s.User.ID)
		if err != nil {
			return err
		}
		if len(ts) >= MaxMCPTokens {
			return errConflict(fmt.Sprintf("an account may hold at most %d MCP tokens; revoke one first", MaxMCPTokens), nil)
		}
		return tx.InsertMCPToken(&t)
	})
	if err != nil {
		return MCPTokenCreated{}, err
	}
	a.log.Info("mcp token created", "account", s.User.Email, "name", name)
	return MCPTokenCreated{MCPToken: mcpToken(t), Token: token}, nil
}

// DeleteMCPToken revokes a token of the account signed in with session.
// id is the token's id as listed.
func (a *App) DeleteMCPToken(ctx context.Context, session, id string) error {
	s, err := a.Authenticate(ctx, session)
	if err != nil {
		return err
	}
	var name string
	err = a.store.Write(ctx, func(tx store.Tx) error {
		ts, err := tx.ListMCPTokens(s.User.ID)
		if err != nil {
			return err
		}
		for _, t := range ts {
			if id != "" && mcpToken(t).ID == id {
				name = t.Name
				_, err := tx.DeleteMCPToken(s.User.ID, t.ID)
				return err
			}
		}
		return errNotFound("MCP token")
	})
	if err == nil {
		a.log.Info("mcp token revoked", "account", s.User.Email, "name", name)
	}
	return err
}

// AuthenticateMCPToken returns the account an MCP bearer token belongs to,
// and records when it was last used (at most once an hour).
func (a *App) AuthenticateMCPToken(ctx context.Context, token string) (AuthUser, error) {
	if !strings.HasPrefix(token, MCPTokenPrefix) || len(token) > 256 {
		return AuthUser{}, errUnauthorized("unknown MCP token")
	}
	id := sessionID(token)
	var (
		t store.MCPToken
		u store.User
	)
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		if t, err = tx.GetMCPToken(id); err != nil {
			return err
		}
		u, err = tx.GetUser(t.UserID)
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return AuthUser{}, errUnauthorized("unknown MCP token")
	}
	if err != nil {
		return AuthUser{}, err
	}
	now := a.now().UTC()
	if t.LastUsedAt == nil || now.Sub(*t.LastUsedAt) >= mcpTokenTouchEvery {
		if err := a.store.Write(ctx, func(tx store.Tx) error { return tx.TouchMCPToken(id, now) }); err != nil {
			return AuthUser{}, err
		}
	}
	return authUser(u), nil
}

// MCPSessionStarted logs that an MCP client has opened a session, acting
// for the account of ctx. client and version are what the client says it
// is, and are not verified.
func (a *App) MCPSessionStarted(ctx context.Context, client, version string) {
	text := func(s string) string {
		if c := domain.CleanSourceText(s); c != nil {
			return *c
		}
		return ""
	}
	args := []any{"client", text(client), "version", text(version)}
	if id := accountOf(ctx); id != store.Unowned {
		var u store.User
		if err := a.store.Read(ctx, func(tx store.Tx) (err error) { u, err = tx.GetUser(id); return }); err == nil {
			args = append(args, "account", u.Email)
		}
	}
	a.log.Info("mcp session started", args...)
}
