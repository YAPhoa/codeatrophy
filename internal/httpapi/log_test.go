package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/httpapi"
	"codeatrophy/internal/store/teststore"
)

// logBuffer collects JSON log records.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// records returns the records with the message msg.
func (b *logBuffer) records(t *testing.T, msg string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		if m["msg"] == msg {
			out = append(out, m)
		}
	}
	return out
}

// newLoggedServer returns a server with sign-in off that logs to the
// returned buffer at every level.
func newLoggedServer(t *testing.T, configure func(*httpapi.Options)) (http.Handler, *logBuffer) {
	t.Helper()
	logs := &logBuffer{}
	log := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	a := app.New(app.Options{Store: teststore.Open(t), HealthInterval: time.Hour})
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Stop)
	opts := httpapi.Options{App: a, Logger: log}
	if configure != nil {
		configure(&opts)
	}
	return httpapi.New(opts), logs
}

// serve answers a GET from peer (an address and port), with
// X-Forwarded-For when xff is not empty.
func serve(h http.Handler, path, peer, xff string) int {
	r := httptest.NewRequest("GET", path, nil)
	r.Host = "localhost"
	r.RemoteAddr = peer
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code
}

func TestRequestLogLevels(t *testing.T) {
	h, logs := newLoggedServer(t, nil)
	serve(h, httpapi.Prefix+"/meta", "192.0.2.1:1234", "")
	recs := logs.records(t, "request")
	if len(recs) != 1 || recs[0]["level"] != "DEBUG" || recs[0]["client"] != "192.0.2.1" {
		t.Fatalf("without the access log: %v", recs)
	}

	h, logs = newLoggedServer(t, func(o *httpapi.Options) { o.AccessLog = true })
	serve(h, httpapi.Prefix+"/meta?token=secret-value", "192.0.2.1:1234", "")
	serve(h, httpapi.Prefix+"/health", "192.0.2.1:1234", "")
	serve(h, httpapi.Prefix+"/nowhere", "192.0.2.1:1234", "")
	recs = logs.records(t, "request")
	if len(recs) != 3 {
		t.Fatalf("records: %v", recs)
	}
	meta, health, missing := recs[0], recs[1], recs[2]
	if meta["level"] != "INFO" || meta["method"] != "GET" || meta["path"] != httpapi.Prefix+"/meta" ||
		meta["status"] != float64(200) || meta["client"] != "192.0.2.1" || meta["bytes"].(float64) <= 0 ||
		meta["duration"] == nil {
		t.Errorf("access log: %v", meta)
	}
	if strings.Contains(logs.String(), "secret-value") {
		t.Error("the query string was logged")
	}
	if health["level"] != "DEBUG" {
		t.Errorf("the health check is logged at %v", health["level"])
	}
	if missing["level"] != "INFO" || missing["status"] != float64(404) {
		t.Errorf("not found: %v", missing)
	}
}

func TestRequestLogClientBehindTrustedProxy(t *testing.T) {
	h, logs := newLoggedServer(t, func(o *httpapi.Options) {
		o.AccessLog = true
		o.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	})
	serve(h, httpapi.Prefix+"/meta", "192.0.2.1:1234", "203.0.113.7")
	recs := logs.records(t, "request")
	if len(recs) != 1 || recs[0]["client"] != "203.0.113.7" {
		t.Errorf("records: %v", recs)
	}
}

const proxyHint = "ignoring X-Forwarded-For from a peer not in CODEATROPHY_TRUSTED_PROXIES; " +
	"clients behind it are logged and rate-limited as the peer"

// A peer that sends X-Forwarded-For without being a trusted proxy is warned
// about once, for at most 16 peers; a trusted proxy never.
func TestUntrustedProxyHint(t *testing.T) {
	h, logs := newLoggedServer(t, nil)
	serve(h, httpapi.Prefix+"/meta", "192.0.2.1:1234", "")
	if n := len(logs.records(t, proxyHint)); n != 0 {
		t.Fatalf("%d warnings without X-Forwarded-For", n)
	}
	serve(h, httpapi.Prefix+"/meta", "192.0.2.1:1234", "203.0.113.7")
	serve(h, httpapi.Prefix+"/health", "192.0.2.1:5678", "203.0.113.8")
	recs := logs.records(t, proxyHint)
	if len(recs) != 1 || recs[0]["level"] != "WARN" || recs[0]["peer"] != "192.0.2.1" {
		t.Fatalf("one peer: %v", recs)
	}
	if r := logs.records(t, "request"); r[len(r)-1]["client"] != "192.0.2.1" {
		t.Errorf("the client of an untrusted peer: %v", r[len(r)-1])
	}
	for i := 2; i < 40; i++ {
		serve(h, httpapi.Prefix+"/health", netip.AddrFrom4([4]byte{192, 0, 2, byte(i)}).String()+":80", "203.0.113.7")
	}
	if n := len(logs.records(t, proxyHint)); n != 16 {
		t.Errorf("%d peers warned about, want 16", n)
	}

	h, logs = newLoggedServer(t, func(o *httpapi.Options) {
		o.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("192.0.2.1/32")}
	})
	serve(h, httpapi.Prefix+"/meta", "192.0.2.1:1234", "203.0.113.7")
	if n := len(logs.records(t, proxyHint)); n != 0 {
		t.Errorf("%d warnings for a trusted proxy", n)
	}
	serve(h, httpapi.Prefix+"/meta", "192.0.2.9:1234", "203.0.113.7")
	if n := len(logs.records(t, proxyHint)); n != 1 {
		t.Errorf("%d warnings for an untrusted peer beside a trusted proxy", n)
	}
}

// A server error is logged at warn with or without the access log, and the
// failure with the client.
func TestServerErrorLog(t *testing.T) {
	h, logs := newLoggedServer(t, func(o *httpapi.Options) {
		o.Web = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { panic("boom") })
	})
	serve(h, "/page", "192.0.2.1:1234", "")
	if recs := logs.records(t, "request"); len(recs) != 1 || recs[0]["level"] != "WARN" || recs[0]["status"] != float64(500) {
		t.Errorf("request: %v", recs)
	}
	if recs := logs.records(t, "panic serving request"); len(recs) != 1 || recs[0]["client"] != "192.0.2.1" {
		t.Errorf("panic: %v", recs)
	}
}
