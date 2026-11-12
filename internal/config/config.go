// Package config reads the server configuration from environment variables.
// Every variable is documented in .env.example.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config is the complete server configuration.
type Config struct {
	Addr           string
	DataDir        string
	DBPath         string
	SecretKey      string
	LogLevel       slog.Level
	LogFormat      string
	AllowedOrigins []string
	// PublicURL is the externally visible base URL, e.g. https://code.example.com.
	PublicURL string

	MaxImportBytes int64
	MaxSourceBytes int

	Judge JudgeConfig
	AI    AIConfig
	MCP   MCPConfig
}

// JudgeConfig selects and configures the judge engine.
type JudgeConfig struct {
	Engine      string // "none" or "judge0"
	Workers     int
	Concurrency int

	Judge0URL               string
	Judge0AuthToken         string
	Judge0Cgroups           bool
	Judge0MemoryAllowanceKb map[string]int
	Judge0Timeout           time.Duration
}

// AIConfig holds environment defaults for AI providers. Values saved in the
// app's settings take precedence.
type AIConfig struct {
	Provider string // default active provider, "" for none
	Timeout  time.Duration

	AnthropicAPIKey  string
	AnthropicModel   string
	AnthropicBaseURL string

	OpenAIAPIKey  string
	OpenAIModel   string
	OpenAIBaseURL string
}

// MCPConfig configures the MCP endpoint.
type MCPConfig struct {
	Enabled        bool
	Token          string
	AllowedOrigins []string
}

// Load reads the configuration from the environment.
func Load() (Config, error) { return LoadFrom(os.Getenv) }

