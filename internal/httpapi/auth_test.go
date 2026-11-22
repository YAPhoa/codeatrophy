package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/httpapi"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store/teststore"
)

type authClient struct {
	t   *testing.T
	app *app.App
	srv *httptest.Server
	hc  *http.Client
}

// newAuthServer starts a server with sign-in on and one account,
// me@example.com with the password "correct horse".
func newAuthServer(t *testing.T, configure ...func(*httpapi.Options)) *authClient {
	t.Helper()
	ctx := context.Background()
	box, err := secrets.NewBox(bytes.Repeat([]byte{5}, 32))
	if err != nil {
		t.Fatal(err)
	}
	a := app.New(app.Options{Store: teststore.Open(t), Secrets: box, Auth: app.AuthOptions{Enabled: true}, HealthInterval: time.Hour})
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := a.CreateUser(ctx, "me@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	mcp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("mcp")) })
	opts := httpapi.Options{App: a, MCP: mcp, MCPPath: "/mcp", AllowedOrigins: []string{"https://allowed.example"}}
	for _, f := range configure {
		f(&opts)
	}
	srv := httptest.NewServer(httpapi.New(opts))
	t.Cleanup(func() {
		srv.Close()
		a.Stop()
	})
	jar, _ := cookiejar.New(nil)
	return &authClient{t: t, app: a, srv: srv, hc: &http.Client{Jar: jar}}
}

// fresh returns a client of the same server with an empty cookie jar: a
// browser that has never signed in.
func (c *authClient) fresh() *authClient {
	jar, _ := cookiejar.New(nil)
	return &authClient{t: c.t, app: c.app, srv: c.srv, hc: &http.Client{Jar: jar}}
}

// as returns a client of the same server with a cookie jar of its own,
// signed in as a new account with that email.
func (c *authClient) as(email string) *authClient {
	c.t.Helper()
	if _, err := c.app.CreateUser(context.Background(), email, "correct horse"); err != nil {
		c.t.Fatal(err)
	}
	jar, _ := cookiejar.New(nil)
	other := &authClient{t: c.t, app: c.app, srv: c.srv, hc: &http.Client{Jar: jar}}
	other.expect("POST", api+"/auth/login", `{"email":"`+email+`","password":"correct horse"}`, 200)
	return other
}

func (c *authClient) do(method, path, body string, header ...string) (*http.Response, string) {
	c.t.Helper()
	req, err := http.NewRequest(method, c.srv.URL+path, strings.NewReader(body))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	res, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func (c *authClient) expect(method, path, body string, status int, header ...string) (*http.Response, string) {
	c.t.Helper()
	res, b := c.do(method, path, body, header...)
	if res.StatusCode != status {
		c.t.Fatalf("%s %s: %d, want %d: %s", method, path, res.StatusCode, status, b)
	}
	return res, b
}

func (c *authClient) login() *http.Response {
	c.t.Helper()
	res, _ := c.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"correct horse"}`, 200)
	return res
}

func TestAuthRequiredForTheAPI(t *testing.T) {
	c := newAuthServer(t)
	// Signed out: the API answers 401, except what the sign-in page and the
	// health check need. The UI's files are public.
	_, body := c.expect("GET", api+"/items", "", 401)
	if !strings.Contains(body, `"code":"unauthorized"`) {
		t.Errorf("401 body: %s", body)
	}
	c.expect("GET", api+"/meta", "", 401)
	c.expect("GET", api+"/no-such-endpoint", "", 401)
	c.expect("GET", api+"/health", "", 200)
	_, body = c.expect("GET", api+"/auth/session", "", 200)
	if !strings.Contains(body, `"enabled":true`) || !strings.Contains(body, `"user":null`) || !strings.Contains(body, `"setupRequired":false`) {
		t.Errorf("session signed out: %s", body)
	}
	c.expect("GET", "/", "", 404) // no UI in this server, but not a 401
	// The MCP endpoint has its own token.
	c.expect("GET", "/mcp", "", 200)

	// A cookie the server did not issue gets nowhere.
	u, _ := url.Parse(c.srv.URL)
	c.hc.Jar.SetCookies(u, []*http.Cookie{{Name: httpapi.SessionCookie, Value: "forged"}})
	c.expect("GET", api+"/items", "", 401)

	// Signed in.
	res := c.login()
	var cookie *http.Cookie
	for _, ck := range res.Cookies() {
		if ck.Name == httpapi.SessionCookie {
			cookie = ck
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.MaxAge <= 0 {
		t.Fatalf("session cookie: %+v", cookie)
	}
	if cookie.Secure {
		t.Error("the cookie is Secure on plain HTTP")
	}
	c.expect("GET", api+"/items", "", 200)
	_, body = c.expect("GET", api+"/auth/session", "", 200)
	if !strings.Contains(body, `"email":"me@example.com"`) {
		t.Errorf("session signed in: %s", body)
	}

	// Sign out ends the session and clears the cookie.
	c.expect("POST", api+"/auth/logout", "", 204)
	c.expect("GET", api+"/items", "", 401)
	if cs := c.hc.Jar.Cookies(u); len(cs) != 0 {
		t.Errorf("cookies after logout: %v", cs)
	}
}

func TestAuthCookieSecureBehindHTTPSProxy(t *testing.T) {
	c := newAuthServer(t)
	res, _ := c.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"correct horse"}`, 200,
		"X-Forwarded-Proto", "https")
	for _, ck := range res.Cookies() {
		if ck.Name == httpapi.SessionCookie && !ck.Secure {
			t.Error("the cookie is not Secure behind an HTTPS proxy")
		}
	}
}

