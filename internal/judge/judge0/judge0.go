// Package judge0 implements judge.Engine on top of a Judge0 server
// (https://github.com/judge0/judge0) reached over its REST API.
//
// # Per-process mode
//
// Judge0's sandbox (isolate 1.x) can only use control groups on hosts with
// cgroup v1. By default the adapter therefore asks Judge0 for per-process
// time and memory limits, which do not involve cgroups. In that mode:
//
//   - The memory limit is an address-space limit (RLIMIT_AS). Runtimes that
//     reserve large virtual ranges need more than the item's limit to start
//     at all, so the adapter adds a per-language allowance. For languages
//     whose resident set is a fair measure of the program's own usage, the
//     item's limit is then enforced on the reported peak RSS instead.
//   - Java and Kotlin are run as Judge0 "multi-file programs" with explicit
//     JVM flags (-Xmx set to the item's limit, one active processor, small
//     reserved ranges); as shipped they need several GB of address space.
//   - Only the wall-clock limit stops a running program; the CPU limit is
//     checked after it exits. The wall limit is kept close to the CPU limit.
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
	"log/slog"
	"math"
	"net/http"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/judge"
)

// Config configures the adapter.
type Config struct {
	// URL is the Judge0 base URL, e.g. http://judge0-server:2358.
	URL string
	// AuthToken is sent as X-Auth-Token when non-empty.
	AuthToken string
	// AuthzToken is Judge0's authorization token (AUTHZ_TOKEN), sent as
	// X-Auth-User to delete each submission once its result is read. Empty
	// means submissions are left in Judge0.
	AuthzToken string
	// Logger receives failures to delete submissions; nil discards them.
	Logger *slog.Logger
	// UseCgroups asks Judge0 for cgroup-based time and memory accounting.
	// This only works on hosts that provide cgroup v1.
	UseCgroups bool
	// MemoryAllowanceKb overrides the per-language address-space allowance
	// added to the item's memory limit in per-process mode.
	MemoryAllowanceKb map[string]int
	// Timeout bounds one execution including queueing. Default 5 minutes.
	Timeout time.Duration
	// PollInterval is the maximum interval between result polls.
	PollInterval time.Duration
	// HTTPClient is used for requests; nil means a client with sane timeouts.
	HTTPClient *http.Client
}

// DefaultMemoryAllowanceKb is the address space added to the item's memory
// limit per language in per-process mode, determined empirically against
// Judge0 1.13.1.
var DefaultMemoryAllowanceKb = map[string]int{
	"c":          65536,
	"cpp":        65536,
	"rust":       65536,
	"python":     65536,
	"go":         131072,
	"ruby":       131072,
	"csharp":     131072,
	"javascript": 786432,
	"typescript": 786432,
	"java":       524288, // multi-file program with -Xmx = item limit
	"kotlin":     524288,
}

// rssEnforced lists languages whose peak RSS is checked against the item's
// memory limit in per-process mode. Managed runtimes with a large fixed
// footprint are limited by their heap settings or allocation failures
// instead.
var rssEnforced = map[string]bool{
	"c": true, "cpp": true, "rust": true, "python": true, "go": true, "ruby": true,
}

// jvmFallbackFloorKb is used for Java and Kotlin when the server offers no
// multi-file program language: the shipped commands need this much address
// space.
var jvmFallbackFloorKb = map[string]int{"java": 6291456, "kotlin": 3145728}

// Engine is a Judge0-backed judge.Engine.
type Engine struct {
	cfg    Config
	client *http.Client
	log    *slog.Logger

	clean     cleaner
	cleanOnce sync.Once

	mu    sync.Mutex
	cat   *catalog
	catAt time.Time
}

// catalog is what the adapter learns from the server.
type catalog struct {
	langs     []judge.Language
	ids       map[string]int    // canonical id -> Judge0 language id
	multiFile int               // id of "Multi-file program", 0 if absent
	binDirs   map[string]string // java/kotlin -> directory of the compiler
	runCmds   map[string]string // canonical id -> Judge0 run command
	maxFileKb int               // server's MAX_MAX_FILE_SIZE, 0 if unknown
	// extractKb is the largest file Judge0 extracts from a multi-file
	// program's archive (MAX_EXTRACT_SIZE); a larger Main.java is not
	// extracted and the program fails with a confusing exit status 127.
	extractKb int
	javaBin   string // directory of the java launcher
	maxMemKb  int
	maxWall   float64
	maxCPU    float64
	maxBatch  int
	// deleteAllowed is false when the server reports that deleting
	// submissions is disabled (ENABLE_SUBMISSION_DELETE).
	deleteAllowed bool
}

