// Package webui serves the single-page web UI embedded in the binary.
//
// The build copies the UI's production output (web/dist) into the dist
// directory next to this file before compiling. When it is absent, as on a
// fresh checkout, a small placeholder page is served instead.
package webui

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed all:dist
var distFS embed.FS

//go:embed placeholder.html
var placeholder []byte

// Handler returns the UI handler. Paths that do not name a file fall back to
// index.html so that client-side routes work.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	return NewHandler(sub)
}

// Built reports whether the binary contains the built UI.
func Built() bool {
	_, err := fs.Stat(distFS, "dist/index.html")
	return err == nil
}

// NewHandler serves the files in root with SPA fallback.
func NewHandler(root fs.FS) http.Handler {
	index, err := fs.ReadFile(root, "index.html")
	if err != nil {
		index = placeholder
	}
	csp := Policy(index)
	files := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if st, err := fs.Stat(root, name); err == nil && !st.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				files.ServeHTTP(w, r)
				return
			}
			// A missing file with an extension is a real 404, not a route.
			if strings.Contains(path.Base(name), ".") {
				http.NotFound(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(index))
	})
}

// Policy returns the Content-Security-Policy of the UI's responses for the
// page index. Scripts load only from the server itself, plus the page's own
// inline scripts (the theme boot script) by hash, so a script injected into
// rendered item text cannot run. Styles may be inline: a Mermaid diagram is
// SVG markup with a <style> element and style attributes. Images may come
// from https: and data: URLs (item text), fonts from data: URLs (the build
// inlines the smallest KaTeX font).
func Policy(index []byte) string {
	script := "'self'"
	for _, h := range InlineScriptHashes(index) {
		script += " '" + h + "'"
	}
	return "default-src 'self'; script-src " + script + "; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
		"base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
}

// InlineScriptHashes returns the CSP source ("sha256-<base64>") of each
// inline <script> element in page: one without a src attribute, hashed over
// its text exactly as the browser sees it (line breaks normalised to LF, as
// HTML parsing does). HTML comments are skipped. The page is the server's
// own build output, so this does not need to handle every corner of HTML.
func InlineScriptHashes(page []byte) []string {
	var hashes []string
	// ASCII only, byte for byte, so that offsets in lower are offsets in page.
	lower := make([]byte, len(page))
	for i, c := range page {
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		lower[i] = c
	}
	for i := 0; i < len(page); {
		switch {
		case bytes.HasPrefix(page[i:], []byte("<!--")):
			end := bytes.Index(page[i+4:], []byte("-->"))
			if end < 0 {
				return hashes
			}
			i += 4 + end + 3
		case bytes.HasPrefix(lower[i:], []byte("<script")) && i+7 < len(page) && isTagEnd(page[i+7]):
			tagEnd := endOfTag(page, i+7)
			if tagEnd < 0 {
				return hashes
			}
			attrs := lower[i+7 : tagEnd]
			body := tagEnd + 1
			closing := bytes.Index(lower[body:], []byte("</script"))
			if closing < 0 {
				return hashes
			}
			if !hasAttr(attrs, "src") {
				text := bytes.ReplaceAll(page[body:body+closing], []byte("\r\n"), []byte("\n"))
				text = bytes.ReplaceAll(text, []byte("\r"), []byte("\n"))
				sum := sha256.Sum256(text)
				hashes = append(hashes, "sha256-"+base64.StdEncoding.EncodeToString(sum[:]))
			}
			i = body + closing + len("</script")
		default:
			i++
		}
	}
	return hashes
}

func isTagEnd(c byte) bool {
	return c == '>' || c == '/' || c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'
}

// endOfTag returns the index of the '>' that closes the tag whose attributes
// start at i, or -1.
func endOfTag(page []byte, i int) int {
	var quote byte
	for ; i < len(page); i++ {
		switch c := page[i]; {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '>':
			return i
		}
	}
	return -1
}

// hasAttr reports whether the (lower-cased) attribute text names attribute
// name outside a quoted value.
func hasAttr(attrs []byte, name string) bool {
	var quote byte
	for i := 0; i < len(attrs); i++ {
		c := attrs[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case bytes.HasPrefix(attrs[i:], []byte(name)) && (i == 0 || isSpace(attrs[i-1])):
			j := i + len(name)
			if j == len(attrs) || isSpace(attrs[j]) || attrs[j] == '=' || attrs[j] == '/' {
				return true
			}
		}
	}
	return false
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' }