// LoadFrom reads the configuration using getenv.
func LoadFrom(getenv func(string) string) (Config, error) {
	var errs []error
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	getInt := func(key string, def int) int {
		v := get(key, "")
		if v == "" {
			return def
		}
		n, err := strconv.Atoi(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: not an integer: %q", key, v))
			return def
		}
		return n
	}
	getBool := func(key string, def bool) bool {
		v := get(key, "")
		if v == "" {
			return def
		}
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: not a boolean: %q", key, v))
			return def
		}
		return b
	}
	getDur := func(key string, def time.Duration) time.Duration {
		v := get(key, "")
		if v == "" {
			return def
		}
		d, err := time.ParseDuration(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: not a duration: %q", key, v))
			return def
		}
		return d
	}
	list := func(key string) []string {
		var out []string
		for _, s := range strings.Split(get(key, ""), ",") {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, strings.TrimRight(s, "/"))
			}
		}
		return out
	}

	c := Config{
		Addr:           get("CODEATHROPY_ADDR", ":8080"),
		DataDir:        get("CODEATHROPY_DATA_DIR", "./data"),
		SecretKey:      getenv("CODEATHROPY_SECRET_KEY"),
		LogFormat:      strings.ToLower(get("CODEATHROPY_LOG_FORMAT", "text")),
		AllowedOrigins: list("CODEATHROPY_ALLOWED_ORIGINS"),
		PublicURL:      strings.TrimRight(get("CODEATHROPY_PUBLIC_URL", ""), "/"),
		MaxImportBytes: int64(getInt("CODEATHROPY_MAX_IMPORT_BYTES", 50<<20)),
		MaxSourceBytes: getInt("CODEATHROPY_MAX_SOURCE_BYTES", 64<<10),
	}
	c.DBPath = get("CODEATHROPY_DB_PATH", filepath.Join(c.DataDir, "codeathropy.db"))
	switch strings.ToLower(get("CODEATHROPY_LOG_LEVEL", "info")) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "info":
		c.LogLevel = slog.LevelInfo
	case "warn", "warning":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		errs = append(errs, fmt.Errorf("CODEATHROPY_LOG_LEVEL: must be debug, info, warn or error"))
	}
	if c.LogFormat != "text" && c.LogFormat != "json" {
		errs = append(errs, fmt.Errorf("CODEATHROPY_LOG_FORMAT: must be text or json"))
	}
	if c.PublicURL != "" {
		if u, err := url.Parse(c.PublicURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, fmt.Errorf("CODEATHROPY_PUBLIC_URL: must be an absolute http(s) URL"))
		} else {
			// The public origin may send state-changing requests.
			c.AllowedOrigins = append(c.AllowedOrigins, u.Scheme+"://"+u.Host)
		}
	}
	if c.MaxImportBytes < 1<<10 {
		errs = append(errs, fmt.Errorf("CODEATHROPY_MAX_IMPORT_BYTES: too small"))
	}
	if c.MaxSourceBytes < 1<<10 || c.MaxSourceBytes > 16<<20 {
		errs = append(errs, fmt.Errorf("CODEATHROPY_MAX_SOURCE_BYTES: must be between 1024 and 16777216"))
	}

	c.Judge = JudgeConfig{
		Engine:          strings.ToLower(get("CODEATHROPY_JUDGE_ENGINE", "none")),
		Workers:         getInt("CODEATHROPY_JUDGE_WORKERS", 2),
		Concurrency:     getInt("CODEATHROPY_JUDGE_CONCURRENCY", 4),
		Judge0URL:       get("CODEATHROPY_JUDGE0_URL", "http://judge0-server:2358"),
		Judge0AuthToken: getenv("CODEATHROPY_JUDGE0_AUTH_TOKEN"),
		Judge0Cgroups:   getBool("CODEATHROPY_JUDGE0_CGROUPS", false),
		Judge0Timeout:   getDur("CODEATHROPY_JUDGE0_TIMEOUT", 5*time.Minute),
	}
	if c.Judge.Engine != "none" && c.Judge.Engine != "judge0" {
		errs = append(errs, fmt.Errorf("CODEATHROPY_JUDGE_ENGINE: must be none or judge0"))
	}
	if c.Judge.Workers < 1 || c.Judge.Concurrency < 1 {
		errs = append(errs, fmt.Errorf("CODEATHROPY_JUDGE_WORKERS and CODEATHROPY_JUDGE_CONCURRENCY must be at least 1"))
	}
	if v := get("CODEATHROPY_JUDGE0_MEMORY_ALLOWANCES", ""); v != "" {
		m, err := parseIntMap(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("CODEATHROPY_JUDGE0_MEMORY_ALLOWANCES: %w", err))
		}
		c.Judge.Judge0MemoryAllowanceKb = m
	}

	c.AI = AIConfig{
		Provider:         strings.ToLower(get("CODEATHROPY_AI_PROVIDER", "")),
		Timeout:          getDur("CODEATHROPY_AI_TIMEOUT", 5*time.Minute),
		AnthropicAPIKey:  get("CODEATHROPY_ANTHROPIC_API_KEY", get("ANTHROPIC_API_KEY", "")),
		AnthropicModel:   get("CODEATHROPY_ANTHROPIC_MODEL", ""),
		AnthropicBaseURL: get("CODEATHROPY_ANTHROPIC_BASE_URL", ""),
		OpenAIAPIKey:     get("CODEATHROPY_OPENAI_API_KEY", get("OPENAI_API_KEY", "")),
		OpenAIModel:      get("CODEATHROPY_OPENAI_MODEL", ""),
		OpenAIBaseURL:    get("CODEATHROPY_OPENAI_BASE_URL", ""),
	}
	if p := c.AI.Provider; p != "" && p != "none" && p != "anthropic" && p != "openai_compatible" {
		errs = append(errs, fmt.Errorf("CODEATHROPY_AI_PROVIDER: must be anthropic, openai_compatible or none"))
	}
	if c.AI.Provider == "none" {
		c.AI.Provider = ""
	}

	c.MCP = MCPConfig{
		Enabled:        getBool("CODEATHROPY_MCP_ENABLED", true),
		Token:          getenv("CODEATHROPY_MCP_TOKEN"),
		AllowedOrigins: list("CODEATHROPY_MCP_ALLOWED_ORIGINS"),
	}
	return c, errors.Join(errs...)
}

func parseIntMap(s string) (map[string]int, error) {
	out := map[string]int{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			return nil, fmt.Errorf("expected language=kilobytes, got %q", part)
		}
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 0 {
			return nil, fmt.Errorf("bad value in %q", part)
		}
		out[strings.TrimSpace(k)] = n
	}
	return out, nil
}
