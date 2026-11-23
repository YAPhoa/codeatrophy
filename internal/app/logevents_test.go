package app_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store/teststore"
)

// jsonLog collects JSON log records.
type jsonLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *jsonLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *jsonLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// find returns the last record with the message msg, or nil.
func (l *jsonLog) find(t *testing.T, msg string) map[string]any {
	t.Helper()
	var found map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		if m["msg"] == msg {
			found = m
		}
	}
	return found
}

const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"

// Every start warns while no account exists that the first one is still to
// be created, and stops once one does; with sign-in off, every start warns
// of that instead.
func TestStartupWarnings(t *testing.T) {
	ctx := context.Background()
	db := teststore.Open(t)
	box, err := secrets.NewBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	start := func(auth bool) (*app.App, *jsonLog) {
		t.Helper()
		logs := &jsonLog{}
		a := app.New(app.Options{Store: db, Secrets: box, HealthInterval: time.Hour,
			Logger: slog.New(slog.NewJSONHandler(logs, nil)), Auth: app.AuthOptions{Enabled: auth}})
		if err := a.Start(ctx); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(a.Stop)
		return a, logs
	}
	const noAccount = "no account exists yet: open the web UI to create the first one"
	const signInOff = "sign-in is turned off (CODEATROPHY_AUTH=off): anyone who can reach this server can use it"

	a, logs := start(true)
	if r := logs.find(t, noAccount); r == nil || r["level"] != "WARN" {
		t.Errorf("first start: %s", logs)
	}
	if _, err := a.CreateUser(ctx, "me@example.com", "first-password-1"); err != nil {
		t.Fatal(err)
	}
	a.Stop()
	a, logs = start(true)
	if s := logs.String(); strings.Contains(s, noAccount) || strings.Contains(s, signInOff) {
		t.Errorf("a start with an account: %s", logs)
	}
	a.Stop()
	_, logs = start(false)
	if r := logs.find(t, signInOff); r == nil || r["level"] != "WARN" || strings.Contains(logs.String(), noAccount) {
		t.Errorf("a start with sign-in off: %s", logs)
	}
}

// Account events are logged with the account and never with a password,
// a token or a token's hash.
func TestAccountEventsAreLogged(t *testing.T) {
	ctx := context.Background()
	logs := &jsonLog{}
	box, err := secrets.NewBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	a := app.New(app.Options{Store: teststore.Open(t), Secrets: box, HealthInterval: time.Hour,
		Logger: slog.New(slog.NewJSONHandler(logs, nil)), Auth: app.AuthOptions{Enabled: true}})
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Stop)

	const pw, newPW = "first-password-1", "second-password-2"
	if _, err := a.CreateUser(ctx, "Me@Example.com", pw); err != nil {
		t.Fatal(err)
	}
	if r := logs.find(t, "account created"); r == nil || r["account"] != "me@example.com" {
		t.Errorf("account created: %v", r)
	}

	if _, err := a.Login(ctx, app.LoginInput{Email: "me@example.com", Password: "wrong-password-3"},
		app.LoginClient{Addr: "203.0.113.7"}, firefox); code(err) != app.CodeUnauthorized {
		t.Fatalf("wrong password: %v", err)
	}
	if r := logs.find(t, "failed sign-in"); r == nil || r["account"] != "me@example.com" || r["client"] != "203.0.113.7" {
		t.Errorf("failed sign-in: %v", r)
	}
	if _, err := a.Login(ctx, app.LoginInput{Email: "nobody-typed-this@example.com", Password: "wrong-password-3"},
		app.LoginClient{Addr: "203.0.113.7"}, firefox); code(err) != app.CodeUnauthorized {
		t.Fatalf("unknown account: %v", err)
	}
	if strings.Contains(logs.String(), "nobody-typed-this") {
		t.Error("an email that matches no account was logged")
	}

	in, err := a.Login(ctx, app.LoginInput{Email: "me@example.com", Password: pw}, app.LoginClient{Addr: "203.0.113.7"}, firefox)
	if err != nil {
		t.Fatal(err)
	}
	if r := logs.find(t, "signed in"); r == nil || r["level"] != "INFO" || r["account"] != "me@example.com" ||
		r["client"] != "203.0.113.7" || r["browser"] != "Firefox on Linux" {
		t.Errorf("signed in: %v", r)
	}

	if err := a.ChangePassword(ctx, in.Token, app.PasswordChange{NewPassword: newPW}); err != nil {
		t.Fatal(err)
	}
	if r := logs.find(t, "password changed"); r == nil || r["account"] != "me@example.com" {
		t.Errorf("password changed: %v", r)
	}

	tok, err := a.CreateMCPToken(ctx, in.Token, app.MCPTokenInput{Name: "laptop"})
	if err != nil {
		t.Fatal(err)
	}
	if r := logs.find(t, "mcp token created"); r == nil || r["account"] != "me@example.com" || r["name"] != "laptop" {
		t.Errorf("mcp token created: %v", r)
	}
	if err := a.DeleteMCPToken(ctx, in.Token, tok.ID); err != nil {
		t.Fatal(err)
	}
	if r := logs.find(t, "mcp token revoked"); r == nil || r["name"] != "laptop" {
		t.Errorf("mcp token revoked: %v", r)
	}

	if err := a.EndOtherSessions(ctx, in.Token); err != nil {
		t.Fatal(err)
	}
	if r := logs.find(t, "other sessions ended"); r == nil || r["count"] != float64(0) {
		t.Errorf("other sessions ended: %v", r)
	}
	if err := a.Logout(ctx, in.Token); err != nil {
		t.Fatal(err)
	}
	if r := logs.find(t, "signed out"); r == nil || r["account"] != "me@example.com" || r["browser"] != "Firefox on Linux" {
		t.Errorf("signed out: %v", r)
	}

	for i := 0; i < 11; i++ {
		_, err = a.Login(ctx, app.LoginInput{Email: "me@example.com", Password: "wrong-password-3"},
			app.LoginClient{Addr: "198.51.100.4"}, "")
	}
	if code(err) != app.CodeRateLimited {
		t.Fatalf("the 11th failure: %v", err)
	}
	if r := logs.find(t, "sign-in refused: too many failed attempts"); r == nil || r["level"] != "WARN" ||
		r["client"] != "198.51.100.4" {
		t.Errorf("rate-limited: %v", r)
	}

	if err := a.DeleteUser(ctx, "me@example.com"); err != nil {
		t.Fatal(err)
	}
	if r := logs.find(t, "account deleted"); r == nil || r["account"] != "me@example.com" {
		t.Errorf("account deleted: %v", r)
	}

	out := logs.String()
	hash := func(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
	for _, secret := range []string{pw, newPW, "wrong-password-3", in.Token, hash(in.Token), in.Device, tok.Token,
		hash(tok.Token)} {
		if secret != "" && strings.Contains(out, secret) {
			t.Errorf("the log holds a secret: %q", secret)
		}
	}
}
