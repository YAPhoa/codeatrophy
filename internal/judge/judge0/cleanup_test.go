package judge0

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/judge"
)

var pyReq = judge.ExecRequest{Language: "python", Source: "print(1)", TimeLimitMs: 1000, MemoryLimitKb: 65536}

// syncBuffer is a log destination tests can read while the cleaner writes.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *syncBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func cleanupEngine(t *testing.T, url string, cfg Config) (*Engine, *syncBuffer) {
	t.Helper()
	logs := &syncBuffer{}
	cfg.Logger = slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	e := newEngine(t, url, cfg)
	e.clean.backoff = func(int) time.Duration { return 20 * time.Millisecond }
	return e, logs
}

// waitCleaned waits until the cleaner has nothing queued or waiting.
func waitCleaned(t *testing.T, e *Engine) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for e.clean.pending.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%d deletes still pending", e.clean.pending.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (f *fakeJudge0) deletedTokens() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Sorted(slices.Values(f.deleted))
}

func (f *fakeJudge0) deleteRequests() []http.Header {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.deleteHeaders)
}

func batchOf(n int) []judge.ExecRequest {
	reqs := make([]judge.ExecRequest, n)
	for i := range reqs {
		reqs[i] = pyReq
	}
	return reqs
}

// Each submission is deleted in Judge0 once its result is read, single or
// batched, with the authorization token in X-Auth-User next to the
// authentication token.
func TestFinishedSubmissionsAreDeleted(t *testing.T) {
	f, srv := newFake(t)
	f.token = "authn"
	e, logs := cleanupEngine(t, srv.URL, Config{AuthToken: "authn", AuthzToken: "authz"})
	if _, err := e.Execute(context.Background(), pyReq); err != nil {
		t.Fatal(err)
	}
	// Five cases in chunks of two.
	if err := e.ExecuteBatch(context.Background(), batchOf(5), nil, func(i int, _ judge.ExecResult, err error) {
		if err != nil {
			t.Errorf("case %d: %v", i, err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	waitCleaned(t, e)
	want := []string{"tok1", "tok2", "tok3", "tok4", "tok5", "tok6"}
	if got := f.deletedTokens(); !slices.Equal(got, want) {
		t.Errorf("deleted %v, want %v", got, want)
	}
	for _, h := range f.deleteRequests() {
		if h.Get("X-Auth-User") != "authz" || h.Get("X-Auth-Token") != "authn" {
			t.Errorf("delete headers %v", h)
		}
	}
	if s := logs.String(); s != "" {
		t.Errorf("logged: %s", s)
	}
}

// Without an authorization token, or when the server does not allow
// deletes, the adapter sends no delete at all.
func TestNoDeletesWithoutTokenOrPermission(t *testing.T) {
	for name, setup := range map[string]func(f *fakeJudge0, cfg *Config){
		"no token": func(*fakeJudge0, *Config) {},
		"deletes disabled": func(f *fakeJudge0, cfg *Config) {
			cfg.AuthzToken = "authz"
			f.config = map[string]any{"max_submission_batch_size": 2, "enable_batched_submissions": true,
				"enable_submission_delete": false}
		},
	} {
		t.Run(name, func(t *testing.T) {
			f, srv := newFake(t)
			var cfg Config
			setup(f, &cfg)
			e, logs := cleanupEngine(t, srv.URL, cfg)
			if _, err := e.Execute(context.Background(), pyReq); err != nil {
				t.Fatal(err)
			}
			if err := e.ExecuteBatch(context.Background(), batchOf(3), nil, func(int, judge.ExecResult, error) {}); err != nil {
				t.Fatal(err)
			}
			time.Sleep(50 * time.Millisecond)
			if n := len(f.deleteRequests()); n != 0 {
				t.Errorf("%d delete requests", n)
			}
			if cfg.AuthzToken != "" && strings.Count(logs.String(), "ENABLE_SUBMISSION_DELETE") != 1 {
				t.Errorf("want one warning about disabled deletes: %s", logs.String())
			}
		})
	}
}

// A delete that fails never fails or holds up the result: results arrive
// whatever the server answers or however long it takes, the failure is
// logged once as a warning and then at debug level, and a refusal is not
// retried.
func TestDeleteFailuresDoNotAffectResults(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusBadRequest, http.StatusUnauthorized} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			f, srv := newFake(t)
			f.deleteStatus = func(string) int { return status }
			e, logs := cleanupEngine(t, srv.URL, Config{AuthzToken: "wrong"})
			for range 2 {
				if r, err := e.Execute(context.Background(), pyReq); err != nil || r.Stdout != "ok\n" {
					t.Fatalf("result %+v, %v", r, err)
				}
			}
			waitCleaned(t, e)
			if n := len(f.deleteRequests()); n != 2 {
				t.Errorf("%d delete requests for 2 runs (a refusal is not retried)", n)
			}
			s := logs.String()
			if strings.Count(s, "level=WARN") != 1 || strings.Count(s, "level=DEBUG") != 1 ||
				!strings.Contains(s, "stays in Judge0") {
				t.Errorf("logs:\n%s", s)
			}
		})
	}

	t.Run("slow and failing server", func(t *testing.T) {
		f, srv := newFake(t)
		release := make(chan struct{})
		t.Cleanup(func() { close(release) })
		f.deleteStatus = func(string) int { <-release; return http.StatusInternalServerError }
		e, _ := cleanupEngine(t, srv.URL, Config{AuthzToken: "authz"})
		start := time.Now()
		if _, err := e.Execute(context.Background(), pyReq); err != nil {
			t.Fatal(err)
		}
		if err := e.ExecuteBatch(context.Background(), batchOf(4), nil, func(i int, _ judge.ExecResult, err error) {
			if err != nil {
				t.Errorf("case %d: %v", i, err)
			}
		}); err != nil {
			t.Fatal(err)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Errorf("results waited %s for a hanging delete", d)
		}
	})
}