var (
	_ judge.BatchEngine   = (*Engine)(nil)
	_ judge.SourceLimiter = (*Engine)(nil)
	_ judge.SourceNamer   = (*Engine)(nil)
)

// New returns a Judge0 engine.
func New(cfg Config) (*Engine, error) {
	if cfg.URL == "" {
		return nil, errors.New("judge0: URL is required")
	}
	cfg.URL = strings.TrimRight(cfg.URL, "/")
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Minute
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 250 * time.Millisecond
	}
	allow := map[string]int{}
	for k, v := range DefaultMemoryAllowanceKb {
		allow[k] = v
	}
	for k, v := range cfg.MemoryAllowanceKb {
		allow[k] = v
	}
	cfg.MemoryAllowanceKb = allow
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Engine{cfg: cfg, client: client, log: log,
		clean: cleaner{queue: make(chan cleanupJob, cleanupQueue), backoff: defaultBackoff}}, nil
}

// Name implements judge.Engine.
func (e *Engine) Name() string { return "judge0" }

// Health implements judge.Engine.
func (e *Engine) Health(ctx context.Context) error {
	var about map[string]any
	return e.do(ctx, http.MethodGet, "/about", nil, &about)
}

// languagePatterns maps Judge0 language names to canonical ids. When several
// Judge0 languages match, the one with the highest Judge0 id (the newest
// toolchain) wins.
var languagePatterns = []struct {
	id string
	re *regexp.Regexp
}{
	{"c", regexp.MustCompile(`^C \(GCC `)},
	{"cpp", regexp.MustCompile(`^C\+\+ \(GCC `)},
	{"csharp", regexp.MustCompile(`^C# \(Mono `)},
	{"go", regexp.MustCompile(`^Go \(`)},
	{"java", regexp.MustCompile(`^Java \(OpenJDK `)},
	{"javascript", regexp.MustCompile(`^JavaScript \(Node\.js `)},
	{"kotlin", regexp.MustCompile(`^Kotlin \(`)},
	{"python", regexp.MustCompile(`^Python \(3\.`)},
	{"ruby", regexp.MustCompile(`^Ruby \(`)},
	{"rust", regexp.MustCompile(`^Rust \(`)},
	{"typescript", regexp.MustCompile(`^TypeScript \(`)},
}

var (
	versionRe   = regexp.MustCompile(`\(([^)]*)\)\s*$`)
	multiFileRe = regexp.MustCompile(`^Multi-file program`)
)

// displayName is the name of a language id, as the app writes it.
func displayName(id string) string {
	l, _ := domain.LookupLanguage(id)
	return l.Name
}

// Languages implements judge.Engine.
func (e *Engine) Languages(ctx context.Context) ([]judge.Language, error) {
	c, err := e.catalog(ctx)
	if err != nil {
		return nil, err
	}
	return append([]judge.Language(nil), c.langs...), nil
}

