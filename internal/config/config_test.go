package config

import (
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDefaults(t *testing.T) {
	c, err := LoadFrom(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != "127.0.0.1:8484" || c.DataDir != "./data" || c.DBPath != "data/codeatrophy.db" || c.LogLevel != slog.LevelInfo ||
		c.MaxImportBytes != 52428800 || c.MaxSourceBytes != 65536 || c.MaxNotesChars != 4000 || c.MaxLinksPerItem != 30 ||
		c.MaxGeneratedTestCases != 30 || c.MaxLargeTestCases != 5 || c.Judge.Engine != "none" || c.Judge.Judge0Cgroups ||
		!c.MCP.Enabled || c.AI.Timeout != 5*time.Minute || c.PublicURL != "" || c.AI.Provider != "" || c.AI.Workers != 2 {
		t.Errorf("defaults: %+v", c)
	}
}

// The binary listens on loopback unless told otherwise; the container sets
// :8484 to listen on all its interfaces.
func TestAddr(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{"CODEATROPHY_ADDR": ":8484"}))
	if err != nil || c.Addr != ":8484" {
		t.Errorf("addr %q, %v", c.Addr, err)
	}
}

func TestConventionalKeyFallbacks(t *testing.T) {
	c, _ := LoadFrom(env(map[string]string{"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "o", "GEMINI_API_KEY": "g"}))
	if c.AI.AnthropicAPIKey != "a" || c.AI.OpenAIAPIKey != "o" || c.AI.GeminiAPIKey != "g" {
		t.Errorf("fallbacks: %+v", c.AI)
	}
	c, _ = LoadFrom(env(map[string]string{"ANTHROPIC_API_KEY": "a", "CODEATROPHY_ANTHROPIC_API_KEY": "b",
		"GEMINI_API_KEY": "g", "CODEATROPHY_GEMINI_API_KEY": "h"}))
	if c.AI.AnthropicAPIKey != "b" || c.AI.GeminiAPIKey != "h" {
		t.Error("the prefixed variable wins")
	}
}

func TestParsing(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{
		"CODEATROPHY_JUDGE_ENGINE": "Judge0", "CODEATROPHY_JUDGE0_CGROUPS": "true",
		"CODEATROPHY_JUDGE0_MEMORY_ALLOWANCES": "java=1048576, go=262144",
		"CODEATROPHY_MCP_ALLOWED_ORIGINS":      "https://a.example/, https://b.example",
		"CODEATROPHY_AI_PROVIDER":              "none",
		"CODEATROPHY_AI_WORKERS":               "3",
		"CODEATROPHY_JUDGE0_AUTHZ_TOKEN":       "authz",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Judge.Engine != "judge0" || !c.Judge.Judge0Cgroups || c.Judge.Judge0MemoryAllowanceKb["go"] != 262144 ||
		len(c.MCP.AllowedOrigins) != 2 || c.MCP.AllowedOrigins[0] != "https://a.example" || c.AI.Provider != "" ||
		c.AI.Workers != 3 || c.Judge.Judge0AuthzToken != "authz" {
		t.Errorf("parsed: %+v", c)
	}
	for k, v := range map[string]string{
		"CODEATROPHY_JUDGE_ENGINE": "docker", "CODEATROPHY_LOG_LEVEL": "loud", "CODEATROPHY_MCP_ENABLED": "maybe",
		"CODEATROPHY_JUDGE0_TIMEOUT": "soon", "CODEATROPHY_AI_PROVIDER": "mistral", "CODEATROPHY_JUDGE0_MEMORY_ALLOWANCES": "java",
		"CODEATROPHY_MAX_SOURCE_BYTES": "10", "CODEATROPHY_AI_WORKERS": "0",
		"CODEATROPHY_MAX_NOTES_CHARS": "0",
	} {
		if _, err := LoadFrom(env(map[string]string{k: v})); err == nil {
			t.Errorf("%s=%s should be rejected", k, v)
		}
	}
	if c, err := LoadFrom(env(map[string]string{"CODEATROPHY_MAX_NOTES_CHARS": "100000"})); err != nil || c.MaxNotesChars != 100000 {
		t.Errorf("notes limit: %d %v", c.MaxNotesChars, err)
	}
	if _, err := LoadFrom(env(map[string]string{"CODEATROPHY_MAX_NOTES_CHARS": "100001"})); err == nil {
		t.Error("a notes limit above 100000 should be rejected")
	}
}

func TestLinkLimit(t *testing.T) {
	for _, v := range []string{"1", "12", "50"} {
		c, err := LoadFrom(env(map[string]string{"CODEATROPHY_MAX_LINKS_PER_ITEM": v}))
		if err != nil || fmt.Sprint(c.MaxLinksPerItem) != v {
			t.Errorf("link limit %s: %d %v", v, c.MaxLinksPerItem, err)
		}
	}
	for _, v := range []string{"0", "51", "-3", "many", "30.5"} {
		_, err := LoadFrom(env(map[string]string{"CODEATROPHY_MAX_LINKS_PER_ITEM": v}))
		if err == nil || !strings.Contains(err.Error(), "CODEATROPHY_MAX_LINKS_PER_ITEM") {
			t.Errorf("a link limit of %q should be rejected naming the variable: %v", v, err)
		}
	}
}

func TestGenerationLimits(t *testing.T) {
	for name, c := range map[string]struct {
		good, bad []string
		got       func(Config) int
	}{
		"CODEATROPHY_MAX_GENERATED_TEST_CASES": {[]string{"1", "12", "100"}, []string{"0", "101", "-3", "many", "30.5"},
			func(c Config) int { return c.MaxGeneratedTestCases }},
		"CODEATROPHY_MAX_LARGE_TEST_CASES": {[]string{"1", "7", "20"}, []string{"0", "21", "-1", "x", "2.5"},
			func(c Config) int { return c.MaxLargeTestCases }},
	} {
		for _, v := range c.good {
			cfg, err := LoadFrom(env(map[string]string{name: v}))
			if err != nil || fmt.Sprint(c.got(cfg)) != v {
				t.Errorf("%s=%s: %d %v", name, v, c.got(cfg), err)
			}
		}
		for _, v := range c.bad {
			_, err := LoadFrom(env(map[string]string{name: v}))
			if err == nil || !strings.Contains(err.Error(), name) {
				t.Errorf("%s=%q should be rejected naming the variable: %v", name, v, err)
			}
		}
	}
}

func TestGeminiEnvironmentProvider(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{
		"CODEATROPHY_AI_PROVIDER": "Gemini", "CODEATROPHY_GEMINI_API_KEY": "AIza-key",
		"CODEATROPHY_GEMINI_MODEL": "gemini-3.5-flash", "CODEATROPHY_GEMINI_BASE_URL": "https://gemini.example/v1beta",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if a := c.AI; a.Provider != "gemini" || a.GeminiAPIKey != "AIza-key" || a.GeminiModel != "gemini-3.5-flash" ||
		a.GeminiBaseURL != "https://gemini.example/v1beta" {
		t.Errorf("gemini: %+v", a)
	}
	_, err = LoadFrom(env(map[string]string{"CODEATROPHY_AI_PROVIDER": "mistral"}))
	if err == nil || !strings.Contains(err.Error(), "anthropic, gemini, openai_compatible or none") {
		t.Errorf("unknown provider: %v", err)
	}
}

func TestPublicURL(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{"CODEATROPHY_PUBLIC_URL": "https://code.example.com/"}))
	if err != nil || c.PublicURL != "https://code.example.com" || c.AllowedOrigins[0] != "https://code.example.com" {
		t.Errorf("public URL: %+v %v", c, err)
	}
	if _, err := LoadFrom(env(map[string]string{"CODEATROPHY_PUBLIC_URL": "code.example.com"})); err == nil {
		t.Error("a relative public URL should be rejected")
	}
}

// The Host allow-list is the public URL's host, the hosts of the allowed
// origins, and CODEATROPHY_ALLOWED_HOSTS (ports and brackets dropped).
func TestHostAllowList(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{
		"CODEATROPHY_PUBLIC_URL":          "https://Code.Example.com:8443/",
		"CODEATROPHY_ALLOWED_ORIGINS":     "http://dev.example:5173",
		"CODEATROPHY_MCP_ALLOWED_ORIGINS": "https://mcp.example",
		"CODEATROPHY_ALLOWED_HOSTS":       "nas.local, 192.168.1.20:8484, [fd00::1]",
		"CODEATROPHY_MCP_MAX_SESSIONS":    "7",
	}))
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(c.HostAllowList(), ",")
	if got != "code.example.com,dev.example,mcp.example,nas.local,192.168.1.20,fd00::1" || c.MCP.MaxSessions != 7 {
		t.Errorf("allow-list %s, max sessions %d", got, c.MCP.MaxSessions)
	}
	if d, _ := LoadFrom(env(nil)); len(d.HostAllowList()) != 0 || d.MCP.MaxSessions != 100 {
		t.Errorf("defaults: %v %d", d.HostAllowList(), d.MCP.MaxSessions)
	}
}

func TestDatabase(t *testing.T) {
	c, err := LoadFrom(env(nil))
	if err != nil || c.DatabaseURL != "" || !c.SQLiteImport {
		t.Errorf("defaults: %q %v %v", c.DatabaseURL, c.SQLiteImport, err)
	}
	for _, u := range []string{"postgres://u:p@db:5432/x?sslmode=disable", "postgresql://db/x"} {
		c, err := LoadFrom(env(map[string]string{"CODEATROPHY_DATABASE_URL": u, "CODEATROPHY_SQLITE_IMPORT": "off"}))
		if err != nil || c.DatabaseURL != u || c.SQLiteImport {
			t.Errorf("%s: %+v %v", u, c, err)
		}
	}
	for _, u := range []string{"mysql://u:s3cret@db/x", "/data/codeatrophy.db", "postgres://u:s3cret@db:port/x"} {
		_, err := LoadFrom(env(map[string]string{"CODEATROPHY_DATABASE_URL": u}))
		if err == nil || !strings.Contains(err.Error(), "CODEATROPHY_DATABASE_URL") || strings.Contains(err.Error(), "s3cret") {
			t.Errorf("%s: %v", u, err)
		}
	}
	if _, err := LoadFrom(env(map[string]string{"CODEATROPHY_SQLITE_IMPORT": "maybe"})); err == nil {
		t.Error("a bad CODEATROPHY_SQLITE_IMPORT was accepted")
	}
	if !c.DBAutoMigrate {
		t.Error("automatic migration is on by default")
	}
	if c, err := LoadFrom(env(map[string]string{"CODEATROPHY_DB_AUTO_MIGRATE": "OFF"})); err != nil || c.DBAutoMigrate {
		t.Errorf("CODEATROPHY_DB_AUTO_MIGRATE=OFF: %v %v", c.DBAutoMigrate, err)
	}
	if _, err := LoadFrom(env(map[string]string{"CODEATROPHY_DB_AUTO_MIGRATE": "later"})); err == nil ||
		!strings.Contains(err.Error(), "CODEATROPHY_DB_AUTO_MIGRATE: must be on or off") {
		t.Errorf("a bad CODEATROPHY_DB_AUTO_MIGRATE: %v", err)
	}
}

func TestDataDirAndLogFormat(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{"CODEATROPHY_DATA_DIR": "/srv/codeatrophy", "CODEATROPHY_LOG_FORMAT": "JSON"}))
	if err != nil || c.DataDir != "/srv/codeatrophy" || c.DBPath != "/srv/codeatrophy/codeatrophy.db" || c.LogFormat != "json" {
		t.Errorf("data dir and log format: %q %q %q %v", c.DataDir, c.DBPath, c.LogFormat, err)
	}
	c, err = LoadFrom(env(map[string]string{"CODEATROPHY_DATA_DIR": "/srv/codeatrophy", "CODEATROPHY_DB_PATH": "/db/x.db"}))
	if err != nil || c.DBPath != "/db/x.db" {
		t.Errorf("CODEATROPHY_DB_PATH wins: %q %v", c.DBPath, err)
	}
	if c, _ := LoadFrom(env(nil)); c.LogFormat != "text" {
		t.Errorf("default log format: %q", c.LogFormat)
	}
	_, err = LoadFrom(env(map[string]string{"CODEATROPHY_LOG_FORMAT": "xml"}))
	if err == nil || !strings.Contains(err.Error(), "CODEATROPHY_LOG_FORMAT") {
		t.Errorf("a bad log format: %v", err)
	}
}

