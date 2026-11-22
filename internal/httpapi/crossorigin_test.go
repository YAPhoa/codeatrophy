package httpapi_test

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// sender sends requests to a test server as one browser or client would.
type sender struct {
	t    *testing.T
	base string
	hc   *http.Client
}

// send sends a request with exactly the given headers: no Content-Type
// unless one is given.
func (s sender) send(method, path string, body io.Reader, header ...string) (int, string) {
	s.t.Helper()
	req, err := http.NewRequest(method, s.base+path, body)
	if err != nil {
		s.t.Fatal(err)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	res, err := s.hc.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// senders are a server with sign-in off and one with sign-in on (signed
// in); both trust https://allowed.example.
func senders(t *testing.T) map[string]sender {
	off := newServer(t)
	on := newAuthServer(t)
	on.login()
	return map[string]sender{
		"sign-in off": {t, off.srv.URL, http.DefaultClient},
		"sign-in on":  {t, on.srv.URL, on.hc},
	}
}

// A page on another port of this machine (a notebook, a dev server) is a
// loopback origin, but not the UI: its writes are refused whether sign-in
// is on or off.
func TestCrossOriginWritesWithSignInOnAndOff(t *testing.T) {
	const evil = "http://localhost:8888"
	for name, s := range senders(t) {
		t.Run(name, func(t *testing.T) {
			s.t = t
			n := 0
			post := func(header ...string) (int, string) {
				n++
				return s.send("POST", api+"/collections", strings.NewReader(fmt.Sprintf(`{"name":"C%d"}`, n)), header...)
			}
			for _, h := range [][]string{
				{"Content-Type", "text/plain", "Origin", evil, "Sec-Fetch-Site", "cross-site"},
				{"Content-Type", "application/json", "Origin", evil, "Sec-Fetch-Site", "same-site"},
				// A browser without Sec-Fetch-Site: the Origin is not the Host.
				{"Content-Type", "text/plain", "Origin", evil},
				{"Content-Type", "application/json", "Origin", evil},
			} {
				if status, body := post(h...); status != 403 || !strings.Contains(body, `"forbidden"`) {
					t.Errorf("%v: %d %s", h, status, body)
				}
			}
			for _, h := range [][]string{
				{"Content-Type", "application/json", "Origin", "http://localhost:5173", "Sec-Fetch-Site", "same-origin"},
				{"Content-Type", "application/json"},
				{"Content-Type", "application/json", "Origin", "https://allowed.example", "Sec-Fetch-Site", "cross-site"},
				{"Content-Type", "application/json", "Origin", "https://allowed.example"},
			} {
				if status, body := post(h...); status != 201 {
					t.Errorf("%v: %d %s", h, status, body)
				}
			}
			// A multipart form is a request a page may send anywhere: the
			// import is refused too.
			ct, form := multipartBody(t, []byte("PK"), "")
			if status, _ := s.send("POST", api+"/import", form, "Content-Type", ct, "Origin", evil, "Sec-Fetch-Site", "cross-site"); status != 403 {
				t.Errorf("cross-site import: %d", status)
			}
		})
	}
}

// A JSON body must be sent as application/json; bodiless requests and
// uploads need no such header.
func TestRequestBodyContentType(t *testing.T) {
	for name, s := range senders(t) {
		t.Run(name, func(t *testing.T) {
			s.t = t
			for _, ct := range []string{"", "text/plain", "text/plain; charset=utf-8", "application/x-www-form-urlencoded", "application/jsonx", "multipart/form-data; boundary=x"} {
				h := []string{}
				if ct != "" {
					h = []string{"Content-Type", ct}
				}
				status, body := s.send("POST", api+"/collections", strings.NewReader(`{"name":"X"}`), h...)
				if status != 415 || !strings.Contains(body, `"bad_request"`) || !strings.Contains(body, "application/json") {
					t.Errorf("Content-Type %q: %d %s", ct, status, body)
				}
			}
			status, body := s.send("POST", api+"/collections", strings.NewReader(`{"name":"A"}`), "Content-Type", "application/json; charset=utf-8")
			if status != 201 {
				t.Fatalf("charset parameter: %d %s", status, body)
			}
			id := body[strings.Index(body, `"id":"`)+6:]
			id = id[:strings.Index(id, `"`)]
			// An empty body is {}: validated, not refused.
			if status, body := s.send("POST", api+"/collections/"+id+"/items", nil); status != 422 {
				t.Errorf("bodiless POST of a JSON endpoint: %d %s", status, body)
			}
			if status, body := s.send("PUT", api+"/settings/preferences", nil); status != 200 {
				t.Errorf("bodiless PUT: %d %s", status, body)
			}
			if status, body := s.send("DELETE", api+"/collections/"+id, nil); status != 204 {
				t.Errorf("bodiless DELETE: %d %s", status, body)
			}
			// Bodies kept as sent (AI jobs) are checked the same way.
			if status, _ := s.send("POST", api+"/ai/code", strings.NewReader(`{}`), "Content-Type", "text/plain"); status != 415 {
				t.Errorf("AI job body as text/plain: %d", status)
			}
			status, bundle := s.send("POST", api+"/export", strings.NewReader(`{"scope":"all"}`), "Content-Type", "application/json")
			if status != 200 {
				t.Fatalf("export: %d %s", status, bundle)
			}
			ct, form := multipartBody(t, []byte(bundle), "overwrite")
			if status, body := s.send("POST", api+"/import", form, "Content-Type", ct); status != 200 {
				t.Errorf("multipart import: %d %s", status, body)
			}
			// Last, as it signs out.
			if status, body := s.send("POST", api+"/auth/logout", nil); status != 204 {
				t.Errorf("bodiless POST: %d %s", status, body)
			}
		})
	}
}