func (e *Engine) catalog(ctx context.Context) (*catalog, error) {
	e.mu.Lock()
	if e.cat != nil && time.Since(e.catAt) < 10*time.Minute {
		c := e.cat
		e.mu.Unlock()
		return c, nil
	}
	e.mu.Unlock()

	var list []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	}
	if err := e.do(ctx, http.MethodGet, "/languages", nil, &list); err != nil {
		return nil, err
	}
	c := &catalog{ids: map[string]int{}, binDirs: map[string]string{}, runCmds: map[string]string{},
		maxWall: 20, maxCPU: 15, maxBatch: 20, extractKb: defaultExtractKb, deleteAllowed: true}
	names := map[string]string{}
	for _, l := range list {
		if multiFileRe.MatchString(l.Name) {
			c.multiFile = l.ID
		}
		for _, p := range languagePatterns {
			if p.re.MatchString(l.Name) && l.ID > c.ids[p.id] {
				c.ids[p.id] = l.ID
				names[p.id] = l.Name
			}
		}
	}
	for _, p := range languagePatterns {
		if _, ok := c.ids[p.id]; !ok {
			continue
		}
		version := ""
		if m := versionRe.FindStringSubmatch(names[p.id]); m != nil {
			version = m[1]
		}
		c.langs = append(c.langs, judge.Language{ID: p.id, Name: displayName(p.id), Version: version})
	}

	var conf struct {
		MaxMemoryLimit         float64 `json:"max_memory_limit"`
		MaxWallTimeLimit       float64 `json:"max_wall_time_limit"`
		MaxCPUTimeLimit        float64 `json:"max_cpu_time_limit"`
		MaxSubmissionBatchSize int     `json:"max_submission_batch_size"`
		MaxMaxFileSize         int     `json:"max_max_file_size"`
		MaxExtractSize         int     `json:"max_extract_size"`
		EnableBatched          *bool   `json:"enable_batched_submissions"`
		EnableDelete           *bool   `json:"enable_submission_delete"`
	}
	if err := e.do(ctx, http.MethodGet, "/config_info", nil, &conf); err == nil {
		c.maxMemKb = int(conf.MaxMemoryLimit)
		if conf.MaxWallTimeLimit > 0 {
			c.maxWall = conf.MaxWallTimeLimit
		}
		if conf.MaxCPUTimeLimit > 0 {
			c.maxCPU = conf.MaxCPUTimeLimit
		}
		c.maxBatch = conf.MaxSubmissionBatchSize
		c.maxFileKb = conf.MaxMaxFileSize
		if conf.MaxExtractSize > 0 {
			c.extractKb = conf.MaxExtractSize
		}
		if conf.EnableBatched != nil && !*conf.EnableBatched {
			c.maxBatch = 0
		}
		if conf.EnableDelete != nil && !*conf.EnableDelete {
			c.deleteAllowed = false
			if e.cfg.AuthzToken != "" && !e.clean.offWarned.Swap(true) {
				e.log.Warn("judge0: the server does not allow deleting submissions (ENABLE_SUBMISSION_DELETE); " +
					"every run stays in Judge0's database")
			}
		}
	}

	// Each language's run command is needed to recognise the shell's
	// crash report in stderr. Java and Kotlin also run as multi-file
	// programs with explicit JVM flags; the toolchain locations come from
	// the server's own commands.
	for _, p := range languagePatterns {
		id, ok := c.ids[p.id]
		if !ok {
			continue
		}
		var detail struct {
			CompileCmd string `json:"compile_cmd"`
			RunCmd     string `json:"run_cmd"`
		}
		if err := e.do(ctx, http.MethodGet, "/languages/"+strconv.Itoa(id), nil, &detail); err != nil {
			continue
		}
		c.runCmds[p.id] = detail.RunCmd
		lang := p.id
		if (lang == "java" || lang == "kotlin") && !e.cfg.UseCgroups && c.multiFile != 0 {
			if f := strings.Fields(detail.CompileCmd); len(f) > 0 && strings.HasPrefix(f[0], "/") {
				c.binDirs[lang] = path.Dir(f[0])
			}
			if lang == "java" {
				if f := strings.Fields(detail.RunCmd); len(f) > 0 && strings.HasPrefix(f[0], "/") {
					c.javaBin = path.Dir(f[0])
				}
			}
		}
	}
	if c.javaBin == "" {
		c.javaBin = c.binDirs["java"]
	}

	e.mu.Lock()
	e.cat, e.catAt = c, time.Now()
	e.mu.Unlock()
	return c, nil
}

type submissionRequest struct {
	SourceCode       string  `json:"source_code,omitempty"`
	AdditionalFiles  string  `json:"additional_files,omitempty"`
	LanguageID       int     `json:"language_id"`
	Stdin            string  `json:"stdin"`
	CPUTimeLimit     float64 `json:"cpu_time_limit"`
	CPUExtraTime     float64 `json:"cpu_extra_time"`
	WallTimeLimit    float64 `json:"wall_time_limit"`
	MemoryLimit      int     `json:"memory_limit"`
	PerProcessTime   bool    `json:"enable_per_process_and_thread_time_limit"`
	PerProcessMemory bool    `json:"enable_per_process_and_thread_memory_limit"`
	RedirectStderr   bool    `json:"redirect_stderr_to_stdout"`
	EnableNetwork    bool    `json:"enable_network"`
	MaxFileSize      int     `json:"max_file_size,omitempty"`
}

