package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/crypto/bcrypt"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Sign-in for the web UI. Accounts are kept in the store with bcrypt
// password hashes; a signed-in browser holds a random session token whose
// SHA-256 hash is the session's id in the store. While no account exists,
// the UI creates the first one with just an email and a password. Accounts
// share the library and keep their own personal data (see account.go).

// Default and bounds of the auth settings.
const (
	DefaultSessionTTL = 30 * 24 * time.Hour
	// sessionRefresh is how often a session in use has its expiry pushed
	// back, so that a busy session writes at most once per this period.
	sessionRefresh = time.Hour

	MinPasswordChars = 8
	// MaxPasswordBytes is bcrypt's limit: it ignores bytes past 72.
	MaxPasswordBytes = 72
	maxEmailChars    = 254

	// Failed sign-in attempts allowed per client within loginWindow.
	maxLoginFailures = 10
	loginWindow      = 15 * time.Minute

	// DeviceTTL is how long a browser that signed in is recognised as one
	// that did (see LoginClient.Device). Browsers keep a cookie at most
	// 400 days.
	DeviceTTL = 400 * 24 * time.Hour
)

// bcryptCost is the work factor of password hashes (tests lower it).
var bcryptCost = 12

// AuthOptions configure sign-in.
type AuthOptions struct {
	// Enabled requires a signed-in session for the HTTP API. When false
	// the API is open to anyone who can reach it, as before sign-in
	// existed.
	Enabled bool
	// SessionTTL is how long a session lasts without being used
	// (DefaultSessionTTL when zero).
	SessionTTL time.Duration
}

