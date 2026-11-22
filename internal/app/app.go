// Package app holds the application services: the transport-independent use
// cases shared by the HTTP API and the MCP server. Validation, defaults,
// side effects and concurrency checks live here.
package app

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/jobqueue"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store"
)

// AIEnv are AI provider values supplied by the environment. Each kind whose
// values are set becomes a read-only environment provider; they never fill
// in fields of saved providers.
type AIEnv struct {
	// Provider is the kind whose environment provider is the default until
	// a default is saved, or "".
	Provider         string
	AnthropicAPIKey  string
	AnthropicModel   string
	AnthropicBaseURL string
	GeminiAPIKey     string
	GeminiModel      string
	GeminiBaseURL    string
	OpenAIAPIKey     string
	OpenAIModel      string
	OpenAIBaseURL    string
	Timeout          time.Duration
}

// MCPInfo describes the MCP endpoint for the meta endpoint.
type MCPInfo struct {
	Enabled      bool
	Path         string
	AuthRequired bool
	// PublicURL is the server's public base URL, if configured.
	PublicURL string
}

// Options configure the application.
type Options struct {
	Store  store.Store
	Engine judge.Engine // nil when no judge engine is configured
	// Providers maps provider ids to constructors.
	Providers map[string]ai.Factory
	// ProviderDefaults are the default model and base URL per provider.
	ProviderDefaults map[string]ProviderDefaults
	// ProviderClient is the HTTP client providers are constructed with;
	// nil means one with the default ai.EgressPolicy.
	ProviderClient   *http.Client
	Secrets          *secrets.Box
	AIEnv            AIEnv
	Limits           domain.Limits
	JudgeWorkers     int
	JudgeConcurrency int
	// AIWorkers is how many AI jobs run at once (default 2).
	AIWorkers int
	// AIQueue schedules AI jobs; nil means an in-process queue with
	// AIWorkers workers.
	AIQueue jobqueue.Queue
	Version string
	MCP     MCPInfo
	// Auth configures sign-in to the web UI and the HTTP API.
	Auth   AuthOptions
	Logger *slog.Logger
	// Now returns the current time; tests may override it.
	Now func() time.Time
	// HealthInterval is how often the judge engine is probed.
	HealthInterval time.Duration
}

// App is the application service layer.
type App struct {
	store     store.Store
	engine    judge.Engine
	grader    *grader.Grader
	providers map[string]ai.Factory
	defaults  map[string]ProviderDefaults
	client    *http.Client
	secrets   *secrets.Box
	aiEnv     AIEnv
	limits    domain.Limits
	version   string
	mcp       MCPInfo
	authOpts  AuthOptions
	authState authState
	log       *slog.Logger
	now       func() time.Time

	workers        int
	healthInterval time.Duration
	queue          chan string
	stop           chan struct{}
	wg             sync.WaitGroup
	ctx            context.Context
	cancel         context.CancelFunc

	aiQueue jobqueue.Queue
	// completions are the steps that run, per job kind, in the transaction
	// that finishes a job (see finishJob).
	completions map[string]func(tx store.Tx, j *store.AIJob) error

	judgeMu      sync.Mutex
	judgeHealthy bool
	judgeLangs   []judge.Language
	judgeChecked time.Time

	// dbDown is whether the last readiness check found the database down,
	// so that only a change is logged (see Ready).
	dbDown atomic.Bool
}

