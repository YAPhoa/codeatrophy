package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Hard limits for style presets. They bound what user-written text can be
// placed in a system prompt and are deliberately not configurable.
const (
	MaxStylePresets               = 20
	MaxStyleNameChars             = 60
	MaxStyleInstructionsChars     = 2000
	MaxGenerationInstructionChars = 2000
)

// StylePreset is a named set of the user's standing writing instructions.
type StylePreset struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Instructions string    `json:"instructions"`
	IsDefault    bool      `json:"isDefault"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// StylePresetInput is the body of preset create and update requests.
type StylePresetInput struct {
	Name         Opt[string] `json:"name"`
	Instructions Opt[string] `json:"instructions"`
	IsDefault    Opt[bool]   `json:"isDefault"`
}

// StyleRef identifies the preset applied to a generation.
type StyleRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// HasDisallowedControl reports whether s contains a control character
// other than newline and tab.
func HasDisallowedControl(s string) bool {
	for _, r := range s {
		if r == '\n' || r == '\t' {
			continue
		}
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// checkText trims s and checks it against a code point range and the
// control-character rule. It never truncates.
func checkText(s string, minChars, maxChars int) (string, string) {
	s = strings.TrimSpace(NormalizeText(s))
	if HasDisallowedControl(s) {
		return s, "must not contain control characters other than newline and tab"
	}
	n := utf8.RuneCountInString(s)
	if n < minChars {
		return s, "is required"
	}
	if n > maxChars {
		return s, fmt.Sprintf("must be at most %d characters", maxChars)
	}
	return s, ""
}

// ValidateStylePreset trims and checks a preset's fields in place.
func ValidateStylePreset(p *StylePreset) FieldErrors {
	errs := FieldErrors{}
	var msg string
	if p.Name, msg = checkText(p.Name, 1, MaxStyleNameChars); msg != "" {
		errs.Add("name", msg)
	} else if strings.ContainsAny(p.Name, "\n\t") {
		errs.Add("name", "must be a single line (no newline or tab)")
	}
	if p.Instructions, msg = checkText(p.Instructions, 1, MaxStyleInstructionsChars); msg != "" {
		errs.Add("instructions", msg)
	}
	return errs
}

// ValidateGenerationInstruction checks a per-request instruction.
func ValidateGenerationInstruction(s string) string {
	if utf8.RuneCountInString(s) > MaxGenerationInstructionChars {
		return fmt.Sprintf("must be at most %d characters", MaxGenerationInstructionChars)
	}
	return ""
}

// StyleNameKey is the case-insensitive comparison key for preset names.
func StyleNameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}