// AuthUser is an account as clients see it.
type AuthUser struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"createdAt"`
}

// AuthStatus is the state of sign-in for a client.
type AuthStatus struct {
	// Enabled is false when sign-in is turned off (CODEATROPHY_AUTH=off).
	Enabled bool `json:"enabled"`
	// SetupRequired is true while no account exists: the sign-in page
	// then creates the first one.
	SetupRequired bool `json:"setupRequired"`
	// User is the signed-in account, or nil.
	User *AuthUser `json:"user"`
}

// SignIn is a new session.
type SignIn struct {
	Token     string
	ExpiresAt time.Time
	User      AuthUser
	// Device marks the browser as one that has signed in to this account,
	// for LoginClient.Device; the client keeps it for DeviceTTL. Empty when
	// the server has no secret key to seal it with.
	Device string
}

// LoginClient is where a sign-in attempt comes from, for limiting failed
// attempts.
type LoginClient struct {
	// Addr is the client's address.
	Addr string
	// Device is the Device of an earlier sign-in from this browser, if it
	// sent one. When it belongs to the account being signed in to, the
	// browser's failed attempts are counted on their own rather than with
	// everyone else's from Addr. Behind a reverse proxy every client has
	// the proxy's address, so without this anyone could keep the owner
	// from signing in by failing ten times.
	Device string
}

// Session is a session that has been checked.
type Session struct {
	User      AuthUser
	ExpiresAt time.Time
	// Extended is true when this check pushed the expiry back, so the
	// client's cookie should be renewed.
	Extended bool
}

// LoginInput is a sign-in attempt.
type LoginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// SetupInput creates the first account.
type SetupInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// PasswordChange changes the signed-in account's password.
type PasswordChange struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// authState is the mutable part of sign-in kept in memory.
type authState struct {
	mu       sync.Mutex
	failures map[string][]time.Time
}

// AuthEnabled reports whether the API requires a signed-in session.
func (a *App) AuthEnabled() bool { return a.authOpts.Enabled }

// SessionTTL is how long an unused session lasts.
func (a *App) SessionTTL() time.Duration { return a.authOpts.SessionTTL }

func errUnauthorized(msg string) error { return &Error{Code: CodeUnauthorized, Message: msg} }

// GetAuthStatus reports whether sign-in is on, whether the first account
// still has to be created, and who holds the session token (if any). An
// unknown or expired token is no error here: it signs nobody in.
func (a *App) GetAuthStatus(ctx context.Context, token string) (AuthStatus, error) {
	if !a.authOpts.Enabled {
		return AuthStatus{}, nil
	}
	st := AuthStatus{Enabled: true}
	var n int
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { n, err = tx.CountUsers(); return }); err != nil {
		return st, err
	}
	if n == 0 {
		st.SetupRequired = true
		return st, nil
	}
	if token != "" {
		if s, err := a.Authenticate(ctx, token); err == nil {
			st.User = &s.User
		} else if AsError(err).Code != CodeUnauthorized {
			return st, err
		}
	}
	return st, nil
}

// checkSetupAtStart logs that sign-in is off, or that the first account
// is still to be created.
func (a *App) checkSetupAtStart(ctx context.Context) error {
	if !a.authOpts.Enabled {
		a.log.Warn("sign-in is turned off (CODEATROPHY_AUTH=off): anyone who can reach this server can use it")
		return nil
	}
	var n int
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { n, err = tx.CountUsers(); return }); err != nil {
		return err
	}
	if n == 0 {
		a.log.Warn("no account exists yet: open the web UI to create the first one")
	}
	return nil
}

// Setup creates the first account and signs it in. It fails once any
// account exists.
func (a *App) Setup(ctx context.Context, in SetupInput) (SignIn, error) {
	if !a.authOpts.Enabled {
		return SignIn{}, errBadRequest("sign-in is turned off on this server")
	}
	email, err := validateCredentials(in.Email, in.Password)
	if err != nil {
		return SignIn{}, err
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		return SignIn{}, err
	}
	now := a.now().UTC()
	u := store.User{ID: newID(), Email: email, PasswordHash: hash, CreatedAt: now, UpdatedAt: now}
	var out SignIn
	err = a.store.Write(ctx, func(tx store.Tx) error {
		n, err := tx.CountUsers()
		if err != nil {
			return err
		}
		if n > 0 {
			return errConflict("an account already exists; sign in instead", nil)
		}
		if err := insertUser(tx, &u); err != nil {
			return err
		}
		out, err = a.newSession(tx, u, now)
		return err
	})
	if err != nil {
		return SignIn{}, err
	}
	out.Device = a.newDevice(u.ID)
	a.log.Info("first account created", "email", email)
	return out, nil
}

// dummyHash is compared against when an email matches no account, so that
// a failed sign-in takes as long whether or not the account exists.
var dummyHash = sync.OnceValue(func() []byte {
	h, _ := bcrypt.GenerateFromPassword([]byte("codeatrophy-no-such-account"), bcryptCost)
	return h
})

// Login checks an email and password and starts a session. client says
// where the attempt comes from, for limiting failed attempts: they are
// counted per address, or per browser for one that has signed in to the
// account before (see LoginClient).
func (a *App) Login(ctx context.Context, in LoginInput, client LoginClient) (SignIn, error) {
	if !a.authOpts.Enabled {
		return SignIn{}, errBadRequest("sign-in is turned off on this server")
	}
	email := normalizeEmail(in.Email)
	deviceUser, device := a.openDevice(client.Device)
	bucket := "addr:" + client.Addr
	if deviceUser == "" {
		// Checked before the lookup, so that a client over the limit
		// costs no database read.
		if err := a.checkLoginRate(bucket); err != nil {
			return SignIn{}, err
		}
	}
	var u store.User
	err := a.store.Read(ctx, func(tx store.Tx) (err error) { u, err = tx.GetUserByEmail(email); return })
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return SignIn{}, err
	}
	if deviceUser != "" {
		if err == nil && u.ID == deviceUser {
			bucket = "device:" + device
		}
		if err := a.checkLoginRate(bucket); err != nil {
			return SignIn{}, err
		}
	}
	hash := []byte(u.PasswordHash)
	if err != nil {
		hash = dummyHash()
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(in.Password)) != nil || u.ID == "" || len(in.Password) > MaxPasswordBytes {
		a.recordLoginFailure(bucket)
		a.log.Info("failed sign-in", "client", client.Addr, "knownBrowser", strings.HasPrefix(bucket, "device:"))
		return SignIn{}, errUnauthorized("the email or password is incorrect")
	}
	a.resetLoginFailures(bucket)
	now := a.now().UTC()
	var out SignIn
	err = a.store.Write(ctx, func(tx store.Tx) error {
		if err := tx.DeleteExpiredSessions(now); err != nil {
			return err
		}
		out, err = a.newSession(tx, u, now)
		return err
	})
	if err != nil {
		return SignIn{}, err
	}
	out.Device = a.newDevice(u.ID)
	return out, nil
}

// deviceContext binds a sealed device to its use.
const deviceContext = "sign-in device"

// newDevice returns a device for a browser that has just signed in to
// account: the account and a random id, sealed with the secret key so
// that only this server can make one.
func (a *App) newDevice(account string) string {
	if a.secrets == nil {
		return ""
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	sealed, err := a.secrets.EncryptBound(account+" "+base64.RawURLEncoding.EncodeToString(b), deviceContext)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte(sealed))
}

// openDevice returns the account and id of a device made by newDevice,
// or empty strings for anything else.
func (a *App) openDevice(device string) (account, id string) {
	if a.secrets == nil || device == "" || len(device) > 512 {
		return "", ""
	}
	sealed, err := base64.RawURLEncoding.DecodeString(device)
	if err != nil {
		return "", ""
	}
	plain, err := a.secrets.DecryptBound(string(sealed), deviceContext)
	if err != nil {
		return "", ""
	}
	account, id, ok := strings.Cut(plain, " ")
	if !ok || account == "" || id == "" {
		return "", ""
	}
	return account, id
}

func (a *App) newSession(tx store.Tx, u store.User, now time.Time) (SignIn, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return SignIn{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	s := store.Session{ID: sessionID(token), UserID: u.ID, CreatedAt: now, ExpiresAt: now.Add(a.authOpts.SessionTTL)}
	if err := tx.InsertSession(&s); err != nil {
		return SignIn{}, err
	}
	return SignIn{Token: token, ExpiresAt: s.ExpiresAt, User: authUser(u)}, nil
}

func sessionID(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func authUser(u store.User) AuthUser {
	return AuthUser{ID: u.ID, Email: u.Email, CreatedAt: u.CreatedAt}
}

// Authenticate returns the account a session token belongs to. A session
// in use has its expiry pushed back (at most once per sessionRefresh).
func (a *App) Authenticate(ctx context.Context, token string) (Session, error) {
	if token == "" || len(token) > 256 {
		return Session{}, errUnauthorized("sign in to continue")
	}
	id := sessionID(token)
	now := a.now().UTC()
	var (
		s store.Session
		u store.User
	)
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		if s, err = tx.GetSession(id); err != nil {
			return err
		}
		u, err = tx.GetUser(s.UserID)
		return err
	})
	if errors.Is(err, store.ErrNotFound) || (err == nil && !now.Before(s.ExpiresAt)) {
		return Session{}, errUnauthorized("your session has ended; sign in again")
	}
	if err != nil {
		return Session{}, err
	}
	out := Session{User: authUser(u), ExpiresAt: s.ExpiresAt}
	ttl := a.authOpts.SessionTTL
	if s.ExpiresAt.Before(now.Add(ttl - sessionRefresh)) {
		exp := now.Add(ttl)
		if err := a.store.Write(ctx, func(tx store.Tx) error { return tx.ExtendSession(id, exp) }); err != nil {
			return Session{}, err
		}
		out.ExpiresAt, out.Extended = exp, true
	}
	return out, nil
}

// Logout ends the session of a token. An unknown token is no error.
func (a *App) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	return a.store.Write(ctx, func(tx store.Tx) error { return tx.DeleteSession(sessionID(token)) })
}

// ChangePassword changes the password of the account signed in with token,
// after checking its current password, and ends its other sessions. Wrong
// current passwords are limited per account, as for sign-in, but apart
// from it: only someone signed in to the account can make them.
func (a *App) ChangePassword(ctx context.Context, token string, in PasswordChange) error {
	s, err := a.Authenticate(ctx, token)
	if err != nil {
		return err
	}
	bucket := "account:" + s.User.ID
	if err := a.checkLoginRate(bucket); err != nil {
		return err
	}
	var u store.User
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { u, err = tx.GetUser(s.User.ID); return }); err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(in.CurrentPassword)) != nil {
		a.recordLoginFailure(bucket)
		return errField("currentPassword", "is incorrect")
	}
	if err := validatePassword("newPassword", in.NewPassword); err != nil {
		return err
	}
	hash, err := hashPassword(in.NewPassword)
	if err != nil {
		return err
	}
	return a.store.Write(ctx, func(tx store.Tx) error {
		if err := tx.UpdateUserPassword(u.ID, hash, a.now().UTC()); err != nil {
			return err
		}
		return tx.DeleteUserSessions(u.ID, sessionID(token))
	})
}

// Account management for the command line.

// ListUsers returns every account, by email.
func (a *App) ListUsers(ctx context.Context) ([]AuthUser, error) {
	var us []store.User
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { us, err = tx.ListUsers(); return }); err != nil {
		return nil, err
	}
	out := make([]AuthUser, len(us))
	for i, u := range us {
		out[i] = authUser(u)
	}
	return out, nil
}

// CreateUser adds an account.
func (a *App) CreateUser(ctx context.Context, email, password string) (AuthUser, error) {
	email, err := validateCredentials(email, password)
	if err != nil {
		return AuthUser{}, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return AuthUser{}, err
	}
	now := a.now().UTC()
	u := store.User{ID: newID(), Email: email, PasswordHash: hash, CreatedAt: now, UpdatedAt: now}
	err = a.store.Write(ctx, func(tx store.Tx) error {
		if _, err := tx.GetUserByEmail(email); err == nil {
			return errConflict("an account with this email already exists", nil)
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		return insertUser(tx, &u)
	})
	return authUser(u), err
}

// insertUser adds an account. The first one takes over the personal data
// kept while no account existed (see store.Unowned).
func insertUser(tx store.Tx, u *store.User) error {
	n, err := tx.CountUsers()
	if err != nil {
		return err
	}
	if err := tx.InsertUser(u); err != nil {
		return err
	}
	if n == 0 {
		return tx.ClaimUnowned(u.ID)
	}
	return nil
}

// SetUserPassword replaces an account's password and ends its sessions.
func (a *App) SetUserPassword(ctx context.Context, email, password string) error {
	if err := validatePassword("password", password); err != nil {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	return a.store.Write(ctx, func(tx store.Tx) error {
		u, err := tx.GetUserByEmail(normalizeEmail(email))
		if err != nil {
			return notFoundAs(err, "account")
		}
		if err := tx.UpdateUserPassword(u.ID, hash, a.now().UTC()); err != nil {
			return err
		}
		return tx.DeleteUserSessions(u.ID, "")
	})
}

// DeleteUser removes an account and its sessions.
func (a *App) DeleteUser(ctx context.Context, email string) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		u, err := tx.GetUserByEmail(normalizeEmail(email))
		if err != nil {
			return notFoundAs(err, "account")
		}
		_, err = tx.DeleteUser(u.ID)
		return err
	})
}

// Validation and hashing.

func normalizeEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func validateCredentials(email, password string) (string, error) {
	email = normalizeEmail(email)
	fe := domain.FieldErrors{}
	at := strings.LastIndex(email, "@")
	switch {
	case email == "":
		fe["email"] = "is required"
	case len([]rune(email)) > maxEmailChars:
		fe["email"] = fmt.Sprintf("must be at most %d characters", maxEmailChars)
	case at < 1 || at == len(email)-1 || strings.IndexFunc(email, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0:
		fe["email"] = "must be an email address"
	}
	if err := validatePassword("password", password); err != nil {
		for k, v := range AsError(err).Fields {
			fe[k] = fmt.Sprint(v)
		}
	}
	return email, errValidation(fe)
}

func validatePassword(field, pw string) error {
	switch {
	case len([]rune(pw)) < MinPasswordChars:
		return errField(field, fmt.Sprintf("must be at least %d characters", MinPasswordChars))
	case len(pw) > MaxPasswordBytes:
		return errField(field, fmt.Sprintf("must be at most %d bytes", MaxPasswordBytes))
	}
	return nil
}

func hashPassword(pw string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(pw), bcryptCost)
	return string(h), err
}

// Rate limiting of failed attempts, in memory, per bucket: "addr:" and
// a client address, "device:" and a device id, or "account:" and an
// account id.

func (a *App) checkLoginRate(client string) error {
	a.authState.mu.Lock()
	defer a.authState.mu.Unlock()
	now := a.now()
	fs := pruneFailures(a.authState.failures[client], now)
	if len(fs) < maxLoginFailures {
		return nil
	}
	wait := fs[0].Add(loginWindow).Sub(now)
	mins := int((wait + time.Minute - 1) / time.Minute)
	return &Error{Code: CodeRateLimited, RetryAfter: wait,
		Message: fmt.Sprintf("too many failed attempts; try again in %d minute%s", mins, plural(mins))}
}

func (a *App) recordLoginFailure(client string) {
	a.authState.mu.Lock()
	defer a.authState.mu.Unlock()
	now := a.now()
	if a.authState.failures == nil {
		a.authState.failures = map[string][]time.Time{}
	}
	if len(a.authState.failures) > 10000 {
		for k, fs := range a.authState.failures {
			if len(pruneFailures(fs, now)) == 0 {
				delete(a.authState.failures, k)
			}
		}
	}
	a.authState.failures[client] = append(pruneFailures(a.authState.failures[client], now), now)
}

func (a *App) resetLoginFailures(client string) {
	a.authState.mu.Lock()
	defer a.authState.mu.Unlock()
	delete(a.authState.failures, client)
}

func pruneFailures(fs []time.Time, now time.Time) []time.Time {
	i := 0
	for i < len(fs) && !fs[i].After(now.Add(-loginWindow)) {
		i++
	}
	return fs[i:]
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
