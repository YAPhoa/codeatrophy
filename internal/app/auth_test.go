package app_test

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/teststore"
)

func init() { app.FastPasswordHashes() }

// logCapture records the attributes of every log record.
type logCapture struct {
	mu    sync.Mutex
	attrs map[string]string
}

func (l *logCapture) Enabled(context.Context, slog.Level) bool { return true }
func (l *logCapture) Handle(_ context.Context, r slog.Record) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	r.Attrs(func(a slog.Attr) bool { l.attrs[a.Key] = a.Value.String(); return true })
	return nil
}
func (l *logCapture) WithAttrs([]slog.Attr) slog.Handler { return l }
func (l *logCapture) WithGroup(string) slog.Handler      { return l }

func (l *logCapture) get(key string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.attrs[key]
}

type authEnv struct {
	app   *app.App
	db    store.Store
	logs  *logCapture
	clock *time.Time
	ctx   context.Context
}

func newAuthEnv(t *testing.T, enabled bool) *authEnv {
	t.Helper()
	db := teststore.Open(t)
	logs := &logCapture{attrs: map[string]string{}}
	clock := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	e := &authEnv{db: db, logs: logs, clock: &clock, ctx: context.Background()}
	e.app = app.New(app.Options{Store: db, Logger: slog.New(logs), Now: func() time.Time { return *e.clock },
		Auth: app.AuthOptions{Enabled: enabled, SessionTTL: 48 * time.Hour}, HealthInterval: time.Hour})
	if err := e.app.Start(e.ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.app.Stop)
	return e
}

func TestAuthOff(t *testing.T) {
	e := newAuthEnv(t, false)
	st, err := e.app.GetAuthStatus(e.ctx, "")
	if err != nil || st.Enabled || st.SetupRequired || st.User != nil {
		t.Fatalf("status %+v, %v", st, err)
	}
	if _, err := e.app.Login(e.ctx, app.LoginInput{Email: "a@b.c", Password: "whatever1"}, "c"); code(err) != app.CodeBadRequest {
		t.Errorf("login with sign-in off: %v", err)
	}
}