func TestJudgeWorkersAndMCPToken(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{"CODEATROPHY_JUDGE_WORKERS": "3", "CODEATROPHY_JUDGE_CONCURRENCY": "8",
		"CODEATROPHY_MCP_TOKEN": "s3cret", "CODEATROPHY_MCP_ENABLED": "false"}))
	if err != nil || c.Judge.Workers != 3 || c.Judge.Concurrency != 8 || c.MCP.Token != "s3cret" || c.MCP.Enabled {
		t.Errorf("parsed: %+v %+v %v", c.Judge, c.MCP, err)
	}
	if d, _ := LoadFrom(env(nil)); d.Judge.Workers != 2 || d.Judge.Concurrency != 4 || d.MCP.Token != "" {
		t.Errorf("defaults: %+v %+v", d.Judge, d.MCP)
	}
	for _, k := range []string{"CODEATROPHY_JUDGE_WORKERS", "CODEATROPHY_JUDGE_CONCURRENCY"} {
		for _, v := range []string{"0", "-1"} {
			_, err := LoadFrom(env(map[string]string{k: v}))
			if err == nil || !strings.Contains(err.Error(), "must be at least 1") {
				t.Errorf("%s=%s: %v", k, v, err)
			}
		}
	}
}

// MCP tool results are compact JSON unless CODEATROPHY_MCP_PRETTY_JSON is
// set.
func TestMCPPrettyJSON(t *testing.T) {
	if d, _ := LoadFrom(env(nil)); d.MCP.PrettyJSON {
		t.Error("pretty JSON is on by default")
	}
	if c, err := LoadFrom(env(map[string]string{"CODEATROPHY_MCP_PRETTY_JSON": "true"})); err != nil || !c.MCP.PrettyJSON {
		t.Errorf("parsed: %+v %v", c.MCP, err)
	}
	if _, err := LoadFrom(env(map[string]string{"CODEATROPHY_MCP_PRETTY_JSON": "indented"})); err == nil ||
		!strings.Contains(err.Error(), "CODEATROPHY_MCP_PRETTY_JSON") {
		t.Errorf("a bad value: %v", err)
	}
}

