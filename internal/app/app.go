// Package app holds the application services: the transport-independent use
// cases shared by the HTTP API and the MCP server. Validation, defaults,
// side effects and concurrency checks live here.
package app

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/grader"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store"
)

// AIEnv are AI provider values supplied by the environment. Values saved in
// settings take precedence.
type AIEnv struct {
	Provider         string
	AnthropicAPIKey  string
	AnthropicModel   string
	AnthropicBaseURL string
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
	Secrets          *secrets.Box
	AIEnv            AIEnv
	Limits           domain.Limits
	JudgeWorkers     int
	JudgeConcurrency int
	Version          string
	MCP              MCPInfo
	Logger           *slog.Logger
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
	secrets   *secrets.Box
	aiEnv     AIEnv
	limits    domain.Limits
	version   string
	mcp       MCPInfo
	log       *slog.Logger
	now       func() time.Time

	workers        int
	healthInterval time.Duration
	queue          chan string
	stop           chan struct{}
	wg             sync.WaitGroup
	ctx            context.Context
	cancel         context.CancelFunc

	judgeMu      sync.Mutex
	judgeHealthy bool
	judgeLangs   []judge.Language
	judgeChecked time.Time
}

// New builds the application. Call Start to run background work.
func New(opts Options) *App {
	a := &App{
		store:          opts.Store,
		engine:         opts.Engine,
		providers:      opts.Providers,
		defaults:       opts.ProviderDefaults,
		secrets:        opts.Secrets,
		aiEnv:          opts.AIEnv,
		limits:         opts.Limits,
		version:        opts.Version,
		mcp:            opts.MCP,
		log:            opts.Logger,
		now:            opts.Now,
		workers:        opts.JudgeWorkers,
		healthInterval: opts.HealthInterval,
		queue:          make(chan string, 4096),
		stop:           make(chan struct{}),
	}
	if a.log == nil {
		a.log = slog.New(slog.DiscardHandler)
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
	if a.limits.MaxImportBytes == 0 {
		a.limits.MaxImportBytes = 50 << 20
	}
	if a.version == "" {
		a.version = "dev"
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

// Start recovers submissions interrupted by a previous process, starts the
// judging workers and the engine health probe.
func (a *App) Start(ctx context.Context) error {
	if err := a.recoverSubmissions(ctx); err != nil {
		return err
	}
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
	a.wg.Wait()
}

func (a *App) clock() time.Time { return a.now().UTC().Truncate(time.Second) }

func newID() string { return uuid.Must(uuid.NewV7()).String() }