// A server error is retried, and the submission deleted once it answers.
func TestDeleteIsRetriedAfterServerError(t *testing.T) {
	f, srv := newFake(t)
	var calls atomic.Int64
	f.deleteStatus = func(string) int {
		if calls.Add(1) <= 2 {
			return http.StatusServiceUnavailable
		}
		return 0
	}
	e, _ := cleanupEngine(t, srv.URL, Config{AuthzToken: "authz"})
	if _, err := e.Execute(context.Background(), pyReq); err != nil {
		t.Fatal(err)
	}
	waitCleaned(t, e)
	if got := f.deletedTokens(); !slices.Equal(got, []string{"tok1"}) || calls.Load() != 3 {
		t.Errorf("deleted %v after %d attempts", got, calls.Load())
	}
}

// A run the adapter stops waiting for (its context ends, or it times out)
// is deleted once Judge0 has finished it, single or batched.
func TestAbandonedRunsAreDeletedOnceFinished(t *testing.T) {
	f, srv := newFake(t)
	var finished atomic.Bool
	f.unfinished = func(string) bool { return !finished.Load() }
	e, _ := cleanupEngine(t, srv.URL, Config{AuthzToken: "authz", Timeout: 100 * time.Millisecond})

	if _, err := e.Execute(context.Background(), pyReq); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Execute: %v, want the deadline", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	var errs atomic.Int64
	if err := e.ExecuteBatch(ctx, batchOf(3), nil, func(_ int, _ judge.ExecResult, err error) {
		if err != nil {
			errs.Add(1)
		}
	}); err != nil {
		t.Fatal(err)
	}
	// The first chunk of two is abandoned; the third case is never sent.
	if errs.Load() != 3 {
		t.Fatalf("%d of 3 batched runs failed", errs.Load())
	}
	time.Sleep(30 * time.Millisecond) // some deletes are refused meanwhile
	if len(f.deletedTokens()) != 0 || len(f.deleteRequests()) == 0 {
		t.Fatalf("before finishing: deleted %v after %d requests", f.deletedTokens(), len(f.deleteRequests()))
	}
	finished.Store(true)
	waitCleaned(t, e)
	if got := f.deletedTokens(); !slices.Equal(got, []string{"tok1", "tok2", "tok3"}) {
		t.Errorf("deleted %v", got)
	}
}

// A submission that never finishes is given up after a bounded number of
// attempts, with one warning.
func TestNeverFinishedRunIsGivenUp(t *testing.T) {
	f, srv := newFake(t)
	f.unfinished = func(string) bool { return true }
	e, logs := cleanupEngine(t, srv.URL, Config{AuthzToken: "authz", Timeout: 50 * time.Millisecond})
	if _, err := e.Execute(context.Background(), pyReq); err == nil {
		t.Fatal("a run that never finishes succeeded")
	}
	waitCleaned(t, e)
	if n := len(f.deleteRequests()); n != cleanupTries {
		t.Errorf("%d delete attempts, want %d", n, cleanupTries)
	}
	if s := logs.String(); strings.Count(s, "level=WARN") != 1 {
		t.Errorf("logs:\n%s", s)
	}
}

// heldWriter holds a log write that contains hold until release is closed,
// and says on held when it starts holding.
type heldWriter struct {
	hold    string
	held    chan struct{}
	release chan struct{}
}

func (w *heldWriter) Write(p []byte) (int, error) {
	if strings.Contains(string(p), w.hold) {
		close(w.held)
		<-w.release
	}
	return len(p), nil
}

// A delete that has failed for good still counts as pending until its
// failure is logged, so whoever waits for the cleaner sees the log line.
func TestFailedDeleteIsPendingUntilLogged(t *testing.T) {
	f, srv := newFake(t)
	f.deleteStatus = func(string) int { return http.StatusBadRequest }
	w := &heldWriter{hold: "could not delete", held: make(chan struct{}), release: make(chan struct{})}
	e := newEngine(t, srv.URL, Config{AuthzToken: "wrong",
		Logger: slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug}))})
	if _, err := e.Execute(context.Background(), pyReq); err != nil {
		t.Fatal(err)
	}
	select {
	case <-w.held:
	case <-time.After(5 * time.Second):
		t.Fatal("the failed delete was never logged")
	}
	if n := e.clean.pending.Load(); n != 1 {
		t.Errorf("%d pending while the failure is being logged, want 1", n)
	}
	close(w.release)
	waitCleaned(t, e)
}