func TestAuthSetupAndLogin(t *testing.T) {
	e := newAuthEnv(t, true)
	st, err := e.app.GetAuthStatus(e.ctx, "")
	if err != nil || !st.Enabled || !st.SetupRequired {
		t.Fatalf("status before setup %+v, %v", st, err)
	}

	in := app.SetupInput{Email: " Me@Example.COM ", Password: "short"}
	if _, err := e.app.Setup(e.ctx, in); code(err) != app.CodeValidation || !strings.Contains(err.Error(), "at least 8") {
		t.Fatalf("short password: %v", err)
	}
	in.Password = "correct horse"
	si, err := e.app.Setup(e.ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if si.User.Email != "me@example.com" || si.Token == "" || !si.ExpiresAt.Equal(e.clock.Add(48*time.Hour)) {
		t.Errorf("setup: %+v", si)
	}
	if _, err := e.app.Setup(e.ctx, in); code(err) != app.CodeConflict {
		t.Errorf("second setup: %v", err)
	}

	// The token is not stored as is.
	var sessions []store.Session
	_ = e.db.Read(e.ctx, func(tx store.Tx) error {
		s, err := tx.GetSession(si.Token)
		if err == nil {
			sessions = append(sessions, s)
		}
		return nil
	})
	if len(sessions) != 0 {
		t.Error("the session is stored under its token")
	}

	st, err = e.app.GetAuthStatus(e.ctx, si.Token)
	if err != nil || st.SetupRequired || st.User == nil || st.User.Email != "me@example.com" {
		t.Fatalf("status after setup %+v, %v", st, err)
	}

	// Sign in: the email is case-insensitive; wrong passwords and unknown
	// accounts get the same answer.
	if _, err := e.app.Login(e.ctx, app.LoginInput{Email: "me@example.com", Password: "wrong password"}, "c2"); code(err) != app.CodeUnauthorized {
		t.Errorf("wrong password: %v", err)
	}
	if _, err := e.app.Login(e.ctx, app.LoginInput{Email: "nobody@example.com", Password: "correct horse"}, "c2"); code(err) != app.CodeUnauthorized {
		t.Errorf("unknown account: %v", err)
	}
	si2, err := e.app.Login(e.ctx, app.LoginInput{Email: "ME@example.com", Password: "correct horse"}, "c2")
	if err != nil {
		t.Fatal(err)
	}
	if si2.Token == si.Token {
		t.Error("two sign-ins share a token")
	}

	// Sign out ends that session only.
	if err := e.app.Logout(e.ctx, si2.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.Authenticate(e.ctx, si2.Token); code(err) != app.CodeUnauthorized {
		t.Errorf("after logout: %v", err)
	}
	if _, err := e.app.Authenticate(e.ctx, si.Token); err != nil {
		t.Errorf("other session after logout: %v", err)
	}
}

func TestAuthSessionExpiry(t *testing.T) {
	e := newAuthEnv(t, true)
	if _, err := e.app.CreateUser(e.ctx, "me@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	si, err := e.app.Login(e.ctx, app.LoginInput{Email: "me@example.com", Password: "correct horse"}, "c")
	if err != nil {
		t.Fatal(err)
	}
	// Within the first hour the expiry stays as it is.
	*e.clock = e.clock.Add(30 * time.Minute)
	s, err := e.app.Authenticate(e.ctx, si.Token)
	if err != nil || s.Extended || !s.ExpiresAt.Equal(si.ExpiresAt) {
		t.Fatalf("early check: %+v, %v", s, err)
	}
	// Later, a session in use is pushed back.
	*e.clock = e.clock.Add(24 * time.Hour)
	s, err = e.app.Authenticate(e.ctx, si.Token)
	if err != nil || !s.Extended || !s.ExpiresAt.Equal(e.clock.Add(48*time.Hour)) {
		t.Fatalf("later check: %+v, %v", s, err)
	}
	// An unused one ends.
	*e.clock = e.clock.Add(48 * time.Hour)
	if _, err := e.app.Authenticate(e.ctx, si.Token); code(err) != app.CodeUnauthorized {
		t.Errorf("expired: %v", err)
	}
	if _, err := e.app.Authenticate(e.ctx, "not-a-token"); code(err) != app.CodeUnauthorized {
		t.Errorf("unknown token: %v", err)
	}
	if _, err := e.app.Authenticate(e.ctx, ""); code(err) != app.CodeUnauthorized {
		t.Errorf("no token: %v", err)
	}
}

func TestAuthRateLimit(t *testing.T) {
	e := newAuthEnv(t, true)
	if _, err := e.app.CreateUser(e.ctx, "me@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	bad := app.LoginInput{Email: "me@example.com", Password: "wrong password"}
	for range 10 {
		if _, err := e.app.Login(e.ctx, bad, "attacker"); code(err) != app.CodeUnauthorized {
			t.Fatalf("failure: %v", err)
		}
	}
	good := app.LoginInput{Email: "me@example.com", Password: "correct horse"}
	_, err := e.app.Login(e.ctx, good, "attacker")
	if code(err) != app.CodeRateLimited {
		t.Fatalf("11th attempt: %v", err)
	}
	if ae := app.AsError(err); ae.RetryAfter <= 0 || ae.RetryAfter > 15*time.Minute {
		t.Errorf("retry after %v", ae.RetryAfter)
	}
	// Another client is not held back, and the limit lifts with time.
	if _, err := e.app.Login(e.ctx, good, "owner"); err != nil {
		t.Errorf("other client: %v", err)
	}
	*e.clock = e.clock.Add(15*time.Minute + time.Second)
	if _, err := e.app.Login(e.ctx, good, "attacker"); err != nil {
		t.Errorf("after the window: %v", err)
	}
}

func TestAuthChangePassword(t *testing.T) {
	e := newAuthEnv(t, true)
	if _, err := e.app.CreateUser(e.ctx, "me@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	login := func(pw string) (app.SignIn, error) {
		return e.app.Login(e.ctx, app.LoginInput{Email: "me@example.com", Password: pw}, "c")
	}
	a, _ := login("correct horse")
	b, _ := login("correct horse")
	err := e.app.ChangePassword(e.ctx, a.Token, app.PasswordChange{CurrentPassword: "nope nope", NewPassword: "battery staple"}, "c")
	if code(err) != app.CodeValidation {
		t.Fatalf("wrong current password: %v", err)
	}
	if err := e.app.ChangePassword(e.ctx, a.Token, app.PasswordChange{CurrentPassword: "correct horse", NewPassword: "battery staple"}, "c"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.Authenticate(e.ctx, a.Token); err != nil {
		t.Errorf("the changing session ended: %v", err)
	}
	if _, err := e.app.Authenticate(e.ctx, b.Token); code(err) != app.CodeUnauthorized {
		t.Errorf("another session survived: %v", err)
	}
	if _, err := login("correct horse"); code(err) != app.CodeUnauthorized {
		t.Errorf("old password: %v", err)
	}
	if _, err := login("battery staple"); err != nil {
		t.Errorf("new password: %v", err)
	}
}

func TestAuthAccounts(t *testing.T) {
	e := newAuthEnv(t, true)
	if _, err := e.app.CreateUser(e.ctx, "not-an-email", "correct horse"); code(err) != app.CodeValidation {
		t.Errorf("bad email: %v", err)
	}
	if _, err := e.app.CreateUser(e.ctx, "a@example.com", strings.Repeat("x", 73)); code(err) != app.CodeValidation {
		t.Errorf("long password: %v", err)
	}
	if _, err := e.app.CreateUser(e.ctx, "A@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.CreateUser(e.ctx, "a@example.com", "correct horse"); code(err) != app.CodeConflict {
		t.Errorf("duplicate: %v", err)
	}
	si, err := e.app.Login(e.ctx, app.LoginInput{Email: "a@example.com", Password: "correct horse"}, "c")
	if err != nil {
		t.Fatal(err)
	}
	if err := e.app.SetUserPassword(e.ctx, "A@EXAMPLE.COM", "battery staple"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.Authenticate(e.ctx, si.Token); code(err) != app.CodeUnauthorized {
		t.Errorf("session survived a password reset: %v", err)
	}
	if err := e.app.SetUserPassword(e.ctx, "nobody@example.com", "battery staple"); code(err) != app.CodeNotFound {
		t.Errorf("reset of no account: %v", err)
	}
	users, err := e.app.ListUsers(e.ctx)
	if err != nil || len(users) != 1 || users[0].Email != "a@example.com" {
		t.Fatalf("users %+v, %v", users, err)
	}
	if err := e.app.DeleteUser(e.ctx, "a@example.com"); err != nil {
		t.Fatal(err)
	}
	// With no account left, setup is needed again, with a new code.
	st, err := e.app.GetAuthStatus(e.ctx, "")
	if err != nil || !st.SetupRequired {
		t.Errorf("after deleting the last account: %+v, %v", st, err)
	}
}

func TestMCPTokens(t *testing.T) {
	e := newAuthEnv(t, true)
	for _, email := range []string{"me@example.com", "you@example.com"} {
		if _, err := e.app.CreateUser(e.ctx, email, "correct horse"); err != nil {
			t.Fatal(err)
		}
	}
	login := func(email string) string {
		si, err := e.app.Login(e.ctx, app.LoginInput{Email: email, Password: "correct horse"}, "c")
		if err != nil {
			t.Fatal(err)
		}
		return si.Token
	}
	me, you := login("me@example.com"), login("you@example.com")

	if _, err := e.app.CreateMCPToken(e.ctx, me, app.MCPTokenInput{Name: "  "}); code(err) != app.CodeValidation {
		t.Errorf("blank name: %v", err)
	}
	if _, err := e.app.CreateMCPToken(e.ctx, me, app.MCPTokenInput{Name: "a\nb"}); code(err) != app.CodeValidation {
		t.Errorf("two lines: %v", err)
	}
	if _, err := e.app.CreateMCPToken(e.ctx, "", app.MCPTokenInput{Name: "x"}); code(err) != app.CodeUnauthorized {
		t.Errorf("signed out: %v", err)
	}
	made, err := e.app.CreateMCPToken(e.ctx, me, app.MCPTokenInput{Name: " Laptop "})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(made.Token, app.MCPTokenPrefix) || made.Name != "Laptop" || made.Hint != made.Token[len(made.Token)-4:] || made.LastUsedAt != nil {
		t.Errorf("made: %+v", made)
	}
	u, err := e.app.AuthenticateMCPToken(e.ctx, made.Token)
	if err != nil || u.Email != "me@example.com" {
		t.Fatalf("authenticate: %+v, %v", u, err)
	}
	for _, bad := range []string{"", "cat_nope", made.Token[len(app.MCPTokenPrefix):]} {
		if _, err := e.app.AuthenticateMCPToken(e.ctx, bad); code(err) != app.CodeUnauthorized {
			t.Errorf("token %q: %v", bad, err)
		}
	}
	list, err := e.app.ListMCPTokens(e.ctx, me)
	if err != nil || len(list) != 1 || list[0].ID != made.ID || list[0].LastUsedAt == nil {
		t.Fatalf("list: %+v, %v", list, err)
	}
	if l, _ := e.app.ListMCPTokens(e.ctx, you); len(l) != 0 {
		t.Errorf("another account sees my tokens: %+v", l)
	}
	// Only the owner revokes a token, and a revoked token stops working.
	if err := e.app.DeleteMCPToken(e.ctx, you, made.ID); code(err) != app.CodeNotFound {
		t.Errorf("revoked by another account: %v", err)
	}
	if err := e.app.DeleteMCPToken(e.ctx, me, made.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.AuthenticateMCPToken(e.ctx, made.Token); code(err) != app.CodeUnauthorized {
		t.Errorf("revoked token: %v", err)
	}
	// An account holds a bounded number.
	for i := range app.MaxMCPTokens {
		if _, err := e.app.CreateMCPToken(e.ctx, me, app.MCPTokenInput{Name: fmt.Sprint("t", i)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.app.CreateMCPToken(e.ctx, me, app.MCPTokenInput{Name: "one more"}); code(err) != app.CodeConflict {
		t.Errorf("over the limit: %v", err)
	}
	// A deleted account's tokens stop working.
	last, _ := e.app.CreateMCPToken(e.ctx, you, app.MCPTokenInput{Name: "x"})
	if err := e.app.DeleteUser(e.ctx, "you@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.AuthenticateMCPToken(e.ctx, last.Token); code(err) != app.CodeUnauthorized {
		t.Errorf("token of a deleted account: %v", err)
	}
}

// Accounts made in the same second keep the order they were made in: the
// default account is the first, which took over the data kept before any
// account existed.
func TestDefaultAccountIsTheFirstMadeInTheSameSecond(t *testing.T) {
	e := newAuthEnv(t, false)
	if id, err := e.app.DefaultAccount(e.ctx); err != nil || id != store.Unowned {
		t.Fatalf("before any account: %q, %v", id, err)
	}
	var first string
	for i := range 8 {
		u, err := e.app.CreateUser(e.ctx, fmt.Sprintf("user%d@example.com", i), "correct horse")
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = u.ID
		}
	}
	if id, err := e.app.DefaultAccount(e.ctx); err != nil || id != first {
		t.Errorf("default account %q, want the first made, %q (err %v)", id, first, err)
	}
}
