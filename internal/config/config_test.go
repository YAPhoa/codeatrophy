package config

import (
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
	if c.Addr != ":8080" || c.DataDir != "./data" || c.DBPath != "data/codeatrophy.db" || c.LogLevel != slog.LevelInfo ||
		c.MaxImportBytes != 52428800 || c.MaxSourceBytes != 65536 || c.Judge.Engine != "none" || c.Judge.Judge0Cgroups ||
		!c.MCP.Enabled || c.AI.Timeout != 5*time.Minute || c.PublicURL != "" || c.AI.Provider != "" {
		t.Errorf("defaults: %+v", c)
	}
}

func TestConventionalKeyFallbacks(t *testing.T) {
	c, _ := LoadFrom(env(map[string]string{"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "o"}))
	if c.AI.AnthropicAPIKey != "a" || c.AI.OpenAIAPIKey != "o" {
		t.Errorf("fallbacks: %+v", c.AI)
	}
	c, _ = LoadFrom(env(map[string]string{"ANTHROPIC_API_KEY": "a", "CODEATROPHY_ANTHROPIC_API_KEY": "b"}))
	if c.AI.AnthropicAPIKey != "b" {
		t.Error("the prefixed variable wins")
	}
}

func TestParsing(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{
		"CODEATROPHY_JUDGE_ENGINE": "Judge0", "CODEATROPHY_JUDGE0_CGROUPS": "true",
		"CODEATROPHY_JUDGE0_MEMORY_ALLOWANCES": "java=1048576, go=262144",
		"CODEATROPHY_MCP_ALLOWED_ORIGINS":      "https://a.example/, https://b.example",
		"CODEATROPHY_AI_PROVIDER":              "none",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Judge.Engine != "judge0" || !c.Judge.Judge0Cgroups || c.Judge.Judge0MemoryAllowanceKb["go"] != 262144 ||
		len(c.MCP.AllowedOrigins) != 2 || c.MCP.AllowedOrigins[0] != "https://a.example" || c.AI.Provider != "" {
		t.Errorf("parsed: %+v", c)
	}
	for k, v := range map[string]string{
		"CODEATROPHY_JUDGE_ENGINE": "docker", "CODEATROPHY_LOG_LEVEL": "loud", "CODEATROPHY_MCP_ENABLED": "maybe",
		"CODEATROPHY_JUDGE0_TIMEOUT": "soon", "CODEATROPHY_AI_PROVIDER": "gemini", "CODEATROPHY_JUDGE0_MEMORY_ALLOWANCES": "java",
		"CODEATROPHY_MAX_SOURCE_BYTES": "10",
	} {
		if _, err := LoadFrom(env(map[string]string{k: v})); err == nil {
			t.Errorf("%s=%s should be rejected", k, v)
		}
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
		"CODEATROPHY_ALLOWED_HOSTS":       "nas.local, 192.168.1.20:8080, [fd00::1]",
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