type submissionStatus struct {
	ID          int    `json:"id"`
	Description string `json:"description"`
}

type submissionResponse struct {
	Token         string           `json:"token"`
	Stdout        *string          `json:"stdout"`
	Stderr        *string          `json:"stderr"`
	CompileOutput *string          `json:"compile_output"`
	Message       *string          `json:"message"`
	Status        submissionStatus `json:"status"`
	Time          *string          `json:"time"`
	WallTime      *string          `json:"wall_time"`
	Memory        *float64         `json:"memory"`
	ExitCode      *int             `json:"exit_code"`
	ExitSignal    *int             `json:"exit_signal"`
}

const resultFields = "token,stdout,stderr,compile_output,message,status,time,wall_time,memory,exit_code,exit_signal"

// slowStart lists runtimes whose start-up takes a noticeable share of a
// second of wall time.
var slowStart = map[string]bool{"java": true, "kotlin": true, "csharp": true, "javascript": true, "typescript": true}

const jvmFlags = "-XX:ActiveProcessorCount=1 -XX:+UseSerialGC -XX:CompressedClassSpaceSize=64m -XX:ReservedCodeCacheSize=32m"

func (e *Engine) buildRequest(c *catalog, req judge.ExecRequest) (submissionRequest, error) {
	langID, ok := c.ids[req.Language]
	if !ok {
		return submissionRequest{}, judge.ErrUnsupportedLanguage
	}
	cpu := float64(req.TimeLimitMs) / 1000
	if cpu <= 0 {
		cpu = 2
	}
	cpu = math.Min(cpu, c.maxCPU)
	wall := cpu + 1
	if slowStart[req.Language] {
		wall++
	}
	wall = math.Min(wall, c.maxWall)
	out := submissionRequest{
		SourceCode:       b64(req.Source),
		LanguageID:       langID,
		Stdin:            b64(req.Stdin),
		CPUTimeLimit:     cpu,
		CPUExtraTime:     0.5,
		WallTimeLimit:    wall,
		MemoryLimit:      req.MemoryLimitKb,
		PerProcessTime:   !e.cfg.UseCgroups,
		PerProcessMemory: !e.cfg.UseCgroups,
		MaxFileSize:      maxOutputKb(c),
	}
	if e.cfg.UseCgroups {
		return e.capMemory(c, out), nil
	}
	out.MemoryLimit = req.MemoryLimitKb + e.cfg.MemoryAllowanceKb[req.Language]
	if req.Language == "java" || req.Language == "kotlin" {
		if e.usesMultiFile(c, req.Language) {
			if len(req.Source) > c.extractKb*1024 {
				return out, fmt.Errorf("judge0: the program is %d bytes; Judge0 runs %s programs of at most %d bytes",
					len(req.Source), displayName(req.Language), c.extractKb*1024)
			}
			files, err := jvmProject(c, req)
			if err != nil {
				return out, err
			}
			out.SourceCode = ""
			out.AdditionalFiles = files
			out.LanguageID = c.multiFile
		} else if floor := jvmFallbackFloorKb[req.Language]; out.MemoryLimit < floor {
			out.MemoryLimit = floor
		}
	}
	return e.capMemory(c, out), nil
}

func (e *Engine) capMemory(c *catalog, r submissionRequest) submissionRequest {
	if c.maxMemKb > 0 && r.MemoryLimit > c.maxMemKb {
		r.MemoryLimit = c.maxMemKb
	}
	return r
}

// defaultExtractKb is Judge0's default MAX_EXTRACT_SIZE, for servers that do
// not report it.
const defaultExtractKb = 10240

// MaxSourceBytes implements judge.SourceLimiter. Judge0 takes a single-file
// program of any size the request can carry (40 MB were accepted in
// testing), but the source of a multi-file program (Java and Kotlin in
// per-process mode) is a file in its archive, which Judge0 extracts only up
// to MAX_EXTRACT_SIZE.
func (e *Engine) MaxSourceBytes(ctx context.Context, language string) (int, error) {
	c, err := e.catalog(ctx)
	if err != nil {
		return 0, err
	}
	if e.usesMultiFile(c, language) {
		return c.extractKb * 1024, nil
	}
	return 0, nil
}

