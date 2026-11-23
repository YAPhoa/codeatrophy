package ai

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Redact removes the secrets, and cuts a long message short at a
// character boundary.
func TestRedact(t *testing.T) {
	if got := Redact("key sk-secret-1 rejected", "sk-secret-1", "abc"); got != "key [redacted] rejected" {
		t.Errorf("redacted: %q", got)
	}
	got := Redact("a" + strings.Repeat("é", 300))
	if !utf8.ValidString(got) || !strings.HasSuffix(got, "…") || len(got) > 500+len("…") {
		t.Errorf("a long message: %d bytes, valid UTF-8 %v", len(got), utf8.ValidString(got))
	}
}