func TestAuth(t *testing.T) {
	c, err := LoadFrom(env(nil))
	if err != nil || !c.Auth || c.SessionTTL != 30*24*time.Hour {
		t.Errorf("defaults: %v %v %v", c.Auth, c.SessionTTL, err)
	}
	c, err = LoadFrom(env(map[string]string{"CODEATROPHY_AUTH": "off", "CODEATROPHY_SESSION_TTL": "720h"}))
	if err != nil || c.Auth || c.SessionTTL != 720*time.Hour {
		t.Errorf("off: %v %v %v", c.Auth, c.SessionTTL, err)
	}
	for _, v := range []map[string]string{{"CODEATROPHY_AUTH": "maybe"}, {"CODEATROPHY_SESSION_TTL": "1h"}} {
		if _, err := LoadFrom(env(v)); err == nil {
			t.Errorf("%v accepted", v)
		}
	}
}

// CODEATROPHY_ACCESS_LOG is off by default and takes on or off.
func TestAccessLog(t *testing.T) {
	if c, err := LoadFrom(env(nil)); err != nil || c.AccessLog {
		t.Errorf("default: %v %v", c.AccessLog, err)
	}
	for v, want := range map[string]bool{"on": true, "TRUE": true, "1": true, "off": false, "no": false} {
		if c, err := LoadFrom(env(map[string]string{"CODEATROPHY_ACCESS_LOG": v})); err != nil || c.AccessLog != want {
			t.Errorf("%s: %v %v", v, c.AccessLog, err)
		}
	}
	if _, err := LoadFrom(env(map[string]string{"CODEATROPHY_ACCESS_LOG": "verbose"})); err == nil ||
		!strings.Contains(err.Error(), "CODEATROPHY_ACCESS_LOG") {
		t.Errorf("a bad value: %v", err)
	}
}

