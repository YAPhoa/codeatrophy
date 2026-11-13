// Command codeatrophy runs the Codeatrophy server: the web UI, the HTTP API
// and the MCP endpoint.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/ai/anthropic"
	"codeatrophy/internal/ai/openaicompat"
	"codeatrophy/internal/app"
	"codeatrophy/internal/config"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/httpapi"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/judge/judge0"
	"codeatrophy/internal/mcpserver"
	"codeatrophy/internal/secrets"
	"codeatrophy/internal/store/dbopen"
	"codeatrophy/internal/webui"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0"

const usage = `Usage: codeatrophy [command]

Commands:
  serve        Run the server (default)
  db           Inspect, migrate or copy a database; run "codeatrophy db help"
  healthcheck  Exit 0 if the server at CODEATROPHY_ADDR answers, 1 otherwise
  version      Print the version

Configuration is read from CODEATROPHY_* environment variables; see .env.example.
`

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve()
	case "healthcheck":
		err = healthcheck()
	case "db":
		err = dbCommand(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "codeatrophy:", err)
		os.Exit(1)
	}
}

func newLogger(cfg config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, opts))
}

func serve() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	log := newLogger(cfg)
	slog.SetDefault(log)
	restrictUmask()

	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return fmt.Errorf("data directory: %w", err)
	}
	key, keySource, err := secrets.LoadKey(cfg.SecretKey, cfg.DataDir)
	if err != nil {
		return err
	}
	box, err := secrets.NewBox(key)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := dbopen.Open(ctx, dbopen.Config{DatabaseURL: cfg.DatabaseURL, SQLitePath: cfg.DBPath,
		SQLiteImport: cfg.SQLiteImport, ManualMigration: !cfg.DBAutoMigrate, Logger: log})
	if err != nil {
		return err
	}
	defer db.Close()

	var engine judge.Engine
	if cfg.Judge.Engine == "judge0" {
		engine, err = judge0.New(judge0.Config{
			URL:               cfg.Judge.Judge0URL,
			AuthToken:         cfg.Judge.Judge0AuthToken,
			UseCgroups:        cfg.Judge.Judge0Cgroups,
			MemoryAllowanceKb: cfg.Judge.Judge0MemoryAllowanceKb,
			Timeout:           cfg.Judge.Judge0Timeout,
		})
		if err != nil {
			return err
		}
	}

	anthropicModel := anthropic.DefaultModel
	a := app.New(app.Options{
		Store:  db,
		Engine: engine,
		Providers: map[string]ai.Factory{
			ai.ProviderAnthropic:        anthropic.New,
			ai.ProviderOpenAICompatible: openaicompat.New,
		},
		ProviderDefaults: map[string]app.ProviderDefaults{
			ai.ProviderAnthropic:        {Model: &anthropicModel, BaseURL: anthropic.DefaultBaseURL},
			ai.ProviderOpenAICompatible: {BaseURL: openaicompat.DefaultBaseURL},
		},
		Secrets: box,
		AIEnv: app.AIEnv{
			Provider:         cfg.AI.Provider,
			AnthropicAPIKey:  cfg.AI.AnthropicAPIKey,
			AnthropicModel:   cfg.AI.AnthropicModel,
			AnthropicBaseURL: cfg.AI.AnthropicBaseURL,
			OpenAIAPIKey:     cfg.AI.OpenAIAPIKey,
			OpenAIModel:      cfg.AI.OpenAIModel,
			OpenAIBaseURL:    cfg.AI.OpenAIBaseURL,
			Timeout:          cfg.AI.Timeout,
		},
		Limits:           domain.Limits{MaxImportBytes: cfg.MaxImportBytes, MaxSourceBytes: cfg.MaxSourceBytes},
		JudgeWorkers:     cfg.Judge.Workers,
		JudgeConcurrency: cfg.Judge.Concurrency,
		Version:          version,
		MCP: app.MCPInfo{Enabled: cfg.MCP.Enabled, Path: "/mcp", AuthRequired: cfg.MCP.Token != "",
			PublicURL: cfg.PublicURL},
		Logger: log,
	})
	if err := a.Start(ctx); err != nil {
		return err
	}
	defer a.Stop()

	hosts := cfg.HostAllowList()
	var mcpHandler http.Handler
	if cfg.MCP.Enabled {
		mcpOrigins := append(append([]string{}, cfg.AllowedOrigins...), cfg.MCP.AllowedOrigins...)
		mcpHandler = mcpserver.Handler(mcpserver.Options{
			App: a, Logger: log, Token: cfg.MCP.Token, MaxSessions: cfg.MCP.MaxSessions,
			OriginAllowed: func(r *http.Request) bool { return httpapi.OriginAllowed(r, mcpOrigins, hosts) },
		})
	}
	handler := httpapi.New(httpapi.Options{
		App: a, Logger: log, AllowedOrigins: cfg.AllowedOrigins, AllowedHosts: hosts,
		MCP: mcpHandler, MCPPath: "/mcp", Web: webui.Handler(),
	})
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return err
	}
	log.Info("codeatrophy started", "version", version, "addr", ln.Addr().String(), "data", cfg.DataDir,
		"secretKey", keySource, "database", db.Backend(), "judge", cfg.Judge.Engine, "mcp", cfg.MCP.Enabled,
		"ui", webui.Built())

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Warn("shutdown", "error", err)
		}
	}
	return nil
}

// healthcheck requests /api/v1/meta from the local server.
func healthcheck() error {
	addr := os.Getenv("CODEATROPHY_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequest(http.MethodGet, "http://"+net.JoinHostPort(strings.Trim(host, "[]"), port)+httpapi.Prefix+"/meta", nil)
	if err != nil {
		return err
	}
	// Whatever address the server listens on, the probe comes from inside
	// the container: name it as loopback so the Host allow-list accepts it.
	req.Host = net.JoinHostPort("localhost", port)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}
