// Package webui serves the single-page web UI embedded in the binary.
//
// The build copies the UI's production output (web/dist) into the dist
// directory next to this file before compiling. When it is absent, as on a
// fresh checkout, a small placeholder page is served instead.
package webui

import (
	"bytes"
	"embed"
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
	files := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