func TestAuthWrongPasswordAndRateLimit(t *testing.T) {
	c := newAuthServer(t)
	bad := `{"email":"me@example.com","password":"wrong password"}`
	_, body := c.expect("POST", api+"/auth/login", bad, 401)
	if !strings.Contains(body, "incorrect") {
		t.Errorf("wrong password: %s", body)
	}
	for range 9 {
		c.expect("POST", api+"/auth/login", bad, 401)
	}
	res, _ := c.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"correct horse"}`, 429)
	if res.Header.Get("Retry-After") == "" {
		t.Error("no Retry-After on 429")
	}
}

// Behind a reverse proxy every client has the proxy's address. A browser
// that has signed in before is not kept out by others' failures there.
func TestAuthRateLimitBehindProxyKeepsKnownBrowsersIn(t *testing.T) {
	owner := newAuthServer(t)
	res := owner.login()
	var device *http.Cookie
	for _, ck := range res.Cookies() {
		if ck.Name == httpapi.DeviceCookie {
			device = ck
		}
	}
	if device == nil || !device.HttpOnly || device.Path != api+"/auth" || device.SameSite != http.SameSiteStrictMode ||
		device.MaxAge < 300*24*3600 {
		t.Fatalf("device cookie: %+v", device)
	}
	attacker := owner.fresh()
	bad := `{"email":"me@example.com","password":"wrong password"}`
	good := `{"email":"me@example.com","password":"correct horse"}`
	for range 10 {
		attacker.expect("POST", api+"/auth/login", bad, 401)
	}
	owner.fresh().expect("POST", api+"/auth/login", good, 429)
	owner.expect("POST", api+"/auth/login", good, 200)
	// Signing out keeps the browser known.
	owner.expect("POST", api+"/auth/logout", "", 204)
	owner.expect("POST", api+"/auth/login", good, 200)
}

// With the proxy trusted, each client is limited by its own address from
// X-Forwarded-For, read from the right so that a client cannot pick it.
func TestAuthRateLimitPerClientBehindTrustedProxy(t *testing.T) {
	c := newAuthServer(t, func(o *httpapi.Options) {
		o.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8")}
	})
	bad := `{"email":"me@example.com","password":"wrong password"}`
	good := `{"email":"me@example.com","password":"correct horse"}`
	for i := range 10 {
		// The left entry is the attacker's own; the right one is added by
		// the proxies, the nearest last.
		c.expect("POST", api+"/auth/login", bad, 401,
			"X-Forwarded-For", fmt.Sprintf("192.0.2.%d, 203.0.113.9, 10.1.2.3", i))
	}
	c.expect("POST", api+"/auth/login", good, 429, "X-Forwarded-For", "203.0.113.9")
	c.expect("POST", api+"/auth/login", good, 200, "X-Forwarded-For", "198.51.100.7")
	// Without the header the proxy's own address is the client.
	c.fresh().expect("POST", api+"/auth/login", good, 200)
}

// An address that is not a trusted proxy cannot name another client.
func TestAuthForwardedForIgnoredFromUntrustedPeers(t *testing.T) {
	c := newAuthServer(t)
	bad := `{"email":"me@example.com","password":"wrong password"}`
	for i := range 10 {
		c.expect("POST", api+"/auth/login", bad, 401, "X-Forwarded-For", fmt.Sprintf("192.0.2.%d", i))
	}
	c.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"correct horse"}`, 429,
		"X-Forwarded-For", "198.51.100.7")
}

