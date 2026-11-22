package webui

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const placeholderMarker = "built without the web UI"

func TestPlaceholderWithoutBuiltUI(t *testing.T) {
	h := NewHandler(fstest.MapFS{})
	for _, path := range []string{"/", "/items/1"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), placeholderMarker) {
			t.Errorf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", rec.Code)
	}
}

// The embedded handler serves the built UI when the binary has one, and the
// placeholder exactly when it has not.
func TestEmbeddedHandlerServes(t *testing.T) {
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<html") {
		t.Errorf("embedded handler: %d", rec.Code)
	}
	if placeholder := strings.Contains(rec.Body.String(), placeholderMarker); placeholder == Built() {
		t.Errorf("Built() = %v, but the placeholder is served: %v", Built(), placeholder)
	}
}

// Files are served, client routes fall back to index.html, and a missing file
// with an extension is a 404.
func TestSPAServing(t *testing.T) {
	h := NewHandler(fstest.MapFS{
		"index.html":      {Data: []byte("<!doctype html><title>UI</title>")},
		"assets/app-1.js": {Data: []byte("console.log(1)")},
		"favicon.svg":     {Data: []byte("<svg/>")},
	})
	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec
	}
	for _, path := range []string{"/", "/index.html", "/items/123/edit"} {
		r := get(path)
		if r.Code != 200 || !strings.Contains(r.Body.String(), "<title>UI</title>") || r.Header().Get("Cache-Control") != "no-cache" ||
			!strings.HasPrefix(r.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%s: %d %v %s", path, r.Code, r.Header(), r.Body)
		}
	}
	if r := get("/assets/app-1.js"); r.Code != 200 || r.Body.String() != "console.log(1)" ||
		r.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Errorf("asset: %d %v", r.Code, r.Header())
	}
	if r := get("/favicon.svg"); r.Code != 200 || r.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("a file outside assets/: %d %v", r.Code, r.Header())
	}
	for _, path := range []string{"/assets/missing.js", "/missing.png"} {
		if r := get(path); r.Code != 404 {
			t.Errorf("%s: %d", path, r.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("HEAD", "/items/1", nil))
	if rec.Code != 200 {
		t.Errorf("HEAD: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/items/1", nil))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, HEAD" {
		t.Errorf("PUT: %d %v", rec.Code, rec.Header())
	}
}

func sha256Source(text string) string {
	sum := sha256.Sum256([]byte(text))
	return "sha256-" + base64.StdEncoding.EncodeToString(sum[:])
}

func TestInlineScriptHashes(t *testing.T) {
	boot := "\n      document.documentElement.dataset.theme = 'dark';\n    "
	page := "<!doctype html><html><head>" +
		"<!-- <script>not a script</script> -->" +
		"<script>" + boot + "</script>" +
		`<SCRIPT type="module" crossorigin src="/assets/index.js"></SCRIPT>` +
		`<script data-x="src=1">a()</script >` +
		"<script>\r\nb()\r\n</script>" +
		"</head><body><script src=/x.js></script></body></html>"
	got := InlineScriptHashes([]byte(page))
	want := []string{sha256Source(boot), sha256Source("a()"), sha256Source("\nb()\n")}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("hashes = %v, want %v", got, want)
	}
	if got := InlineScriptHashes([]byte("<html><body>no scripts</body></html>")); len(got) != 0 {
		t.Errorf("no inline scripts: %v", got)
	}
}

func TestPolicyHeader(t *testing.T) {
	boot := "document.documentElement.dataset.theme = 'light';"
	h := NewHandler(fstest.MapFS{
		"index.html":      {Data: []byte("<!doctype html><title>UI</title><script>" + boot + "</script>")},
		"assets/app-1.js": {Data: []byte("console.log(1)")},
	})
	want := "default-src 'self'; script-src 'self' '" + sha256Source(boot) + "'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
		"base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	for _, path := range []string{"/", "/index.html", "/items/123/edit", "/assets/app-1.js"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if got := rec.Header().Get("Content-Security-Policy"); got != want {
			t.Errorf("%s: CSP = %q, want %q", path, got, want)
		}
	}

	// The placeholder page has no inline script, so none is allowed.
	rec := httptest.NewRecorder()
	NewHandler(fstest.MapFS{}).ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "script-src 'self';") || strings.Contains(got, "sha256-") {
		t.Errorf("placeholder: CSP = %q", got)
	}
}

// The policy of the embedded UI allows exactly its index's inline scripts
// (the theme boot script when the UI is built).
func TestEmbeddedPolicyMatchesIndex(t *testing.T) {
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	csp := rec.Header().Get("Content-Security-Policy")
	hashes := InlineScriptHashes(rec.Body.Bytes())
	if Built() && len(hashes) == 0 {
		t.Error("the built index has no inline script; the theme boot script is expected")
	}
	for _, h := range hashes {
		if !strings.Contains(csp, "'"+h+"'") {
			t.Errorf("CSP %q does not allow inline script %s", csp, h)
		}
	}
	if strings.Count(csp, "sha256-") != len(hashes) {
		t.Errorf("CSP %q allows other scripts than the index's %v", csp, hashes)
	}
}