// sourceNames are the names under which Judge0 1.13's toolchains report the
// program's own file. TypeScript runtime errors refer to the compiled
// script.js, whose lines are not the source's, so only script.ts is listed.
var sourceNames = map[string][]string{
	"c": {"main.c"}, "cpp": {"main.cpp"}, "csharp": {"Main.cs"}, "go": {"main.go", "./main.go", "/box/main.go"},
	"java": {"Main.java"}, "javascript": {"script.js", "/box/script.js"}, "kotlin": {"Main.kt"},
	"python": {"script.py"}, "ruby": {"script.rb"}, "rust": {"main.rs"}, "typescript": {"script.ts"},
}

// SourceNames implements judge.SourceNamer.
func (e *Engine) SourceNames(language string) []string { return sourceNames[language] }

// maxOutputKb is the largest output file a program may write, sized so that
// an output as large as the largest expected output (plus headroom) fits,
// within the server's ceiling.
func maxOutputKb(c *catalog) int {
	kb := domain.MaxTestCaseBytes/1024 + 1024
	if c.maxFileKb > 0 && kb > c.maxFileKb {
		kb = c.maxFileKb
	}
	return kb
}

// usesMultiFile reports whether a request runs as a multi-file program.
func (e *Engine) usesMultiFile(c *catalog, lang string) bool {
	return !e.cfg.UseCgroups && (lang == "java" || lang == "kotlin") && c.multiFile != 0 &&
		c.binDirs[lang] != "" && c.javaBin != ""
}

func jvmRunLine(c *catalog, req judge.ExecRequest) string {
	run := fmt.Sprintf("%s/java %s -Xmx%dk", c.javaBin, jvmFlags, req.MemoryLimitKb)
	if req.Language == "kotlin" {
		return run + " -jar main.jar"
	}
	return run + " Main"
}

// runCommand is the command line Judge0's run script executes for req.
func (e *Engine) runCommand(c *catalog, req judge.ExecRequest) string {
	if e.usesMultiFile(c, req.Language) {
		return jvmRunLine(c, req)
	}
	return c.runCmds[req.Language]
}

