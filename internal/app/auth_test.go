package app_test

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"codeatrophy/internal/app"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/teststore"
)

func init() { app.FastPasswordHashes() }

type authEnv struct {
	app   *app.App
	db    store.Store
	clock *time.Time
	ctx   context.Context
}

func newAuthEnv(t *testing.T, enabled bool) *authEnv {
	t.Helper()
	db := teststore.Open(t)
	clock := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	e := &authEnv{db: db, clock: &clock, ctx: context.Background()}
	box, err := secrets.NewBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	e.app = app.New(app.Options{Store: db, Now: func() time.Time { return *e.clock },
		Secrets: box, Auth: app.AuthOptions{Enabled: enabled, SessionTTL: 48 * time.Hour}, HealthInterval: time.Hour})
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
	if _, err := e.app.Login(e.ctx, app.LoginInput{Email: "a@b.c", Password: "whatever1"}, app.LoginClient{Addr: "c"}, ""); code(err) != app.CodeBadRequest {
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
	if _, err := e.app.Setup(e.ctx, in, ""); code(err) != app.CodeValidation || !strings.Contains(err.Error(), "at least 8") {
		t.Fatalf("short password: %v", err)
	}
	in.Password = "correct horse"
	si, err := e.app.Setup(e.ctx, in, "")
	if err != nil {
		t.Fatal(err)
	}
	if si.User.Email != "me@example.com" || si.Token == "" || !si.ExpiresAt.Equal(e.clock.Add(48*time.Hour)) {
		t.Errorf("setup: %+v", si)
	}
	if _, err := e.app.Setup(e.ctx, in, ""); code(err) != app.CodeConflict {
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
	if _, err := e.app.Login(e.ctx, app.LoginInput{Email: "me@example.com", Password: "wrong password"}, app.LoginClient{Addr: "c2"}, ""); code(err) != app.CodeUnauthorized {
		t.Errorf("wrong password: %v", err)
	}
	if _, err := e.app.Login(e.ctx, app.LoginInput{Email: "nobody@example.com", Password: "correct horse"}, app.LoginClient{Addr: "c2"}, ""); code(err) != app.CodeUnauthorized {
		t.Errorf("unknown account: %v", err)
	}
	si2, err := e.app.Login(e.ctx, app.LoginInput{Email: "ME@example.com", Password: "correct horse"}, app.LoginClient{Addr: "c2"}, "")
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
	si, err := e.app.Login(e.ctx, app.LoginInput{Email: "me@example.com", Password: "correct horse"}, app.LoginClient{Addr: "c"}, "")
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
		if _, err := e.app.Login(e.ctx, bad, app.LoginClient{Addr: "attacker"}, ""); code(err) != app.CodeUnauthorized {
			t.Fatalf("failure: %v", err)
		}
	}
	good := app.LoginInput{Email: "me@example.com", Password: "correct horse"}
	_, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "attacker"}, "")
	if code(err) != app.CodeRateLimited {
		t.Fatalf("11th attempt: %v", err)
	}
	if ae := app.AsError(err); ae.RetryAfter <= 0 || ae.RetryAfter > 15*time.Minute {
		t.Errorf("retry after %v", ae.RetryAfter)
	}
	// Another client is not held back, and the limit lifts with time.
	if _, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "owner"}, ""); err != nil {
		t.Errorf("other client: %v", err)
	}
	*e.clock = e.clock.Add(15*time.Minute + time.Second)
	if _, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "attacker"}, ""); err != nil {
		t.Errorf("after the window: %v", err)
	}
}

// Behind a reverse proxy every client has the proxy's address. A browser
// that signed in before keeps its own count, so failures from others at
// the same address do not keep its owner out.
func TestAuthRateLimitKnownBrowser(t *testing.T) {
	e := newAuthEnv(t, true)
	for _, email := range []string{"me@example.com", "other@example.com"} {
		if _, err := e.app.CreateUser(e.ctx, email, "correct horse"); err != nil {
			t.Fatal(err)
		}
	}
	good := app.LoginInput{Email: "me@example.com", Password: "correct horse"}
	bad := app.LoginInput{Email: "me@example.com", Password: "wrong password"}
	first, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "proxy"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if first.Device == "" {
		t.Fatal("no device issued")
	}
	other, err := e.app.Login(e.ctx, app.LoginInput{Email: "other@example.com", Password: "correct horse"}, app.LoginClient{Addr: "proxy"}, "")
	if err != nil {
		t.Fatal(err)
	}
	for range 10 {
		if _, err := e.app.Login(e.ctx, bad, app.LoginClient{Addr: "proxy"}, ""); code(err) != app.CodeUnauthorized {
			t.Fatalf("failure: %v", err)
		}
	}
	if _, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "proxy"}, ""); code(err) != app.CodeRateLimited {
		t.Fatalf("new browser at the limited address: %v", err)
	}
	// The browser that signed in before gets in.
	again, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "proxy", Device: first.Device}, "")
	if err != nil {
		t.Fatalf("known browser: %v", err)
	}
	if again.Device == "" || again.Device == first.Device {
		t.Errorf("device not renewed: %q", again.Device)
	}
	// A device of another account, or a made-up one, is no way around the
	// limit.
	for name, device := range map[string]string{"other account": other.Device, "made up": "bm90LWEtZGV2aWNl", "sealed elsewhere": "djE6AAAA"} {
		if _, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "proxy", Device: device}, ""); code(err) != app.CodeRateLimited {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A known browser has its own limit.
	for range 10 {
		if _, err := e.app.Login(e.ctx, bad, app.LoginClient{Addr: "elsewhere", Device: first.Device}, ""); code(err) != app.CodeUnauthorized {
			t.Fatalf("known browser failure: %v", err)
		}
	}
	if _, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "elsewhere", Device: first.Device}, ""); code(err) != app.CodeRateLimited {
		t.Errorf("known browser over its limit: %v", err)
	}
	if _, err := e.app.Login(e.ctx, good, app.LoginClient{Addr: "elsewhere"}, ""); err != nil {
		t.Errorf("the address is not limited by the browser's failures: %v", err)
	}
}

