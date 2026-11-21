package domain

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCleanSourceText(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"claude-code", "claude-code"},
		{"  Claude Code  ", "Claude Code"},
		{"a\r\nb\tc\x00d\x7fe", "a b c d e"},
		{"a \n\t  b", "a b"},
		{"a b c", "a b c"},
		{"bad \xff utf-8", "bad � utf-8"},
		{"", ""},
		{" \r\n\t\x00 ", ""},
		{strings.Repeat("é", 250), strings.Repeat("é", 200)},
		// A cut never ends in a space.
		{strings.Repeat("x", 199) + " yz", strings.Repeat("x", 199)},
		{strings.Repeat("x", 198) + " yz", strings.Repeat("x", 198) + " y"},
	} {
		got := CleanSourceText(tc.in)
		switch {
		case tc.want == "" && got != nil:
			t.Errorf("%q: %q, want nil", tc.in, *got)
		case tc.want != "" && (got == nil || *got != tc.want):
			t.Errorf("%q: %v, want %q", tc.in, got, tc.want)
		case got != nil && utf8.RuneCountInString(*got) > MaxChangeSourceChars:
			t.Errorf("%q: %d code points", tc.in, utf8.RuneCountInString(*got))
		}
	}
	c := NewChangeSource(ViaMCP, " ", "m")
	if c.Via != ViaMCP || c.Client != nil || c.Model == nil || *c.Model != "m" {
		t.Errorf("NewChangeSource: %+v", c)
	}
	if d := c.Clone(); d == c || d.Model == c.Model || *d.Model != "m" {
		t.Errorf("Clone shares %+v", d)
	}
	if (*ChangeSource)(nil).Clone() != nil {
		t.Error("Clone of nil")
	}
}
