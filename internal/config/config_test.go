package config

import (
	"log/slog"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDefaults(t *testing.T) {
	c, err := LoadFrom(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8080" || c.DataDir != "./data" || c.DBPath != "data/codeathropy.db" || c.LogLevel != slog.LevelInfo ||
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
	c, _ = LoadFrom(env(map[string]string{"ANTHROPIC_API_KEY": "a", "CODEATHROPY_ANTHROPIC_API_KEY": "b"}))
	if c.AI.AnthropicAPIKey != "b" {
		t.Error("the prefixed variable wins")
	}
}

func TestParsing(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{
		"CODEATHROPY_JUDGE_ENGINE": "Judge0", "CODEATHROPY_JUDGE0_CGROUPS": "true",
		"CODEATHROPY_JUDGE0_MEMORY_ALLOWANCES": "java=1048576, go=262144",
		"CODEATHROPY_MCP_ALLOWED_ORIGINS":      "https://a.example/, https://b.example",
		"CODEATHROPY_AI_PROVIDER":              "none",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Judge.Engine != "judge0" || !c.Judge.Judge0Cgroups || c.Judge.Judge0MemoryAllowanceKb["go"] != 262144 ||
		len(c.MCP.AllowedOrigins) != 2 || c.MCP.AllowedOrigins[0] != "https://a.example" || c.AI.Provider != "" {
		t.Errorf("parsed: %+v", c)
	}
	for k, v := range map[string]string{
		"CODEATHROPY_JUDGE_ENGINE": "docker", "CODEATHROPY_LOG_LEVEL": "loud", "CODEATHROPY_MCP_ENABLED": "maybe",
		"CODEATHROPY_JUDGE0_TIMEOUT": "soon", "CODEATHROPY_AI_PROVIDER": "gemini", "CODEATHROPY_JUDGE0_MEMORY_ALLOWANCES": "java",
		"CODEATHROPY_MAX_SOURCE_BYTES": "10",
	} {
		if _, err := LoadFrom(env(map[string]string{k: v})); err == nil {
			t.Errorf("%s=%s should be rejected", k, v)
		}
	}
}

func TestPublicURL(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{"CODEATHROPY_PUBLIC_URL": "https://code.example.com/"}))
	if err != nil || c.PublicURL != "https://code.example.com" || c.AllowedOrigins[0] != "https://code.example.com" {
		t.Errorf("public URL: %+v %v", c, err)
	}
	if _, err := LoadFrom(env(map[string]string{"CODEATHROPY_PUBLIC_URL": "code.example.com"})); err == nil {
		t.Error("a relative public URL should be rejected")
	}
}