func TestAuthCrossSiteRequestsAreRefused(t *testing.T) {
	c := newAuthServer(t)
	// Sign-in itself is protected against login CSRF.
	c.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"correct horse"}`, 403,
		"Sec-Fetch-Site", "cross-site")
	c.login()
	// A page on another port of the same host is same-site, not
	// same-origin: its requests carry the cookie but are refused.
	c.expect("POST", api+"/collections", `{"name":"X"}`, 403, "Sec-Fetch-Site", "same-site", "Origin", "http://127.0.0.1:1")
	c.expect("POST", api+"/collections", `{"name":"X"}`, 403, "Origin", "http://localhost.evil.example")
	// The UI itself, a configured origin, and clients that are not browsers
	// are served.
	c.expect("POST", api+"/collections", `{"name":"A"}`, 201, "Sec-Fetch-Site", "same-origin")
	c.expect("POST", api+"/collections", `{"name":"B"}`, 201, "Sec-Fetch-Site", "cross-site", "Origin", "https://allowed.example")
	c.expect("POST", api+"/collections", `{"name":"C"}`, 201)
	// Reads are not checked.
	c.expect("GET", api+"/collections", "", 200, "Sec-Fetch-Site", "cross-site")
}

func TestAuthChangePassword(t *testing.T) {
	c := newAuthServer(t)
	c.expect("POST", api+"/auth/password", `{"newPassword":"battery staple"}`, 401)
	c.login()
	_, body := c.expect("POST", api+"/auth/password", `{"newPassword":"short"}`, 422)
	if !strings.Contains(body, "newPassword") {
		t.Errorf("short new password: %s", body)
	}
	// No current password is needed; one sent by an older client is ignored.
	c.expect("POST", api+"/auth/password", `{"currentPassword":"not it","newPassword":"battery staple"}`, 204)
	c.expect("GET", api+"/items", "", 200)
	c.expect("POST", api+"/auth/logout", "", 204)
	c.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"battery staple"}`, 200)
}

func TestAuthOffLeavesTheAPIOpen(t *testing.T) {
	c := newServer(t)
	c.expect("GET", api+"/items", "", 200)
	if m := c.expect("GET", api+"/auth/session", "", 200).json(t); m["enabled"] != false || m["user"] != nil {
		t.Errorf("session with sign-in off: %v", m)
	}
	c.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"correct horse"}`, 400)
	c.expect("GET", api+"/health", "", 200)
}

func TestAuthMCPTokens(t *testing.T) {
	c := newAuthServer(t)
	c.expect("GET", api+"/auth/mcp-tokens", "", 401)
	c.login()
	_, body := c.expect("POST", api+"/auth/mcp-tokens", `{"name":"Laptop"}`, 201)
	if !strings.Contains(body, `"token":"cat_`) || !strings.Contains(body, `"name":"Laptop"`) {
		t.Fatalf("created: %s", body)
	}
	_, list := c.expect("GET", api+"/auth/mcp-tokens", "", 200)
	if strings.Contains(list, `"token"`) || !strings.Contains(list, `"hint"`) {
		t.Errorf("the list shows the token: %s", list)
	}
	id := list[strings.Index(list, `"id":"`)+6:]
	id = id[:strings.Index(id, `"`)]
	c.expect("DELETE", api+"/auth/mcp-tokens/"+id, "", 204)
	c.expect("DELETE", api+"/auth/mcp-tokens/"+id, "", 404)
}

