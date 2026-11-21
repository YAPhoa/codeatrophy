// Package config reads the server configuration from environment variables.
// Every variable is documented in .env.example.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"codeatrophy/internal/domain"
)

// Config is the complete server configuration.
type Config struct {
	Addr    string
	DataDir string
	// DatabaseURL is the PostgreSQL URL; "" selects SQLite at DBPath.
	DatabaseURL string
	// DBPath is the SQLite database: the database itself without
	// DatabaseURL, else the one imported into PostgreSQL once.
	DBPath string
	// SQLiteImport enables that import.
	SQLiteImport bool
	// DBAutoMigrate applies pending schema migrations at startup; without
	// it the server only starts on a database at its schema version.
	DBAutoMigrate  bool
	SecretKey      string
	LogLevel       slog.Level
	LogFormat      string
	AllowedOrigins []string
	// PublicURL is the externally visible base URL, e.g. https://code.example.com.
	PublicURL string
	// AllowedHosts are extra Host header values accepted on /api/ and /mcp.
	AllowedHosts []string

	MaxImportBytes  int64
	MaxSourceBytes  int
	MaxNotesChars   int
	MaxLinksPerItem int
	// MaxGeneratedTestCases and MaxLargeTestCases bound AI generations
	// (domain.Limits).
	MaxGeneratedTestCases int
	MaxLargeTestCases     int

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
	Judge0AuthzToken        string
	Judge0Cgroups           bool
	Judge0MemoryAllowanceKb map[string]int
	Judge0Timeout           time.Duration
}

// AIConfig holds the environment's AI providers: each kind whose values are
// set is offered as a read-only provider next to those saved in the app.
type AIConfig struct {
	Provider string // kind whose environment provider is the initial default, "" for none
	Timeout  time.Duration
	// Workers is how many AI jobs run at once.
	Workers int

	AnthropicAPIKey  string
	AnthropicModel   string
	AnthropicBaseURL string

	GeminiAPIKey  string
	GeminiModel   string
	GeminiBaseURL string

	OpenAIAPIKey  string
	OpenAIModel   string
	OpenAIBaseURL string
}