func TestAuthChangePassword(t *testing.T) {
	e := newAuthEnv(t, true)
	if _, err := e.app.CreateUser(e.ctx, "me@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	login := func(pw string) (app.SignIn, error) {
		return e.app.Login(e.ctx, app.LoginInput{Email: "me@example.com", Password: pw}, app.LoginClient{Addr: "c"}, "")
	}
	a, _ := login("correct horse")
	b, _ := login("correct horse")
	if err := e.app.ChangePassword(e.ctx, "", app.PasswordChange{NewPassword: "battery staple"}); code(err) != app.CodeUnauthorized {
		t.Fatalf("without a session: %v", err)
	}
	for _, pw := range []string{"short", strings.Repeat("x", app.MaxPasswordBytes+1)} {
		err := e.app.ChangePassword(e.ctx, a.Token, app.PasswordChange{NewPassword: pw})
		if ae := app.AsError(err); ae == nil || ae.Code != app.CodeValidation || ae.Fields["newPassword"] == nil {
			t.Fatalf("new password of %d bytes: %v", len(pw), err)
		}
	}
	// The session alone authorizes the change: no current password.
	if err := e.app.ChangePassword(e.ctx, a.Token, app.PasswordChange{NewPassword: "battery staple"}); err != nil {
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
	si, err := e.app.Login(e.ctx, app.LoginInput{Email: "a@example.com", Password: "correct horse"}, app.LoginClient{Addr: "c"}, "")
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
		si, err := e.app.Login(e.ctx, app.LoginInput{Email: email, Password: "correct horse"}, app.LoginClient{Addr: "c"}, "")
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

func TestAuthSessions(t *testing.T) {
	e := newAuthEnv(t, true)
	for _, email := range []string{"me@example.com", "you@example.com"} {
		if _, err := e.app.CreateUser(e.ctx, email, "correct horse"); err != nil {
			t.Fatal(err)
		}
	}
	firefox := "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
	chrome := "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
	login := func(email, ua string) string {
		t.Helper()
		si, err := e.app.Login(e.ctx, app.LoginInput{Email: email, Password: "correct horse"}, app.LoginClient{Addr: "c"}, ua)
		if err != nil {
			t.Fatal(err)
		}
		return si.Token
	}
	start := *e.clock
	laptop := login("me@example.com", firefox)
	*e.clock = e.clock.Add(time.Minute)
	desk := login("me@example.com", chrome)
	*e.clock = e.clock.Add(time.Minute)
	old := login("me@example.com", "")
	you := login("you@example.com", firefox)

	// Used again after the refresh period: the laptop's last use moves.
	*e.clock = e.clock.Add(2 * time.Hour)
	if _, err := e.app.Authenticate(e.ctx, laptop); err != nil {
		t.Fatal(err)
	}
	list, err := e.app.ListSessions(e.ctx, desk)
	if err != nil {
		t.Fatal(err)
	}
	got := ""
	for _, s := range list {
		got += fmt.Sprintf("%s current=%v created=%s used=%s; ", s.Browser, s.Current,
			s.CreatedAt.Sub(start), s.LastUsedAt.Sub(start))
	}
	// Listing with desk used desk too, after the refresh period.
	if want := "Chrome on macOS current=true created=1m0s used=2h2m0s; " +
		"Firefox on Linux current=false created=0s used=2h2m0s; " +
		"Unknown browser current=false created=2m0s used=2m0s; "; got != want {
		t.Errorf("sessions:\n got %s\nwant %s", got, want)
	}
	for _, s := range list {
		if len(s.ID) != 16 || strings.Contains(laptop+desk+old, s.ID) {
			t.Errorf("session id %q", s.ID)
		}
	}
	idOf := func(token, browser string) string {
		t.Helper()
		l, err := e.app.ListSessions(e.ctx, token)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range l {
			if s.Browser == browser {
				return s.ID
			}
		}
		t.Fatalf("no %s session", browser)
		return ""
	}
	if l, _ := e.app.ListSessions(e.ctx, you); len(l) != 1 || !l[0].Current {
		t.Errorf("another account's sessions: %+v", l)
	}

	// Another account's session and unknown ids are not found.
	if _, err := e.app.EndSession(e.ctx, you, idOf(desk, "Unknown browser")); code(err) != app.CodeNotFound {
		t.Errorf("ended by another account: %v", err)
	}
	for _, id := range []string{"", "nope", list[0].ID[:15]} {
		if _, err := e.app.EndSession(e.ctx, desk, id); code(err) != app.CodeNotFound {
			t.Errorf("unknown id %q: %v", id, err)
		}
	}
	// Ending another session of the account.
	if cur, err := e.app.EndSession(e.ctx, desk, idOf(desk, "Unknown browser")); err != nil || cur {
		t.Fatalf("end old: %v, %v", cur, err)
	}
	if _, err := e.app.Authenticate(e.ctx, old); code(err) != app.CodeUnauthorized {
		t.Errorf("ended session: %v", err)
	}
	// Ending the others keeps this one and other accounts'.
	if err := e.app.EndOtherSessions(e.ctx, desk); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.Authenticate(e.ctx, laptop); code(err) != app.CodeUnauthorized {
		t.Errorf("other session after end-others: %v", err)
	}
	for _, tk := range []string{desk, you} {
		if _, err := e.app.Authenticate(e.ctx, tk); err != nil {
			t.Errorf("after end-others: %v", err)
		}
	}
	// Ending its own session signs it out.
	if cur, err := e.app.EndSession(e.ctx, desk, idOf(desk, "Chrome on macOS")); err != nil || !cur {
		t.Fatalf("end own: %v, %v", cur, err)
	}
	if _, err := e.app.ListSessions(e.ctx, desk); code(err) != app.CodeUnauthorized {
		t.Errorf("after ending its own session: %v", err)
	}

	// Expired sessions are not listed, nor can they be ended.
	login("you@example.com", chrome)
	*e.clock = e.clock.Add(47 * time.Hour)
	if _, err := e.app.Authenticate(e.ctx, you); err != nil {
		t.Fatal(err)
	}
	*e.clock = e.clock.Add(2 * time.Hour)
	if l, _ := e.app.ListSessions(e.ctx, you); len(l) != 1 || l[0].Browser != "Firefox on Linux" {
		t.Errorf("with an expired session: %+v", l)
	}
}

func TestAuthSessionUserAgentIsBounded(t *testing.T) {
	e := newAuthEnv(t, true)
	if _, err := e.app.CreateUser(e.ctx, "me@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	ua := "Firefox/1 \x00\n" + strings.Repeat("é", 300)
	if _, err := e.app.Login(e.ctx, app.LoginInput{Email: "me@example.com", Password: "correct horse"}, app.LoginClient{Addr: "c"}, ua); err != nil {
		t.Fatal(err)
	}
	var ss []store.Session
	_ = e.db.Read(e.ctx, func(tx store.Tx) error {
		u, err := tx.GetUserByEmail("me@example.com")
		if err == nil {
			ss, err = tx.ListUserSessions(u.ID)
		}
		return err
	})
	if len(ss) != 1 {
		t.Fatalf("sessions: %+v", ss)
	}
	got := ss[0].UserAgent
	if len(got) > 256 || len(got) < 250 || !utf8.ValidString(got) || !strings.HasPrefix(got, "Firefox/1 é") {
		t.Errorf("stored user agent (%d bytes): %q", len(got), got)
	}
}

func TestAuthSessionUserAgentFilledIn(t *testing.T) {
	e := newAuthEnv(t, true)
	if _, err := e.app.CreateUser(e.ctx, "me@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	// A session that began before the User-Agent was recorded.
	si, err := e.app.Login(e.ctx, app.LoginInput{Email: "me@example.com", Password: "correct horse"}, app.LoginClient{Addr: "c"}, "")
	if err != nil {
		t.Fatal(err)
	}
	s, err := e.app.Authenticate(e.ctx, si.Token)
	if err != nil || !s.UserAgentUnknown {
		t.Fatalf("blank session: %+v, %v", s, err)
	}
	fedora := "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0"
	if err := e.app.NoteUserAgent(e.ctx, si.Token, fedora); err != nil {
		t.Fatal(err)
	}
	// Recorded once: a later browser does not replace it.
	if err := e.app.NoteUserAgent(e.ctx, si.Token, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0.0.0 Safari/537.36"); err != nil {
		t.Fatal(err)
	}
	if s, err := e.app.Authenticate(e.ctx, si.Token); err != nil || s.UserAgentUnknown {
		t.Fatalf("after noting: %+v, %v", s, err)
	}
	list, err := e.app.ListSessions(e.ctx, si.Token)
	if err != nil || len(list) != 1 || list[0].Browser != "Firefox on Fedora" {
		t.Errorf("sessions: %+v, %v", list, err)
	}
}
