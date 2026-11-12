package judge0

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codeathropy/internal/judge"
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
	case r.URL.Path == "/languages/78":
		writeJSON(map[string]any{"compile_cmd": "/usr/local/kotlin-1.3.70/bin/kotlinc %s Main.kt", "run_cmd": "/usr/local/kotlin-1.3.70/bin/kotlin MainKt"})
	case r.URL.Path == "/config_info":
		writeJSON(map[string]any{"max_memory_limit": 8388608, "max_wall_time_limit": 60, "max_cpu_time_limit": 30,
			"max_submission_batch_size": 2, "enable_batched_submissions": true})
	case r.URL.Path == "/submissions" && r.Method == http.MethodPost:
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		writeJSON(map[string]any{"token": f.add(body)})
	case r.URL.Path == "/submissions/batch" && r.Method == http.MethodPost:
		var body struct {
			Submissions []map[string]any `json:"submissions"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		var out []map[string]any
		for _, s := range body.Submissions {
			out = append(out, map[string]any{"token": f.add(s)})
		}
		writeJSON(out)
	case r.URL.Path == "/submissions/batch" && r.Method == http.MethodGet:
		var subs []map[string]any
		for _, tok := range strings.Split(r.URL.Query().Get("tokens"), ",") {
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
	if res.Status != judge.StatusInternalError || !strings.Contains(res.Message, "CODEATHROPY_JUDGE0_CGROUPS") {
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
	res, err := e.ExecuteBatch(context.Background(), reqs)
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
