package httpapi

import (
	"net"
	"net/http"
	"strings"
	"time"

	"codeatrophy/internal/app"
)

// SessionCookie is the cookie that holds a signed-in browser's session
// token.
const SessionCookie = "codeatrophy_session"

// publicPaths are the API paths reachable without a session when sign-in
// is on: what the sign-in page needs, and the health check.
var publicPaths = map[string]bool{
	Prefix + "/health":       true,
	Prefix + "/auth/session": true,
	Prefix + "/auth/login":   true,
	Prefix + "/auth/setup":   true,
	Prefix + "/auth/logout":  true,
}

func sessionToken(r *http.Request) string {
	if c, err := r.Cookie(SessionCookie); err == nil {
		return c.Value
	}
	return ""
}

// clientKey identifies where a request comes from, for rate limiting
// failed sign-ins: the peer's address. Behind a reverse proxy every client
// shares the proxy's address, so the limit applies to them together.
func clientKey(r *http.Request) string {
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}

// secureRequest reports whether the browser reached the server over HTTPS,
// directly or through a reverse proxy that says so.
func secureRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   max(1, int(time.Until(expires).Seconds())),
		HttpOnly: true,
		Secure:   secureRequest(r),
		SameSite: http.SameSiteStrictMode,
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: secureRequest(r), SameSite: http.SameSiteStrictMode,
	})
}

// authorize enforces sign-in on an API request when it is on, and returns
// the request acting for its account: the signed-in one, or with sign-in
// off the default account. It reports false when it has answered the
// request itself.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	if !s.app.AuthEnabled() {
		account, err := s.app.DefaultAccount(r.Context())
		if err != nil {
			s.writeError(w, r, err)
			return r, false
		}
		return r.WithContext(app.WithAccount(r.Context(), account)), true
	}
	// A session cookie is sent by the browser on its own, so state-changing
	// requests must also come from a page of this server (CSRF).
	if err := s.csrf.Check(r); err != nil {
		writeJSON(w, http.StatusForbidden, errorBody{Error: errorDetail{Code: app.CodeForbidden,
			Message: "cross-origin requests are not allowed; set CODEATROPHY_ALLOWED_ORIGINS to allow this origin"}})
		return r, false
	}
	if publicPaths[r.URL.Path] {
		return r, true
	}
	sess, err := s.app.Authenticate(r.Context(), sessionToken(r))
	if err != nil {
		if app.AsError(err).Code == app.CodeUnauthorized {
			clearSessionCookie(w, r)
		}
		s.writeError(w, r, err)
		return r, false
	}
	if sess.Extended {
		setSessionCookie(w, r, sessionToken(r), sess.ExpiresAt)
	}
	return r.WithContext(app.WithAccount(r.Context(), sess.User.ID)), true
}

func (s *Server) getHealth(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	return nil
}

func (s *Server) getAuthSession(w http.ResponseWriter, r *http.Request) error {
	st, err := s.app.GetAuthStatus(r.Context(), sessionToken(r))
	if err != nil {
		return err
	}
	if st.Enabled && st.User == nil && sessionToken(r) != "" {
		clearSessionCookie(w, r)
	}
	writeJSON(w, http.StatusOK, st)
	return nil
}

func (s *Server) signedIn(w http.ResponseWriter, r *http.Request, in app.SignIn) {
	setSessionCookie(w, r, in.Token, in.ExpiresAt)
	u := in.User
	writeJSON(w, http.StatusOK, app.AuthStatus{Enabled: true, User: &u})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	var in app.LoginInput
	if err := decode(r, &in); err != nil {
		return err
	}
	out, err := s.app.Login(r.Context(), in, clientKey(r))
	if err != nil {
		return err
	}
	s.signedIn(w, r, out)
	return nil
}

func (s *Server) setup(w http.ResponseWriter, r *http.Request) error {
	var in app.SetupInput
	if err := decode(r, &in); err != nil {
		return err
	}
	out, err := s.app.Setup(r.Context(), in)
	if err != nil {
		return err
	}
	s.signedIn(w, r, out)
	return nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.Logout(r.Context(), sessionToken(r)); err != nil {
		return err
	}
	clearSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) error {
	var in app.PasswordChange
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := s.app.ChangePassword(r.Context(), sessionToken(r), in, clientKey(r)); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listMCPTokens(w http.ResponseWriter, r *http.Request) error {
	ts, err := s.app.ListMCPTokens(r.Context(), sessionToken(r))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": ts})
	return nil
}

func (s *Server) createMCPToken(w http.ResponseWriter, r *http.Request) error {
	var in app.MCPTokenInput
	if err := decode(r, &in); err != nil {
		return err
	}
	t, err := s.app.CreateMCPToken(r.Context(), sessionToken(r), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, t)
	return nil
}

func (s *Server) deleteMCPToken(w http.ResponseWriter, r *http.Request) error {
	if err := s.app.DeleteMCPToken(r.Context(), sessionToken(r), r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
