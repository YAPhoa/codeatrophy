package judge0

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/judge"
)

// fakeJudge0 emulates the parts of the Judge0 REST API the adapter uses.
type fakeJudge0 struct {
	t        *testing.T
	token    string
	mu       sync.Mutex
	received []map[string]any
	// result returns the final submission object for a request body.
	result func(body map[string]any) map[string]any
	polls  map[string]int
	bodies map[string]map[string]any
	n      int
	// languages and config, when set, replace the /languages and
	// /config_info answers.
	languages []map[string]any
	config    map[string]any
	// batchCreate and batchPoll, when set, may answer a batch request
	// themselves (returning true); call counts that endpoint's requests
	// from 1.
	batchCreate  func(w http.ResponseWriter, call int, subs []map[string]any) bool
	batchPoll    func(w http.ResponseWriter, call int, tokens []string) bool
	batchCreates int
	batchPolls   int
	singles      int
}

func b64s(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func newFake(t *testing.T) (*fakeJudge0, *httptest.Server) {
	f := &fakeJudge0{t: t, polls: map[string]int{}, bodies: map[string]map[string]any{}}
	f.result = func(map[string]any) map[string]any {
		return map[string]any{"status": map[string]any{"id": 3, "description": "Accepted"}, "stdout": b64s("ok\n"), "time": "0.012", "memory": 3000}
	}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeJudge0) serve(w http.ResponseWriter, r *http.Request) {
	if f.token != "" && r.Header.Get("X-Auth-Token") != f.token {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	writeJSON := func(v any) { json.NewEncoder(w).Encode(v) }
	switch {
	case r.URL.Path == "/about":
		writeJSON(map[string]any{"version": "1.13.1"})
	case r.URL.Path == "/languages" && f.languages != nil:
		writeJSON(f.languages)
	case r.URL.Path == "/languages":
		writeJSON([]map[string]any{
			{"id": 52, "name": "C++ (GCC 7.4.0)"}, {"id": 54, "name": "C++ (GCC 9.2.0)"},
			{"id": 70, "name": "Python (2.7.17)"}, {"id": 71, "name": "Python (3.8.1)"},
			{"id": 62, "name": "Java (OpenJDK 13.0.1)"}, {"id": 78, "name": "Kotlin (1.3.70)"},
			{"id": 63, "name": "JavaScript (Node.js 12.14.0)"}, {"id": 89, "name": "Multi-file program"},
			{"id": 44, "name": "Executable"},
		})
	case r.URL.Path == "/languages/62":
		writeJSON(map[string]any{"compile_cmd": "/usr/local/openjdk13/bin/javac %s Main.java", "run_cmd": "/usr/local/openjdk13/bin/java Main"})
	case r.URL.Path == "/languages/54":
		writeJSON(map[string]any{"compile_cmd": "/usr/local/gcc-9.2.0/bin/g++ %s main.cpp", "run_cmd": "LD_LIBRARY_PATH=/usr/local/gcc-9.2.0/lib64 ./a.out"})
	case r.URL.Path == "/languages/71":
		writeJSON(map[string]any{"run_cmd": "/usr/local/python-3.8.1/bin/python3 script.py"})
	case r.URL.Path == "/languages/78":
		writeJSON(map[string]any{"compile_cmd": "/usr/local/kotlin-1.3.70/bin/kotlinc %s Main.kt", "run_cmd": "/usr/local/kotlin-1.3.70/bin/kotlin MainKt"})
	case r.URL.Path == "/config_info" && f.config != nil:
		writeJSON(f.config)
	case r.URL.Path == "/config_info":
		writeJSON(map[string]any{"max_memory_limit": 8388608, "max_wall_time_limit": 60, "max_cpu_time_limit": 30,
			"max_submission_batch_size": 2, "enable_batched_submissions": true})
	case r.URL.Path == "/submissions" && r.Method == http.MethodPost:
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.singles++
		f.mu.Unlock()
		writeJSON(map[string]any{"token": f.add(body)})
	case r.URL.Path == "/submissions/batch" && r.Method == http.MethodPost:
		var body struct {
			Submissions []map[string]any `json:"submissions"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.batchCreates++
		call := f.batchCreates
		f.mu.Unlock()
		if f.batchCreate != nil && f.batchCreate(w, call, body.Submissions) {
			return
		}
		var out []map[string]any
		for _, s := range body.Submissions {
			out = append(out, map[string]any{"token": f.add(s)})
		}
		writeJSON(out)
	case r.URL.Path == "/submissions/batch" && r.Method == http.MethodGet:
		tokens := strings.Split(r.URL.Query().Get("tokens"), ",")
		f.mu.Lock()
		f.batchPolls++
		call := f.batchPolls
		f.mu.Unlock()
		if f.batchPoll != nil && f.batchPoll(w, call, tokens) {
			return
		}
		var subs []map[string]any
		for _, tok := range tokens {
			subs = append(subs, f.poll(tok))
		}
		writeJSON(map[string]any{"submissions": subs})
	case strings.HasPrefix(r.URL.Path, "/submissions/"):
		if r.URL.Query().Get("base64_encoded") != "true" {
			f.t.Error("results must be requested base64-encoded")
		}
		writeJSON(f.poll(strings.TrimPrefix(r.URL.Path, "/submissions/")))
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeJudge0) add(body map[string]any) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	tok := fmt.Sprint("tok", f.n)
	f.received = append(f.received, body)
	f.bodies[tok] = body
	return tok
}

func (f *fakeJudge0) poll(tok string) map[string]any {
	f.mu.Lock()
	f.polls[tok]++
	first := f.polls[tok] == 1
	body := f.bodies[tok]
	f.mu.Unlock()
	if first {
		return map[string]any{"token": tok, "status": map[string]any{"id": 2, "description": "Processing"}}
	}
	res := f.result(body)
	res["token"] = tok
	return res
}

func (f *fakeJudge0) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.received[len(f.received)-1]
}

func newEngine(t *testing.T, url string, cfg Config) *Engine {
	cfg.URL = url
	cfg.PollInterval = 10 * time.Millisecond
	e, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestLanguagesMapping(t *testing.T) {
	_, srv := newFake(t)
	e := newEngine(t, srv.URL, Config{})
	if err := e.Health(context.Background()); err != nil {
		t.Fatal(err)
	}
	langs, err := e.Languages(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, l := range langs {
		got[l.ID] = l.Version
	}
	want := map[string]string{"cpp": "GCC 9.2.0", "python": "3.8.1", "java": "OpenJDK 13.0.1", "kotlin": "1.3.70", "javascript": "Node.js 12.14.0"}
	if len(got) != len(want) {
		t.Errorf("languages %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: version %q, want %q", k, got[k], v)
		}
	}
}

func TestExecuteSendsPerProcessLimits(t *testing.T) {
	f, srv := newFake(t)
	e := newEngine(t, srv.URL, Config{})
	res, err := e.Execute(context.Background(), judge.ExecRequest{Language: "python", Source: "print(1)", Stdin: "in",
		TimeLimitMs: 2000, MemoryLimitKb: 262144})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != judge.StatusOK || res.Stdout != "ok\n" || *res.TimeMs != 12 || *res.MemoryKb != 3000 {
		t.Errorf("result: %+v", res)
	}
	body := f.last()
	if body["language_id"] != float64(71) || body["enable_per_process_and_thread_time_limit"] != true ||
		body["enable_per_process_and_thread_memory_limit"] != true || body["cpu_time_limit"] != float64(2) ||
		body["wall_time_limit"] != float64(3) || body["memory_limit"] != float64(262144+65536) ||
		body["source_code"] != b64s("print(1)") || body["stdin"] != b64s("in") {
		t.Errorf("request: %v", body)
	}
	// With cgroups, limits are sent as is and the per-process flags are off.
	e2 := newEngine(t, srv.URL, Config{UseCgroups: true})
	if _, err := e2.Execute(context.Background(), judge.ExecRequest{Language: "java", Source: "x", TimeLimitMs: 1000, MemoryLimitKb: 65536}); err != nil {
		t.Fatal(err)
	}
	body = f.last()
	if body["enable_per_process_and_thread_memory_limit"] != false || body["memory_limit"] != float64(65536) || body["language_id"] != float64(62) {
		t.Errorf("cgroup request: %v", body)
	}
	if _, err := e.Execute(context.Background(), judge.ExecRequest{Language: "rust", Source: "x"}); err != judge.ErrUnsupportedLanguage {
		t.Errorf("unsupported language: %v", err)
	}
}

func unzip(t *testing.T, b64 string) map[string]string {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

func TestJVMLanguagesRunAsMultiFilePrograms(t *testing.T) {
	f, srv := newFake(t)
	e := newEngine(t, srv.URL, Config{})
	if _, err := e.Execute(context.Background(), judge.ExecRequest{Language: "java", Source: "public class Main{}", TimeLimitMs: 1000, MemoryLimitKb: 131072}); err != nil {
		t.Fatal(err)
	}
	body := f.last()
	if body["language_id"] != float64(89) || body["source_code"] != nil || body["memory_limit"] != float64(131072+524288) ||
		body["wall_time_limit"] != float64(3) {
		t.Errorf("java request: %v", body)
	}
	files := unzip(t, body["additional_files"].(string))
	if files["Main.java"] != "public class Main{}" {
		t.Errorf("source: %q", files["Main.java"])
	}
	if !strings.Contains(files["compile"], "/usr/local/openjdk13/bin/javac -J-XX:ActiveProcessorCount=1") {
		t.Errorf("compile: %q", files["compile"])
	}
	if !strings.Contains(files["run"], "/usr/local/openjdk13/bin/java -XX:ActiveProcessorCount=1") || !strings.Contains(files["run"], "-Xmx131072k Main") {
		t.Errorf("run: %q", files["run"])
	}
	if _, err := e.Execute(context.Background(), judge.ExecRequest{Language: "kotlin", Source: "fun main(){}", TimeLimitMs: 1000, MemoryLimitKb: 65536}); err != nil {
		t.Fatal(err)
	}
	files = unzip(t, f.last()["additional_files"].(string))
	if !strings.Contains(files["compile"], "/usr/local/kotlin-1.3.70/bin/kotlinc Main.kt -include-runtime -d main.jar") ||
		!strings.Contains(files["run"], "-jar main.jar") {
		t.Errorf("kotlin: %v", files)
	}
}

func TestSourceLimitOfMultiFilePrograms(t *testing.T) {
	f, srv := newFake(t)
	e := newEngine(t, srv.URL, Config{})
	ctx := context.Background()
	// Judge0 1.13.1 extracts files of at most MAX_EXTRACT_SIZE (10240 KB by
	// default; a larger Main.java fails with exit status 127). The fake
	// server does not report it, so the default applies.
	for lang, want := range map[string]int{"java": 10240 * 1024, "kotlin": 10240 * 1024, "python": 0, "cpp": 0} {
		if n, err := e.MaxSourceBytes(ctx, lang); err != nil || n != want {
			t.Errorf("%s: limit %d (%v), want %d", lang, n, err, want)
		}
	}
	before := len(f.received)
	_, err := e.Execute(ctx, judge.ExecRequest{Language: "java", Source: strings.Repeat("x", 10240*1024+1), TimeLimitMs: 1000, MemoryLimitKb: 65536})
	if err == nil || !strings.Contains(err.Error(), "at most 10485760 bytes") || len(f.received) != before {
		t.Errorf("an oversized Java program: %v (%d requests)", err, len(f.received)-before)
	}
	if got := e.SourceNames("python"); len(got) != 1 || got[0] != "script.py" {
		t.Errorf("source names: %v", got)
	}

	// With cgroups, Java runs as a single-file program.
	_, srv2 := newFake(t)
	e2 := newEngine(t, srv2.URL, Config{UseCgroups: true})
	if n, _ := e2.MaxSourceBytes(ctx, "java"); n != 0 {
		t.Errorf("cgroup mode: java limit %d", n)
	}
}

func TestStatusMapping(t *testing.T) {
	f, srv := newFake(t)
	e := newEngine(t, srv.URL, Config{})
	cases := []struct {
		name   string
		lang   string
		result map[string]any
		want   judge.Status
	}{
		{"accepted", "python", map[string]any{"status": map[string]any{"id": 3}, "memory": 1000}, judge.StatusOK},
		{"tle wall clock", "python", map[string]any{"status": map[string]any{"id": 5}, "time": "0.0", "wall_time": "3.1"}, judge.StatusTimeLimit},
		{"compile", "cpp", map[string]any{"status": map[string]any{"id": 6}, "compile_output": b64s("main.cpp:1: error")}, judge.StatusCompileError},
		{"nzec", "python", map[string]any{"status": map[string]any{"id": 11}, "stderr": b64s("ValueError"), "exit_code": 1}, judge.StatusRuntimeError},
		{"segfault", "cpp", map[string]any{"status": map[string]any{"id": 11}, "stderr": b64s("Segmentation fault"), "exit_code": 139}, judge.StatusRuntimeError},
		{"python MemoryError", "python", map[string]any{"status": map[string]any{"id": 11}, "stderr": b64s("Traceback\nMemoryError\n")}, judge.StatusMemoryLimit},
		{"bad_alloc", "cpp", map[string]any{"status": map[string]any{"id": 11}, "stderr": b64s("std::bad_alloc")}, judge.StatusMemoryLimit},
		{"java heap", "java", map[string]any{"status": map[string]any{"id": 11}, "stderr": b64s("java.lang.OutOfMemoryError: Java heap space")}, judge.StatusMemoryLimit},
		{"node heap", "javascript", map[string]any{"status": map[string]any{"id": 11}, "stderr": b64s("JavaScript heap out of memory")}, judge.StatusMemoryLimit},
		{"go oom", "cpp", map[string]any{"status": map[string]any{"id": 11}, "stderr": b64s("fatal error: out of memory")}, judge.StatusMemoryLimit},
		// The peak RSS above the item's limit counts as MLE even on success.
		{"rss over limit", "python", map[string]any{"status": map[string]any{"id": 3}, "memory": 70000}, judge.StatusMemoryLimit},
		{"internal", "python", map[string]any{"status": map[string]any{"id": 13}, "message": b64s("box error")}, judge.StatusInternalError},
	}
	for _, c := range cases {
		f.result = func(map[string]any) map[string]any { return c.result }
		res, err := e.Execute(context.Background(), judge.ExecRequest{Language: c.lang, Source: "x", TimeLimitMs: 1000, MemoryLimitKb: 65536})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if res.Status != c.want {
			t.Errorf("%s: status %s, want %s", c.name, res.Status, c.want)
		}
		if c.name == "tle wall clock" && (res.TimeMs == nil || *res.TimeMs != 3100) {
			t.Errorf("TLE should report the wall time: %v", res.TimeMs)
		}
		if c.name == "compile" && res.CompileOutput != "main.cpp:1: error" {
			t.Errorf("compile output %q", res.CompileOutput)
		}
	}
	// In cgroup mode an internal error hints at the cgroup requirement.
	e2 := newEngine(t, srv.URL, Config{UseCgroups: true})
	f.result = func(map[string]any) map[string]any {
		return map[string]any{"status": map[string]any{"id": 13}, "message": b64s("No such file or directory @ rb_sysopen - /box/script.py")}
	}
	res, _ := e2.Execute(context.Background(), judge.ExecRequest{Language: "python", Source: "x", TimeLimitMs: 1000, MemoryLimitKb: 65536})
	if res.Status != judge.StatusInternalError || !strings.Contains(res.Message, "CODEATROPHY_JUDGE0_CGROUPS") {
		t.Errorf("cgroup hint: %+v", res)
	}
}

func TestBatchExecution(t *testing.T) {
	f, srv := newFake(t)
	f.result = func(body map[string]any) map[string]any {
		in, _ := base64.StdEncoding.DecodeString(body["stdin"].(string))
		return map[string]any{"status": map[string]any{"id": 3}, "stdout": b64s(strings.ToUpper(string(in)))}
	}
	e := newEngine(t, srv.URL, Config{})
	var reqs []judge.ExecRequest
	for _, in := range []string{"a", "b", "c", "d", "e"} {
		reqs = append(reqs, judge.ExecRequest{Language: "python", Source: "x", Stdin: in, TimeLimitMs: 1000, MemoryLimitKb: 65536})
	}
	res := make([]judge.ExecResult, len(reqs))
	err := e.ExecuteBatch(context.Background(), reqs, nil, func(i int, r judge.ExecResult, err error) {
		if err != nil {
			t.Errorf("case %d: %v", i, err)
		}
		res[i] = r
	})
	if err != nil {
		t.Fatal(err)
	}
	var outs []string
	for _, r := range res {
		outs = append(outs, r.Stdout)
	}
	if strings.Join(outs, "") != "ABCDE" {
		t.Errorf("batch results out of order: %v", outs)
	}
}

func TestAuthTokenAndHTTPErrors(t *testing.T) {
	f, srv := newFake(t)
	f.token = "secret-token"
	if err := newEngine(t, srv.URL, Config{}).Health(context.Background()); err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("missing token: %v", err)
	}
	e := newEngine(t, srv.URL, Config{AuthToken: "secret-token"})
	if err := e.Health(context.Background()); err != nil {
		t.Errorf("with token: %v", err)
	}
	dead := newEngine(t, "http://127.0.0.1:1", Config{})
	if err := dead.Health(context.Background()); err == nil {
		t.Error("unreachable engine should fail its health check")
	}
	if _, err := New(Config{}); err == nil {
		t.Error("URL is required")
	}
}

func TestOutputFileLimitFitsLargestExpectedOutput(t *testing.T) {
	f, srv := newFake(t)
	e := newEngine(t, srv.URL, Config{})
	if _, err := e.Execute(context.Background(), judge.ExecRequest{Language: "python", Source: "x", TimeLimitMs: 1000, MemoryLimitKb: 65536}); err != nil {
		t.Fatal(err)
	}
	if got := f.last()["max_file_size"]; got != float64(8192+1024) {
		t.Errorf("max_file_size = %v", got)
	}
}

func TestShellCrashReportIsStrippedOnlyWhenUnambiguous(t *testing.T) {
	f, srv := newFake(t)
	e := newEngine(t, srv.URL, Config{})
	report := "run: line 1:     3 Aborted                 (core dumped) LD_LIBRARY_PATH=/usr/local/gcc-9.2.0/lib64 ./a.out\n"
	run := func(lang, stderr string, exit int) judge.ExecResult {
		f.result = func(map[string]any) map[string]any {
			return map[string]any{"status": map[string]any{"id": 11}, "stderr": b64s(stderr), "exit_code": exit,
				"message": b64s("Exited with error status " + fmt.Sprint(exit))}
		}
		res, err := e.Execute(context.Background(), judge.ExecRequest{Language: lang, Source: "x", TimeLimitMs: 1000, MemoryLimitKb: 65536})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	res := run("cpp", "assertion failed: x > 0\n"+report, 134)
	if res.Stderr != "assertion failed: x > 0\n" || res.Message != "Aborted (core dumped)" {
		t.Errorf("stripped: stderr %q message %q", res.Stderr, res.Message)
	}
	res = run("cpp", "run: line 1:     3 Segmentation fault      (core dumped) LD_LIBRARY_PATH=/usr/local/gcc-9.2.0/lib64 ./a.out", 139)
	if res.Stderr != "" || res.Message != "Segmentation fault (core dumped)" {
		t.Errorf("segfault without trailing newline: %q %q", res.Stderr, res.Message)
	}
	keep := map[string]struct {
		lang, stderr string
		exit         int
	}{
		"exit code does not match the signal": {"cpp", report, 1},
		"not the last line":                   {"cpp", report + "more output\n", 134},
		"different command":                   {"cpp", strings.Replace(report, "./a.out", "./other", 1), 134},
		"other language's command":            {"python", report, 134},
		"unknown signal text":                 {"cpp", strings.Replace(report, "Aborted", "Exploded", 1), 134},
		"program printed something similar":   {"cpp", "run: line 1: oops\n", 134},
	}
	for name, c := range keep {
		if res := run(c.lang, c.stderr, c.exit); res.Stderr != c.stderr {
			t.Errorf("%s: stderr changed to %q", name, res.Stderr)
		}
	}
	// A Python crash with its own command is recognised too.
	res = run("python", "Fatal Python error: Segmentation fault\nrun: line 1:     3 Segmentation fault      (core dumped) /usr/local/python-3.8.1/bin/python3 script.py\n", 139)
	if res.Stderr != "Fatal Python error: Segmentation fault\n" {
		t.Errorf("python: %q", res.Stderr)
	}
}

// runBatch runs ExecuteBatch over n Python requests and returns what onDone
// reported per index, failing the test unless onDone was called exactly once
// for every index.
func runBatch(t *testing.T, e *Engine, n int) ([]judge.ExecResult, []error) {
	t.Helper()
	reqs := make([]judge.ExecRequest, n)
	for i := range reqs {
		reqs[i] = judge.ExecRequest{Language: "python", Source: "x", Stdin: fmt.Sprint(i), TimeLimitMs: 1000, MemoryLimitKb: 65536}
	}
	calls := make([]int, n)
	res := make([]judge.ExecResult, n)
	errs := make([]error, n)
	err := e.ExecuteBatch(context.Background(), reqs, nil, func(i int, r judge.ExecResult, err error) {
		calls[i]++
		res[i], errs[i] = r, err
	})
	if err != nil {
		t.Fatalf("ExecuteBatch: %v", err)
	}
	for i, c := range calls {
		if c != 1 {
			t.Errorf("index %d: onDone called %d times", i, c)
		}
	}
	return res, errs
}

func httpError(w http.ResponseWriter) {
	w.WriteHeader(http.StatusInternalServerError)
	w.Write([]byte(`{"error":"boom"}`))
}

// A failed chunk reports its error for every request it had not reported
// yet; the chunks after it are not started and report judge.ErrNotRun.
func TestBatchFailuresReportEveryIndexOnce(t *testing.T) {
	writeJSON := func(w http.ResponseWriter, v any) { json.NewEncoder(w).Encode(v) }
	done := func(tok string) map[string]any {
		return map[string]any{"token": tok, "status": map[string]any{"id": 3}, "stdout": b64s("ok\n")}
	}
	const notRun = "not run"
	cases := []struct {
		name    string
		create  func(w http.ResponseWriter, call int, subs []map[string]any) bool
		poll    func(w http.ResponseWriter, call int, tokens []string) bool
		want    []string // per index: "" for a result, notRun, or part of the error
		creates int
	}{
		{name: "create fails",
			create:  func(w http.ResponseWriter, _ int, _ []map[string]any) bool { httpError(w); return true },
			want:    []string{"HTTP 500", "HTTP 500", notRun, notRun, notRun},
			creates: 1},
		{name: "second chunk fails",
			create: func(w http.ResponseWriter, call int, _ []map[string]any) bool {
				if call != 2 {
					return false
				}
				httpError(w)
				return true
			},
			want:    []string{"", "", "HTTP 500", "HTTP 500", notRun},
			creates: 2},
		{name: "too few tokens",
			create: func(w http.ResponseWriter, _ int, _ []map[string]any) bool {
				writeJSON(w, []map[string]any{{"token": "only"}})
				return true
			},
			want:    []string{"returned 1 tokens for 2 submissions", "returned 1 tokens for 2 submissions", notRun, notRun, notRun},
			creates: 1},
		{name: "one submission rejected",
			create: func(w http.ResponseWriter, _ int, _ []map[string]any) bool {
				writeJSON(w, []map[string]any{{"token": "accepted"}, {"language_id": []string{"language with id 0 doesn't exist"}}})
				return true
			},
			want:    []string{"rejected", "rejected: {\"language_id\"", notRun, notRun, notRun},
			creates: 1},
		{name: "poll fails",
			poll:    func(w http.ResponseWriter, _ int, _ []string) bool { httpError(w); return true },
			want:    []string{"HTTP 500", "HTTP 500", notRun, notRun, notRun},
			creates: 1},
		{name: "poll fails after one finished",
			poll: func(w http.ResponseWriter, call int, tokens []string) bool {
				if call == 1 {
					writeJSON(w, map[string]any{"submissions": []map[string]any{done(tokens[0]),
						{"token": tokens[1], "status": map[string]any{"id": 2}}}})
					return true
				}
				httpError(w)
				return true
			},
			want:    []string{"", "HTTP 500", notRun, notRun, notRun},
			creates: 1},
		{name: "status count mismatch",
			poll: func(w http.ResponseWriter, _ int, tokens []string) bool {
				writeJSON(w, map[string]any{"submissions": []map[string]any{done(tokens[0])}})
				return true
			},
			want:    []string{"unexpected number of submissions", "unexpected number of submissions", notRun, notRun, notRun},
			creates: 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, srv := newFake(t) // batches of 2
			f.batchCreate, f.batchPoll = c.create, c.poll
			e := newEngine(t, srv.URL, Config{})
			res, errs := runBatch(t, e, len(c.want))
			for i, want := range c.want {
				switch {
				case want == "":
					if errs[i] != nil || res[i].Stdout != "ok\n" {
						t.Errorf("index %d: %+v, %v; want its result", i, res[i], errs[i])
					}
				case want == notRun:
					if !errors.Is(errs[i], judge.ErrNotRun) {
						t.Errorf("index %d: %v, want ErrNotRun", i, errs[i])
					}
				case errs[i] == nil || errors.Is(errs[i], judge.ErrNotRun) || !strings.Contains(errs[i].Error(), want):
					t.Errorf("index %d: %v, want an error containing %q", i, errs[i], want)
				}
			}
			if f.batchCreates != c.creates || f.singles != 0 {
				t.Errorf("%d batches and %d single submissions created, want %d batches", f.batchCreates, f.singles, c.creates)
			}
		})
	}
}

// When the server disables batching (or allows batches of one), ExecuteBatch
// refuses without reporting anything, and the grader falls back to single
// submissions.
func TestBatchingDisabledFallsBackToSingleSubmissions(t *testing.T) {
	for name, conf := range map[string]map[string]any{
		"disabled":      {"max_submission_batch_size": 20, "enable_batched_submissions": false},
		"batch of one":  {"max_submission_batch_size": 1, "enable_batched_submissions": true},
		"size not sent": {},
	} {
		t.Run(name, func(t *testing.T) {
			f, srv := newFake(t)
			f.config = conf
			e := newEngine(t, srv.URL, Config{})
			reqs := []judge.ExecRequest{{Language: "python", Source: "x"}, {Language: "python", Source: "x"}}
			calls := 0
			if err := e.ExecuteBatch(context.Background(), reqs, nil, func(int, judge.ExecResult, error) { calls++ }); err == nil || calls != 0 {
				t.Errorf("ExecuteBatch: %v with %d onDone calls; want an error and none", err, calls)
			}
			exp := "ok\n"
			cs := []grader.Case{{Name: "a", Expected: &exp}, {Name: "b", Expected: &exp}, {Name: "c", Expected: &exp}}
			out := grader.New(e, 2).Grade(context.Background(), grader.Program{Language: "python", Source: "x", TimeLimitMs: 1000, MemoryLimitKb: 65536},
				domain.CompareTokens, cs, nil)
			if out.Verdict != domain.VerdictAccepted || out.Passed != 3 {
				t.Errorf("verdict %s, passed %d/3", out.Verdict, out.Passed)
			}
			if f.batchCreates != 0 || f.singles != 3 {
				t.Errorf("%d batches, %d single submissions; want 0 and 3", f.batchCreates, f.singles)
			}
		})
	}
}

// Without a multi-file program language, Java and Kotlin run with the
// server's own commands and get at least the address space those need; any
// memory limit is capped at the server's max_memory_limit.
func TestMemoryFloorAndCap(t *testing.T) {
	f, srv := newFake(t)
	f.languages = []map[string]any{{"id": 62, "name": "Java (OpenJDK 13.0.1)"}, {"id": 78, "name": "Kotlin (1.3.70)"},
		{"id": 71, "name": "Python (3.8.1)"}}
	f.config = map[string]any{"max_memory_limit": 4000000, "max_wall_time_limit": 60, "max_cpu_time_limit": 30,
		"max_submission_batch_size": 2, "enable_batched_submissions": true}
	e := newEngine(t, srv.URL, Config{})
	f2, srv2 := newFake(t)
	f2.languages = f.languages
	e2 := newEngine(t, srv2.URL, Config{}) // max_memory_limit 8388608
	for _, c := range []struct {
		lang    string
		limitKb int
		fake    *fakeJudge0
		e       *Engine
		want    int
	}{
		{"java", 65536, f2, e2, 6291456},            // floor
		{"kotlin", 65536, f2, e2, 3145728},          // floor
		{"java", 6291456, f2, e2, 6291456 + 524288}, // above the floor: limit + allowance
		{"java", 65536, f, e, 4000000},              // floor, capped
		{"kotlin", 65536, f, e, 3145728},            // floor under the cap
		{"python", 8388608, f2, e2, 8388608},        // limit + allowance, capped
		{"python", 65536, f, e, 65536 + 65536},      // no floor for other languages
	} {
		if _, err := c.e.Execute(context.Background(), judge.ExecRequest{Language: c.lang, Source: "x", TimeLimitMs: 1000, MemoryLimitKb: c.limitKb}); err != nil {
			t.Fatal(err)
		}
		body := c.fake.last()
		if body["memory_limit"] != float64(c.want) || body["additional_files"] != nil || body["source_code"] != b64s("x") {
			t.Errorf("%s with %d KB: memory_limit %v (want %d), request %v", c.lang, c.limitKb, body["memory_limit"], c.want, body)
		}
	}
}