// New builds the application. Call Start to run background work.
func New(opts Options) *App {
	a := &App{
		store:          opts.Store,
		engine:         opts.Engine,
		providers:      opts.Providers,
		defaults:       opts.ProviderDefaults,
		client:         opts.ProviderClient,
		secrets:        opts.Secrets,
		aiEnv:          opts.AIEnv,
		limits:         opts.Limits,
		version:        opts.Version,
		mcp:            opts.MCP,
		authOpts:       opts.Auth,
		log:            opts.Logger,
		now:            opts.Now,
		workers:        opts.JudgeWorkers,
		healthInterval: opts.HealthInterval,
		queue:          make(chan string, 4096),
		stop:           make(chan struct{}),
		aiQueue:        opts.AIQueue,
	}
	if a.aiQueue == nil {
		workers := opts.AIWorkers
		if workers <= 0 {
			workers = 2
		}
		a.aiQueue = jobqueue.NewLocal(workers)
	}
	// A draft's generation writes its outcome into the draft.
	a.completions = map[string]func(store.Tx, *store.AIJob) error{
		JobDraft:   a.completeDraftJob,
		JobVariant: a.completeDraftJob,
	}
	if a.log == nil {
		a.log = slog.New(slog.DiscardHandler)
	}
	if a.client == nil {
		a.client, _ = ai.NewHTTPClient(ai.EgressPolicy{}) // cannot fail without an allow list
	}
	if a.now == nil {
		a.now = time.Now
	}
	if a.workers <= 0 {
		a.workers = 2
	}
	if a.healthInterval <= 0 {
		a.healthInterval = 15 * time.Second
	}
	if a.providers == nil {
		a.providers = map[string]ai.Factory{}
	}
	if a.defaults == nil {
		a.defaults = map[string]ProviderDefaults{}
	}
	if a.limits.MaxSourceBytes == 0 {
		a.limits.MaxSourceBytes = 64 << 10
	}
	if a.limits.MaxNotesChars == 0 {
		a.limits.MaxNotesChars = domain.DefaultMaxNotesChars
	}
	if a.limits.MaxLinksPerItem == 0 {
		a.limits.MaxLinksPerItem = domain.DefaultMaxLinksPerItem
	}
	if a.limits.MaxGeneratedTestCases == 0 {
		a.limits.MaxGeneratedTestCases = domain.DefaultMaxGeneratedTestCases
	}
	if a.limits.MaxLargeTestCases == 0 {
		a.limits.MaxLargeTestCases = domain.DefaultMaxLargeTestCases
	}
	if a.limits.MaxImportBytes == 0 {
		a.limits.MaxImportBytes = 50 << 20
	}
	if a.version == "" {
		a.version = "dev"
	}
	if a.authOpts.SessionTTL <= 0 {
		a.authOpts.SessionTTL = DefaultSessionTTL
	}
	if a.engine != nil {
		a.grader = grader.New(a.engine, opts.JudgeConcurrency)
	}
	a.ctx, a.cancel = context.WithCancel(context.Background())
	return a
}

// Version returns the server version.
func (a *App) Version() string { return a.version }

// Limits returns the instance limits.
func (a *App) Limits() domain.Limits { return a.limits }

// Start carries settings of earlier versions over, recovers submissions
// and AI jobs interrupted by a previous process, starts the judging
// workers, the AI queue and the engine health probe.
func (a *App) Start(ctx context.Context) error {
	if err := a.migrateLegacyAISettings(ctx); err != nil {
		return err
	}
	if err := a.checkSetupAtStart(ctx); err != nil {
		return err
	}
	if err := a.recoverSubmissions(ctx); err != nil {
		return err
	}
	queued, err := a.recoverAIJobs(ctx)
	if err != nil {
		return err
	}
	a.aiQueue.Start(a.ctx, a.runJob)
	for _, id := range queued {
		a.aiQueue.Push(id)
	}
	a.wg.Add(1)
	go a.pruneJobsLoop()
	for range a.workers {
		a.wg.Add(1)
		go a.worker()
	}
	if a.engine != nil {
		a.wg.Add(1)
		go a.healthLoop()
	}
	return nil
}

// Stop stops background work and waits for running judgements to finish
// or be cancelled.
func (a *App) Stop() {
	select {
	case <-a.stop:
		return
	default:
	}
	close(a.stop)
	a.cancel()
	a.aiQueue.Stop()
	a.wg.Wait()
}

func (a *App) clock() time.Time { return a.now().UTC().Truncate(time.Second) }

func newID() string { return uuid.Must(uuid.NewV7()).String() }