// jvmProject builds the multi-file program archive for Java or Kotlin.
func jvmProject(c *catalog, req judge.ExecRequest) (string, error) {
	run := strings.TrimSuffix(strings.TrimSuffix(jvmRunLine(c, req), " Main"), " -jar main.jar")
	files := map[string]string{}
	switch req.Language {
	case "java":
		files["Main.java"] = req.Source
		files["compile"] = fmt.Sprintf("%s/javac %s Main.java\n", c.binDirs["java"],
			"-J"+strings.ReplaceAll(jvmFlags, " ", " -J")+" -J-Xmx512m")
		files["run"] = run + " Main\n"
	case "kotlin":
		files["Main.kt"] = req.Source
		files["compile"] = fmt.Sprintf("JAVA_OPTS=\"%s -Xmx768m\" %s/kotlinc Main.kt -include-runtime -d main.jar\n",
			jvmFlags, c.binDirs["kotlin"])
		files["run"] = run + " -jar main.jar\n"
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{"Main.java", "Main.kt", "compile", "run"} {
		content, ok := files[name]
		if !ok {
			continue
		}
		w, err := zw.Create(name)
		if err != nil {
			return "", err
		}
		if _, err := io.WriteString(w, content); err != nil {
			return "", err
		}
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// Execute implements judge.Engine.
func (e *Engine) Execute(ctx context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
	ctx, cancel := context.WithTimeout(ctx, e.cfg.Timeout)
	defer cancel()
	c, err := e.catalog(ctx)
	if err != nil {
		return judge.ExecResult{}, err
	}
	body, err := e.buildRequest(c, req)
	if err != nil {
		return judge.ExecResult{}, err
	}
	var created submissionResponse
	if err := e.do(ctx, http.MethodPost, "/submissions?base64_encoded=true&wait=false", body, &created); err != nil {
		return judge.ExecResult{}, err
	}
	if created.Token == "" {
		return judge.ExecResult{}, errors.New("judge0: no submission token in response")
	}
	p := "/submissions/" + created.Token + "?base64_encoded=true&fields=" + resultFields
	delay := 100 * time.Millisecond
	for {
		if err := sleep(ctx, delay); err != nil {
			e.forget(created.Token) // deleted once it finishes
			return judge.ExecResult{}, err
		}
		var res submissionResponse
		if err := e.do(ctx, http.MethodGet, p, nil, &res); err != nil {
			e.forget(created.Token)
			return judge.ExecResult{}, err
		}
		if res.Status.ID > 2 {
			e.forget(created.Token)
			return e.convert(req, res), nil
		}
		delay = min(delay*2, e.cfg.PollInterval)
	}
}

// ExecuteBatch implements judge.BatchEngine using Judge0's batch endpoints.
// Chunks run one after the other; the adapter's Timeout applies to each
// chunk, counted from its creation, just as it applies to one single
// execution. Results are reported as they finish. After a chunk fails, or
// when continueFn says so, no further chunks are started.
func (e *Engine) ExecuteBatch(ctx context.Context, reqs []judge.ExecRequest, continueFn func() bool,
	onDone func(i int, r judge.ExecResult, err error)) error {
	c, err := e.catalog(ctx)
	if err != nil {
		return err
	}
	if c.maxBatch <= 1 {
		return errors.New("judge0: batched submissions are disabled")
	}
	ok := true
	for start := 0; start < len(reqs); start += c.maxBatch {
		end := min(start+c.maxBatch, len(reqs))
		if !ok || (continueFn != nil && !continueFn()) {
			for i := start; i < end; i++ {
				onDone(i, judge.ExecResult{}, judge.ErrNotRun)
			}
			continue
		}
		ok = e.executeChunk(ctx, c, reqs[start:end], func(i int, r judge.ExecResult, err error) { onDone(start+i, r, err) })
	}
	return nil
}

// executeChunk runs one batch and reports every request through onDone. It
// returns false if the engine failed for any of them.
func (e *Engine) executeChunk(ctx context.Context, c *catalog, reqs []judge.ExecRequest,
	onDone func(i int, r judge.ExecResult, err error)) bool {
	ctx, cancel := context.WithTimeout(ctx, e.cfg.Timeout)
	defer cancel()
	reported := make([]bool, len(reqs))
	failRest := func(err error) bool {
		for i := range reqs {
			if !reported[i] {
				reported[i] = true
				onDone(i, judge.ExecResult{}, err)
			}
		}
		return false
	}
	bodies := make([]submissionRequest, len(reqs))
	for i, r := range reqs {
		b, err := e.buildRequest(c, r)
		if err != nil {
			return failRest(err)
		}
		bodies[i] = b
	}
	var created []map[string]any
	if err := e.do(ctx, http.MethodPost, "/submissions/batch?base64_encoded=true",
		map[string]any{"submissions": bodies}, &created); err != nil {
		return failRest(err)
	}
	if len(created) != len(reqs) {
		for _, cr := range created {
			tok, _ := cr["token"].(string)
			e.forget(tok)
		}
		return failRest(fmt.Errorf("judge0: batch returned %d tokens for %d submissions", len(created), len(reqs)))
	}
	tokens := make([]string, len(created))
	for i, cr := range created {
		tokens[i], _ = cr["token"].(string)
	}
	// abandon gives up on the runs not reported yet: they are deleted once
	// they finish.
	abandon := func(err error) bool {
		for i := range reqs {
			if !reported[i] {
				e.forget(tokens[i])
			}
		}
		return failRest(err)
	}
	for _, cr := range created {
		if tok, _ := cr["token"].(string); tok == "" {
			b, _ := json.Marshal(cr)
			return abandon(fmt.Errorf("judge0: batch submission rejected: %s", truncate(string(b), 300)))
		}
	}
	pending := len(reqs)
	delay := 100 * time.Millisecond
	for pending > 0 {
		if err := sleep(ctx, delay); err != nil {
			return abandon(err)
		}
		var want []string
		var idx []int
		for i := range reqs {
			if !reported[i] {
				want = append(want, tokens[i])
				idx = append(idx, i)
			}
		}
		var got struct {
			Submissions []submissionResponse `json:"submissions"`
		}
		if err := e.do(ctx, http.MethodGet, "/submissions/batch?base64_encoded=true&tokens="+strings.Join(want, ",")+
			"&fields="+resultFields, nil, &got); err != nil {
			return abandon(err)
		}
		if len(got.Submissions) != len(want) {
			return abandon(errors.New("judge0: batch status returned an unexpected number of submissions"))
		}
		for j, s := range got.Submissions {
			if s.Status.ID > 2 {
				i := idx[j]
				reported[i] = true
				pending--
				e.forget(tokens[i])
				onDone(i, e.convert(reqs[i], s), nil)
			}
		}
		delay = min(delay*2, e.cfg.PollInterval)
	}
	return true
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return fmt.Errorf("judge0: waiting for result: %w", ctx.Err())
	case <-t.C:
		return nil
	}
}

// Judge0 status ids.
const (
	statusAccepted     = 3
	statusWrongAnswer  = 4
	statusTimeLimit    = 5
	statusCompileError = 6
	statusInternal     = 13
)

func parseSeconds(p *string) *int {
	if p == nil {
		return nil
	}
	s, err := strconv.ParseFloat(*p, 64)
	if err != nil {
		return nil
	}
	ms := int(math.Round(s * 1000))
	return &ms
}

func (e *Engine) convert(req judge.ExecRequest, r submissionResponse) judge.ExecResult {
	out := judge.ExecResult{
		Stdout:        unb64(r.Stdout),
		Stderr:        unb64(r.Stderr),
		CompileOutput: unb64(r.CompileOutput),
		Message:       strings.TrimSpace(unb64(r.Message)),
		ExitCode:      r.ExitCode,
		TimeMs:        parseSeconds(r.Time),
	}
	if r.Memory != nil {
		kb := int(*r.Memory)
		out.MemoryKb = &kb
	}
	switch id := r.Status.ID; id {
	case statusAccepted, statusWrongAnswer:
		out.Status = judge.StatusOK
	case statusTimeLimit:
		out.Status = judge.StatusTimeLimit
		// A program killed on the wall clock may report no CPU time.
		if wall := parseSeconds(r.WallTime); wall != nil && (out.TimeMs == nil || *out.TimeMs < *wall) {
			out.TimeMs = wall
		}
	case statusCompileError:
		out.Status = judge.StatusCompileError
	case statusInternal:
		out.Status = judge.StatusInternalError
		if out.Message == "" {
			out.Message = r.Status.Description
		}
		if e.cfg.UseCgroups {
			out.Message += " (cgroup accounting needs a cgroup v1 host; set CODEATROPHY_JUDGE0_CGROUPS=false on cgroup v2 hosts)"
		}
	default: // runtime errors: 7-12 (signals, non-zero exit), 14 exec format error
		out.Status = judge.StatusRuntimeError
		if out.Message == "" {
			out.Message = r.Status.Description
		}
		e.stripShellReport(req, &out)
		if hasMemoryMarker(out) {
			out.Status = judge.StatusMemoryLimit
		}
	}
	// In per-process mode the sandbox limit includes an allowance, so the
	// item's own limit is enforced on the peak RSS where that is meaningful.
	if !e.cfg.UseCgroups && rssEnforced[req.Language] && out.MemoryKb != nil && req.MemoryLimitKb > 0 &&
		*out.MemoryKb > req.MemoryLimitKb && (out.Status == judge.StatusOK || out.Status == judge.StatusRuntimeError) {
		out.Status = judge.StatusMemoryLimit
	}
	return out
}

// memoryMarkers are runtime messages that indicate a failed allocation.
// Judge0 has no memory-limit status under per-process limits, so allocation
// failures are recognised from the program's output.
var memoryMarkers = []string{
	"MemoryError",                    // Python
	"std::bad_alloc",                 // C++
	"java.lang.OutOfMemoryError",     // Java, Kotlin
	"OutOfMemoryException",           // C#
	"failed to allocate memory",      // Ruby
	"memory allocation of",           // Rust: "memory allocation of N bytes failed"
	"fatal error: out of memory",     // Go
	"runtime: out of memory",         // Go
	"JavaScript heap out of memory",  // Node
	"Fatal process OOM",              // Node
	"Could not reserve enough space", // JVM start-up
	"unable to create native thread", // JVM
	"Cannot allocate memory",
}

func hasMemoryMarker(r judge.ExecResult) bool {
	text := r.Stderr + "\n" + r.Stdout
	for _, m := range memoryMarkers {
		if strings.Contains(text, m) {
			return true
		}
	}
	return false
}

// do performs a JSON request and decodes the response into out.
func (e *Engine) do(ctx context.Context, method, p string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := e.newRequest(ctx, method, p, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return fmt.Errorf("judge0: %s %s: %w", method, stripQuery(p), unwrapURLError(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return fmt.Errorf("judge0: reading response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("judge0: %s %s: HTTP %d: %s", method, stripQuery(p), resp.StatusCode,
			truncate(strings.TrimSpace(string(data)), 300))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("judge0: decoding response: %w", err)
	}
	return nil
}

// newRequest builds a request to the server with the authentication header.
func (e *Engine) newRequest(ctx context.Context, method, p string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, e.cfg.URL+p, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if e.cfg.AuthToken != "" {
		req.Header.Set("X-Auth-Token", e.cfg.AuthToken)
	}
	return req, nil
}

func httpStatusError(code int, body []byte) error {
	return fmt.Errorf("HTTP %d: %s", code, truncate(strings.TrimSpace(string(body)), 300))
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func stripQuery(p string) string {
	if i := strings.IndexByte(p, '?'); i >= 0 {
		return p[:i]
	}
	return p
}

func unwrapURLError(err error) error {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) {
		if inner := ue.Unwrap(); inner != nil {
			return inner
		}
	}
	return err
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func unb64(p *string) string {
	if p == nil {
		return ""
	}
	// Judge0 wraps base64 output in lines.
	clean := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, *p)
	b, err := base64.StdEncoding.DecodeString(clean)
	if err != nil {
		return *p
	}
	return string(b)
}

// Crash reports. Judge0 runs programs from a bash script named "run"; when
// the program dies from a signal, bash appends a job report such as
//
//	run: line 1:     3 Aborted                 (core dumped) LD_LIBRARY_PATH=/usr/local/gcc-9.2.0/lib64 ./a.out
//
// to stderr. It is noise to the user and leaks sandbox paths, so it is
// removed, but only when every check passes: it is the last line; it has
// exactly bash's form; the signal it names matches the exit code (128+N);
// and the command is the language's own run command. Anything else is left
// untouched. The signal description moves to Message.

var signalNames = map[string]int{
	"Hangup": 1, "Quit": 3, "Illegal instruction": 4, "Trace/breakpoint trap": 5, "Aborted": 6, "Bus error": 7,
	"Floating point exception": 8, "Killed": 9, "User defined signal 1": 10, "Segmentation fault": 11,
	"User defined signal 2": 12, "Alarm clock": 14, "Terminated": 15, "CPU time limit exceeded": 24,
	"File size limit exceeded": 25, "Bad system call": 31,
}

var shellReportRe = func() *regexp.Regexp {
	names := make([]string, 0, len(signalNames))
	for n := range signalNames {
		names = append(names, regexp.QuoteMeta(n))
	}
	slices.Sort(names)
	return regexp.MustCompile(`^run: line [0-9]+: +[0-9]+ (` + strings.Join(names, "|") + `)( +\(core dumped\))? +(\S.*)$`)
}()

func (e *Engine) stripShellReport(req judge.ExecRequest, out *judge.ExecResult) {
	e.mu.Lock()
	c := e.cat
	e.mu.Unlock()
	if c == nil || out.ExitCode == nil {
		return
	}
	cmd := e.runCommand(c, req)
	if cmd == "" {
		return
	}
	body := strings.TrimSuffix(out.Stderr, "\n")
	last := body
	prefix := ""
	if i := strings.LastIndexByte(body, '\n'); i >= 0 {
		prefix, last = body[:i+1], body[i+1:]
	}
	m := shellReportRe.FindStringSubmatch(last)
	if m == nil {
		return
	}
	sig, ok := signalNames[m[1]]
	if !ok || *out.ExitCode != 128+sig {
		return
	}
	if strings.Join(strings.Fields(m[3]), " ") != strings.Join(strings.Fields(cmd), " ") {
		return
	}
	out.Stderr = prefix
	out.Message = m[1]
	if m[2] != "" {
		out.Message += " (core dumped)"
	}
}