// CODEATROPHY_TRUSTED_PROXIES takes addresses and CIDR prefixes; none are
// trusted by default.
func TestTrustedProxies(t *testing.T) {
	if c, err := LoadFrom(env(nil)); err != nil || len(c.TrustedProxies) != 0 {
		t.Errorf("defaults: %v %v", c.TrustedProxies, err)
	}
	c, err := LoadFrom(env(map[string]string{"CODEATROPHY_TRUSTED_PROXIES": " 172.16.0.0/12, 127.0.0.1,::1, ::ffff:10.0.0.0/104"}))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, p := range c.TrustedProxies {
		got = append(got, p.String())
	}
	if want := "172.16.0.0/12 127.0.0.1/32 ::1/128 10.0.0.0/8"; strings.Join(got, " ") != want {
		t.Errorf("got %v, want %s", got, want)
	}
	for _, v := range []string{"proxy.local", "10.0.0.0/33", "::ffff:10.0.0.0/64"} {
		if _, err := LoadFrom(env(map[string]string{"CODEATROPHY_TRUSTED_PROXIES": v})); err == nil {
			t.Errorf("%q accepted", v)
		}
	}
}

// AI providers may reach private addresses unless
// CODEATROPHY_AI_BLOCK_PRIVATE is set; CODEATROPHY_AI_ALLOWED_HOSTS lists
// exceptions, which must be names, addresses or CIDR prefixes.
func TestAIEgress(t *testing.T) {
	if c, err := LoadFrom(env(nil)); err != nil || c.AI.Egress.BlockPrivate || len(c.AI.Egress.Allow) != 0 {
		t.Errorf("defaults: %+v %v", c.AI.Egress, err)
	}
	c, err := LoadFrom(env(map[string]string{
		"CODEATROPHY_AI_BLOCK_PRIVATE": "true",
		"CODEATROPHY_AI_ALLOWED_HOSTS": "ollama, 192.168.1.0/24 ,fd00::1",
	}))
	if err != nil || !c.AI.Egress.BlockPrivate || strings.Join(c.AI.Egress.Allow, ",") != "ollama,192.168.1.0/24,fd00::1" {
		t.Errorf("set: %+v %v", c.AI.Egress, err)
	}
	for k, v := range map[string]string{
		"CODEATROPHY_AI_BLOCK_PRIVATE": "sometimes",
		"CODEATROPHY_AI_ALLOWED_HOSTS": "http://ollama:11434",
	} {
		if _, err := LoadFrom(env(map[string]string{k: v})); err == nil || !strings.Contains(err.Error(), k) {
			t.Errorf("%s=%s: %v", k, v, err)
		}
	}
}