func TestAuthSessions(t *testing.T) {
	c := newAuthServer(t)
	c.expect("GET", api+"/auth/sessions", "", 401)
	c.expect("POST", api+"/auth/sessions/end-others", "", 401)
	c.expect("DELETE", api+"/auth/sessions/x", "", 401)
	firefox := "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
	c.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"correct horse"}`, 200, "User-Agent", firefox)
	jar, _ := cookiejar.New(nil)
	other := &authClient{t: t, app: c.app, srv: c.srv, hc: &http.Client{Jar: jar}}
	other.expect("POST", api+"/auth/login", `{"email":"me@example.com","password":"correct horse"}`, 200, "User-Agent", "")
	you := c.as("you@example.com")

	type sessions struct {
		Items []struct {
			ID, Browser           string
			CreatedAt, LastUsedAt time.Time
			Current               bool
		}
	}
	list := func(c *authClient) sessions {
		t.Helper()
		var out sessions
		_, body := c.expect("GET", api+"/auth/sessions", "", 200)
		if err := json.Unmarshal([]byte(body), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	l := list(c)
	if len(l.Items) != 2 || !l.Items[0].Current || l.Items[0].Browser != "Firefox on Linux" ||
		l.Items[1].Current || l.Items[1].Browser != "Unknown browser" || l.Items[1].CreatedAt.IsZero() || l.Items[1].LastUsedAt.IsZero() {
		t.Fatalf("sessions: %+v", l)
	}
	_, raw := c.expect("GET", api+"/auth/sessions", "", 200)
	if strings.Contains(raw, "Mozilla") || strings.Contains(raw, "userAgent") {
		t.Errorf("the list shows the User-Agent: %s", raw)
	}
	// Another account's session is not found; neither is an unknown one.
	you.expect("DELETE", api+"/auth/sessions/"+l.Items[1].ID, "", 404)
	c.expect("DELETE", api+"/auth/sessions/nope", "", 404)
	// Ending another session of the account.
	c.expect("DELETE", api+"/auth/sessions/"+l.Items[1].ID, "", 204)
	other.expect("GET", api+"/items", "", 401)
	c.expect("GET", api+"/items", "", 200)

	// Ending the others keeps this one and other accounts'.
	other.login()
	c.expect("POST", api+"/auth/sessions/end-others", "", 204)
	other.expect("GET", api+"/items", "", 401)
	you.expect("GET", api+"/items", "", 200)
	if l := list(c); len(l.Items) != 1 || !l.Items[0].Current {
		t.Errorf("after end-others: %+v", l)
	}

	// Ending its own session signs out and clears the cookie.
	res, _ := c.expect("DELETE", api+"/auth/sessions/"+l.Items[0].ID, "", 204)
	cleared := false
	for _, ck := range res.Cookies() {
		if ck.Name == httpapi.SessionCookie && ck.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("ending the current session left the cookie")
	}
	c.expect("GET", api+"/items", "", 401)

	// Cross-site requests are refused, as for the other endpoints.
	c.login()
	c.expect("POST", api+"/auth/sessions/end-others", "", 403, "Sec-Fetch-Site", "cross-site")
}

// With sign-in off there is no session to list or end: the endpoints answer
// 401, as the other session endpoints do.
func TestAuthOffSessions(t *testing.T) {
	c := newServer(t)
	c.expect("GET", api+"/auth/sessions", "", 401)
	c.expect("POST", api+"/auth/sessions/end-others", "", 401)
	c.expect("DELETE", api+"/auth/sessions/x", "", 401)
	c.expect("GET", api+"/auth/mcp-tokens", "", 401)
}

// Each account has its own status, favorite, notes, working copies,
// submissions, drafts and preferences on the shared library.
func TestPersonalDataPerAccount(t *testing.T) {
	me := newAuthServer(t)
	me.login()
	you := me.as("you@example.com")
	_, body := me.expect("POST", api+"/items", `{"type":"problem","title":"Two Sum"}`, 201)
	id := body[strings.Index(body, `"id":"`)+6:]
	id = id[:strings.Index(id, `"`)]

	me.expect("PATCH", api+"/items/"+id, `{"status":"done","favorite":true,"notes":"mine","title":"Two Sum II"}`, 200)
	_, body = you.expect("GET", api+"/items/"+id, "", 200)
	for _, want := range []string{`"title":"Two Sum II"`, `"status":"todo"`, `"favorite":false`, `"notes":""`} {
		if !strings.Contains(body, want) {
			t.Errorf("the other account's item lacks %s: %s", want, body)
		}
	}
	_, body = me.expect("GET", api+"/items/"+id, "", 200)
	if !strings.Contains(body, `"status":"done"`) || !strings.Contains(body, `"notes":"mine"`) {
		t.Errorf("own item: %s", body)
	}
	if _, body = you.expect("GET", api+"/items?favorite=true", "", 200); !strings.Contains(body, `"total":0`) {
		t.Errorf("the other account's favorites: %s", body)
	}

	me.expect("PUT", api+"/items/"+id+"/workspace/python", `{"source":"print(1)"}`, 200)
	if _, body = you.expect("GET", api+"/items/"+id+"/workspace", "", 200); strings.Contains(body, "print(1)") {
		t.Errorf("the other account sees my working copy: %s", body)
	}

	me.expect("PUT", api+"/settings/preferences", `{"editor":{"tabSize":2}}`, 200)
	if _, body = you.expect("GET", api+"/settings/preferences", "", 200); !strings.Contains(body, `"tabSize":4`) {
		t.Errorf("the other account's preferences: %s", body)
	}

	_, body = me.expect("POST", api+"/drafts", `{"kind":"capture","title":"Mine"}`, 201)
	draft := body[strings.Index(body, `"id":"`)+6:]
	draft = draft[:strings.Index(draft, `"`)]
	if _, body = you.expect("GET", api+"/drafts", "", 200); strings.Contains(body, draft) {
		t.Errorf("the other account lists my draft: %s", body)
	}
	you.expect("GET", api+"/drafts/"+draft, "", 404)
	you.expect("DELETE", api+"/drafts/"+draft, "", 404)
	me.expect("GET", api+"/drafts/"+draft, "", 200)

	_, body = me.expect("POST", api+"/collections", `{"name":"Mine"}`, 201)
	coll := body[strings.Index(body, `"id":"`)+6:]
	coll = coll[:strings.Index(coll, `"`)]
	me.expect("PATCH", api+"/items/"+id, `{"collectionIds":["`+coll+`"]}`, 200)
	if _, body = you.expect("GET", api+"/collections", "", 200); strings.Contains(body, coll) {
		t.Errorf("the other account lists my collection: %s", body)
	}
	you.expect("GET", api+"/collections/"+coll, "", 404)
	you.expect("PATCH", api+"/items/"+id, `{"collectionIds":["`+coll+`"]}`, 422)
	if _, body = you.expect("GET", api+"/items/"+id, "", 200); strings.Contains(body, coll) {
		t.Errorf("the other account sees my item's collection: %s", body)
	}
}

// With sign-in off, requests act for the oldest account; while there is
// none, what is kept goes to the first account created.
func TestSignInOffActsForTheOldestAccount(t *testing.T) {
	c := newServer(t)
	id := c.expect("POST", api+"/items", `{"type":"reading","title":"R"}`, 201).json(t)["id"].(string)
	c.expect("PATCH", api+"/items/"+id, `{"status":"in_progress"}`, 200)
	if _, err := c.app.CreateUser(context.Background(), "first@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.app.CreateUser(context.Background(), "second@example.com", "correct horse"); err != nil {
		t.Fatal(err)
	}
	if got := c.expect("GET", api+"/items/"+id, "", 200).json(t)["status"]; got != "in_progress" {
		t.Errorf("status after the first account took it over: %v", got)
	}
}
