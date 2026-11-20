package judge0_test

// Regression tests for batch timeouts, re-execution after a failed batch and
// a stuck engine holding a worker (reported by an independent review).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/judge/judge0"
)

// slowJudge0 finishes every submission a fixed time after it was created,
// like a Judge0 whose workers are busy.
type slowJudge0 struct {
	mu      sync.Mutex
	created map[string]time.Time
	delays  map[string]time.Duration
	n       atomic.Int64
	delay   time.Duration
	batch   int
	// stdinDelay, if set, overrides delay for submissions with that stdin.
	stdinDelay map[string]time.Duration
}

func (f *slowJudge0) serve(w http.ResponseWriter, r *http.Request) {
	enc := json.NewEncoder(w)
	newTok := func(sub json.RawMessage) string {
		var body struct {
			Stdin string `json:"stdin"`
		}
		json.Unmarshal(sub, &body)
		stdin, _ := base64.StdEncoding.DecodeString(body.Stdin)
		delay, ok := f.stdinDelay[string(stdin)]
		if !ok {
			delay = f.delay
		}
		id := f.n.Add(1)
		tok := fmt.Sprintf("t%d", id)
		f.mu.Lock()
		if f.delays == nil {
			f.delays = map[string]time.Duration{}
		}
		f.created[tok] = time.Now()
		f.delays[tok] = delay
		f.mu.Unlock()
		return tok
	}
	status := func(tok string) map[string]any {
		f.mu.Lock()
		at, delay := f.created[tok], f.delays[tok]
		f.mu.Unlock()
		if time.Since(at) < delay {
			return map[string]any{"token": tok, "status": map[string]any{"id": 2, "description": "Processing"}}
		}
		return map[string]any{"token": tok, "status": map[string]any{"id": 3, "description": "Accepted"},
			"stdout": base64.StdEncoding.EncodeToString([]byte("ok\n")), "time": "0.010", "memory": 1000}
	}
	switch {
	case r.URL.Path == "/about":
		enc.Encode(map[string]any{})
	case r.URL.Path == "/languages":
		enc.Encode([]map[string]any{{"id": 71, "name": "Python (3.8.1)"}})
	case r.URL.Path == "/config_info":
		enc.Encode(map[string]any{"max_submission_batch_size": f.batch, "enable_batched_submissions": true,
			"max_cpu_time_limit": 15, "max_wall_time_limit": 20, "max_memory_limit": 512000})
	case r.URL.Path == "/submissions" && r.Method == http.MethodPost:
		var sub json.RawMessage
		json.NewDecoder(r.Body).Decode(&sub)
		enc.Encode(map[string]any{"token": newTok(sub)})
	case r.URL.Path == "/submissions/batch" && r.Method == http.MethodPost:
		var body struct {
			Submissions []json.RawMessage `json:"submissions"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		out := []map[string]any{}
		for _, sub := range body.Submissions {
			out = append(out, map[string]any{"token": newTok(sub)})
		}
		enc.Encode(out)
	case r.URL.Path == "/submissions/batch":
		var subs []map[string]any
		for _, tok := range strings.Split(r.URL.Query().Get("tokens"), ",") {
			subs = append(subs, status(tok))
		}
		enc.Encode(map[string]any{"submissions": subs})
	case strings.HasPrefix(r.URL.Path, "/submissions/"):
		enc.Encode(status(strings.TrimPrefix(r.URL.Path, "/submissions/")))
	default:
		http.NotFound(w, r)
	}
}

func cases(n int) []grader.Case {
	exp := "ok\n"
	var out []grader.Case
	for i := range n {
		out = append(out, grader.Case{Name: fmt.Sprint(i), Stdin: "x", Expected: &exp})
	}
	return out
}

var prog = grader.Program{Language: "python", Source: "print('ok')", TimeLimitMs: 1000, MemoryLimitKb: 65536}

// The timeout applies per chunk, so cases that each finish well within it
// pass, and nothing is executed twice. Ten chunks of about 250 ms take far
// longer than the timeout in total, yet each is a quarter of it.
func TestBatchTimeoutIsPerChunkAndNothingIsReExecuted(t *testing.T) {
	f := &slowJudge0{created: map[string]time.Time{}, delay: 200 * time.Millisecond, batch: 2}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	defer srv.Close()
	eng, err := judge0.New(judge0.Config{URL: srv.URL, Timeout: time.Second, PollInterval: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	cs := cases(21)
	start := time.Now()
	out := grader.New(eng, 4).Grade(context.Background(), prog, domain.CompareTokens, cs, nil)
	if out.Verdict != domain.VerdictAccepted || out.Passed != len(cs) {
		t.Errorf("verdict %s, passed %d/%d", out.Verdict, out.Passed, len(cs))
	}
	if f.n.Load() != int64(len(cs)) {
		t.Errorf("%d cases caused %d Judge0 executions", len(cs), f.n.Load())
	}
	// Otherwise the test proves nothing about the timeout being per chunk.
	if d := time.Since(start); d < 2*time.Second {
		t.Fatalf("the batch took only %s, not more than the timeout", d)
	}
}

// An engine whose API answers but whose workers never finish stops the
// submission after the first timeout instead of waiting for every case.
func TestStuckJudgeDoesNotHoldWorker(t *testing.T) {
	f := &slowJudge0{created: map[string]time.Time{}, delay: time.Hour, batch: 20}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	defer srv.Close()
	eng, _ := judge0.New(judge0.Config{URL: srv.URL, Timeout: 500 * time.Millisecond, PollInterval: 50 * time.Millisecond})
	cs := cases(17)
	start := time.Now()
	out := grader.New(eng, 4).Grade(context.Background(), prog, domain.CompareTokens, cs, nil)
	// The execution count below is the precise check; this only catches a
	// wait far beyond the timeout.
	d := time.Since(start)
	if d > 5*time.Second {
		t.Errorf("an unresponsive engine held the submission for %s (timeout 500ms)", d.Round(time.Millisecond))
	}
	if out.Verdict != domain.VerdictInternalError || out.Error == nil || len(out.Results) != len(cs) {
		t.Errorf("verdict %s, %d results", out.Verdict, len(out.Results))
	}
	if f.n.Load() != 1 {
		t.Errorf("%d executions were started after the engine failed", f.n.Load()-1)
	}
}

// A batch timing out keeps the results that finished; the cases still
// running when it times out fail with the deadline.
func TestBatchTimeoutKeepsFinishedResults(t *testing.T) {
	f := &slowJudge0{created: map[string]time.Time{}, batch: 20, stdinDelay: map[string]time.Duration{"slow": time.Hour}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	defer srv.Close()
	eng, _ := judge0.New(judge0.Config{URL: srv.URL, Timeout: 500 * time.Millisecond, PollInterval: 50 * time.Millisecond})
	// The first input runs alone, the other four in one batch.
	stdins := []string{"fast", "fast", "slow", "fast", "slow"}
	out := grader.New(eng, 4).RunAll(context.Background(), prog, stdins, nil)
	for i, in := range stdins {
		e := out[i]
		if in == "fast" && (e.Err != nil || e.Result.Stdout != "ok\n") {
			t.Errorf("case %d (fast): %+v, %v", i, e.Result, e.Err)
		}
		if in == "slow" && !errors.Is(e.Err, context.DeadlineExceeded) {
			t.Errorf("case %d (slow): err %v, want the deadline", i, e.Err)
		}
	}
	if f.n.Load() != int64(len(stdins)) {
		t.Errorf("%d inputs caused %d Judge0 executions", len(stdins), f.n.Load())
	}
}