// Every on/off variable takes the same words, in any case, and a value
// that is none of them is an error that lists them.
func TestSwitches(t *testing.T) {
	read := map[string]func(Config) bool{
		"CODEATROPHY_AUTH":             func(c Config) bool { return c.Auth },
		"CODEATROPHY_ACCESS_LOG":       func(c Config) bool { return c.AccessLog },
		"CODEATROPHY_SQLITE_IMPORT":    func(c Config) bool { return c.SQLiteImport },
		"CODEATROPHY_DB_AUTO_MIGRATE":  func(c Config) bool { return c.DBAutoMigrate },
		"CODEATROPHY_JUDGE0_CGROUPS":   func(c Config) bool { return c.Judge.Judge0Cgroups },
		"CODEATROPHY_AI_BLOCK_PRIVATE": func(c Config) bool { return c.AI.Egress.BlockPrivate },
		"CODEATROPHY_MCP_ENABLED":      func(c Config) bool { return c.MCP.Enabled },
		"CODEATROPHY_MCP_PRETTY_JSON":  func(c Config) bool { return c.MCP.PrettyJSON },
	}
	words := map[string]bool{
		"on": true, "ON": true, "true": true, "True": true, "TRUE": true, "yes": true, "Yes": true, "1": true,
		"t": true, "T": true,
		"off": false, "Off": false, "false": false, "FALSE": false, "no": false, "NO": false, "0": false,
		"f": false, "F": false,
	}
	for key, get := range read {
		for v, want := range words {
			if c, err := LoadFrom(env(map[string]string{key: v})); err != nil || get(c) != want {
				t.Errorf("%s=%s: %v %v, want %v", key, v, get(c), err, want)
			}
		}
		_, err := LoadFrom(env(map[string]string{key: "maybe"}))
		if err == nil || !strings.Contains(err.Error(),
			key+`: must be on or off (or true/false, yes/no, 1/0, t/f), not "maybe"`) {
			t.Errorf("%s=maybe: %v", key, err)
		}
	}
}