// MCPConfig configures the MCP endpoint.
type MCPConfig struct {
	Enabled        bool
	Token          string
	AllowedOrigins []string
	MaxSessions    int
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
		Addr:            get("CODEATROPHY_ADDR", ":8080"),
		DataDir:         get("CODEATROPHY_DATA_DIR", "./data"),
		SecretKey:       getenv("CODEATROPHY_SECRET_KEY"),
		LogFormat:       strings.ToLower(get("CODEATROPHY_LOG_FORMAT", "text")),
		AllowedOrigins:  list("CODEATROPHY_ALLOWED_ORIGINS"),
		PublicURL:       strings.TrimRight(get("CODEATROPHY_PUBLIC_URL", ""), "/"),
		AllowedHosts:    list("CODEATROPHY_ALLOWED_HOSTS"),
		MaxImportBytes:  int64(getInt("CODEATROPHY_MAX_IMPORT_BYTES", 50<<20)),
		MaxSourceBytes:  getInt("CODEATROPHY_MAX_SOURCE_BYTES", 64<<10),
		MaxNotesChars:   getInt("CODEATROPHY_MAX_NOTES_CHARS", domain.DefaultMaxNotesChars),
		MaxLinksPerItem: getInt("CODEATROPHY_MAX_LINKS_PER_ITEM", domain.DefaultMaxLinksPerItem),

		MaxGeneratedTestCases: getInt("CODEATROPHY_MAX_GENERATED_TEST_CASES", domain.DefaultMaxGeneratedTestCases),
		MaxLargeTestCases:     getInt("CODEATROPHY_MAX_LARGE_TEST_CASES", domain.DefaultMaxLargeTestCases),
	}
	c.DBPath = get("CODEATROPHY_DB_PATH", filepath.Join(c.DataDir, "codeatrophy.db"))
	// The URL may hold a password: it is never repeated in a message.
	c.DatabaseURL = get("CODEATROPHY_DATABASE_URL", "")
	if c.DatabaseURL != "" {
		if u, err := url.Parse(c.DatabaseURL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
			errs = append(errs, fmt.Errorf("CODEATROPHY_DATABASE_URL: must be a postgres:// or postgresql:// URL, "+
				"or unset for SQLite"))
		}
	}
	onOff := func(key string) bool {
		switch strings.ToLower(get(key, "on")) {
		case "on", "true", "1", "yes":
			return true
		case "off", "false", "0", "no":
			return false
		}
		errs = append(errs, fmt.Errorf("%s: must be on or off", key))
		return true
	}
	c.SQLiteImport = onOff("CODEATROPHY_SQLITE_IMPORT")
	c.DBAutoMigrate = onOff("CODEATROPHY_DB_AUTO_MIGRATE")
	switch strings.ToLower(get("CODEATROPHY_LOG_LEVEL", "info")) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "info":
		c.LogLevel = slog.LevelInfo
	case "warn", "warning":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		errs = append(errs, fmt.Errorf("CODEATROPHY_LOG_LEVEL: must be debug, info, warn or error"))
	}
	if c.LogFormat != "text" && c.LogFormat != "json" {
		errs = append(errs, fmt.Errorf("CODEATROPHY_LOG_FORMAT: must be text or json"))
	}
	if c.PublicURL != "" {
		if u, err := url.Parse(c.PublicURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, fmt.Errorf("CODEATROPHY_PUBLIC_URL: must be an absolute http(s) URL"))
		} else {
			// The public origin may send state-changing requests.
			c.AllowedOrigins = append(c.AllowedOrigins, u.Scheme+"://"+u.Host)
		}
	}
	if c.MaxImportBytes < 1<<10 {
		errs = append(errs, fmt.Errorf("CODEATROPHY_MAX_IMPORT_BYTES: too small"))
	}
	if c.MaxSourceBytes < 1<<10 || c.MaxSourceBytes > 16<<20 {
		errs = append(errs, fmt.Errorf("CODEATROPHY_MAX_SOURCE_BYTES: must be between 1024 and 16777216"))
	}
	if c.MaxNotesChars < 1 || c.MaxNotesChars > domain.MaxNotesCharsCeiling {
		errs = append(errs, fmt.Errorf("CODEATROPHY_MAX_NOTES_CHARS: must be between 1 and %d", domain.MaxNotesCharsCeiling))
	}
	if c.MaxLinksPerItem < 1 || c.MaxLinksPerItem > domain.MaxLinksPerItemCeiling {
		errs = append(errs, fmt.Errorf("CODEATROPHY_MAX_LINKS_PER_ITEM: must be between 1 and %d", domain.MaxLinksPerItemCeiling))
	}
	if c.MaxGeneratedTestCases < 1 || c.MaxGeneratedTestCases > domain.MaxGeneratedTestCasesCeiling {
		errs = append(errs, fmt.Errorf("CODEATROPHY_MAX_GENERATED_TEST_CASES: must be between 1 and %d", domain.MaxGeneratedTestCasesCeiling))
	}
	if c.MaxLargeTestCases < 1 || c.MaxLargeTestCases > domain.MaxLargeTestCasesCeiling {
		errs = append(errs, fmt.Errorf("CODEATROPHY_MAX_LARGE_TEST_CASES: must be between 1 and %d", domain.MaxLargeTestCasesCeiling))
	}

	c.Judge = JudgeConfig{
		Engine:           strings.ToLower(get("CODEATROPHY_JUDGE_ENGINE", "none")),
		Workers:          getInt("CODEATROPHY_JUDGE_WORKERS", 2),
		Concurrency:      getInt("CODEATROPHY_JUDGE_CONCURRENCY", 4),
		Judge0URL:        get("CODEATROPHY_JUDGE0_URL", "http://judge0-server:2358"),
		Judge0AuthToken:  getenv("CODEATROPHY_JUDGE0_AUTH_TOKEN"),
		Judge0AuthzToken: strings.TrimSpace(getenv("CODEATROPHY_JUDGE0_AUTHZ_TOKEN")),
		Judge0Cgroups:    getBool("CODEATROPHY_JUDGE0_CGROUPS", false),
		Judge0Timeout:    getDur("CODEATROPHY_JUDGE0_TIMEOUT", 5*time.Minute),
	}
	if c.Judge.Engine != "none" && c.Judge.Engine != "judge0" {
		errs = append(errs, fmt.Errorf("CODEATROPHY_JUDGE_ENGINE: must be none or judge0"))
	}
	if c.Judge.Workers < 1 || c.Judge.Concurrency < 1 {
		errs = append(errs, fmt.Errorf("CODEATROPHY_JUDGE_WORKERS and CODEATROPHY_JUDGE_CONCURRENCY must be at least 1"))
	}
	if v := get("CODEATROPHY_JUDGE0_MEMORY_ALLOWANCES", ""); v != "" {
		m, err := parseIntMap(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("CODEATROPHY_JUDGE0_MEMORY_ALLOWANCES: %w", err))
		}
		c.Judge.Judge0MemoryAllowanceKb = m
	}

	c.AI = AIConfig{
		Provider:         strings.ToLower(get("CODEATROPHY_AI_PROVIDER", "")),
		Timeout:          getDur("CODEATROPHY_AI_TIMEOUT", 5*time.Minute),
		Workers:          getInt("CODEATROPHY_AI_WORKERS", 2),
		AnthropicAPIKey:  get("CODEATROPHY_ANTHROPIC_API_KEY", get("ANTHROPIC_API_KEY", "")),
		AnthropicModel:   get("CODEATROPHY_ANTHROPIC_MODEL", ""),
		AnthropicBaseURL: get("CODEATROPHY_ANTHROPIC_BASE_URL", ""),
		GeminiAPIKey:     get("CODEATROPHY_GEMINI_API_KEY", get("GEMINI_API_KEY", "")),
		GeminiModel:      get("CODEATROPHY_GEMINI_MODEL", ""),
		GeminiBaseURL:    get("CODEATROPHY_GEMINI_BASE_URL", ""),
		OpenAIAPIKey:     get("CODEATROPHY_OPENAI_API_KEY", get("OPENAI_API_KEY", "")),
		OpenAIModel:      get("CODEATROPHY_OPENAI_MODEL", ""),
		OpenAIBaseURL:    get("CODEATROPHY_OPENAI_BASE_URL", ""),
	}
	switch c.AI.Provider {
	case "", "none", "anthropic", "gemini", "openai_compatible":
	default:
		errs = append(errs, fmt.Errorf("CODEATROPHY_AI_PROVIDER: must be anthropic, gemini, openai_compatible or none"))
	}
	if c.AI.Provider == "none" {
		c.AI.Provider = ""
	}
	if c.AI.Workers < 1 {
		errs = append(errs, fmt.Errorf("CODEATROPHY_AI_WORKERS must be at least 1"))
	}

	c.MCP = MCPConfig{
		Enabled:        getBool("CODEATROPHY_MCP_ENABLED", true),
		Token:          getenv("CODEATROPHY_MCP_TOKEN"),
		AllowedOrigins: list("CODEATROPHY_MCP_ALLOWED_ORIGINS"),
		MaxSessions:    getInt("CODEATROPHY_MCP_MAX_SESSIONS", 100),
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

// HostAllowList is every Host header value the server accepts besides
// loopback: the hosts of the public URL and of the allowed origins, and the
// explicitly allowed hosts.
func (c Config) HostAllowList() []string {
	var out []string
	add := func(raw string) {
		if u, err := url.Parse(raw); err == nil && u.Hostname() != "" {
			out = append(out, strings.ToLower(u.Hostname()))
		}
	}
	if c.PublicURL != "" {
		add(c.PublicURL)
	}
	for _, o := range append(append([]string{}, c.AllowedOrigins...), c.MCP.AllowedOrigins...) {
		add(o)
	}
	for _, h := range c.AllowedHosts {
		h = strings.ToLower(strings.TrimSpace(h))
		if host, _, err := net.SplitHostPort(h); err == nil {
			h = host
		}
		out = append(out, strings.Trim(h, "[]"))
	}
	return dedupe(out)
}

// dedupe drops repeated values, keeping the first occurrence.
func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := in[:0]
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
