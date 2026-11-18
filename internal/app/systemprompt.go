package app

import (
	"context"
	"strings"

	"codeatrophy/internal/ai"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// A custom system prompt replaces the editable part of the authoring
// conventions (ai.EditableConventions) in drafts, variants and the MCP
// authoring guide; the fixed rules (ai.FixedConventions) and each request's
// own rules still follow it. Like style presets it is local configuration:
// one value per instance, set only through the instance's own settings,
// never exported and never readable or writable through an MCP tool.

// keySystemPrompt holds the custom system prompt; without it the built-in
// conventions apply.
const keySystemPrompt = "ai.system_prompt"

// SystemPrompt is the body of GET /settings/ai/system-prompt.
type SystemPrompt struct {
	// BuiltIn is the editable part of the built-in conventions.
	BuiltIn string `json:"builtIn"`
	// Custom is the saved replacement for BuiltIn, or nil.
	Custom   *string `json:"custom"`
	IsCustom bool    `json:"isCustom"`
	// Fixed are the rules that follow the conventions in every prompt.
	Fixed string `json:"fixed"`
	// DraftRules and VariantRules end a draft's and a variant's system
	// prompt, after the style preset.
	DraftRules   string `json:"draftRules"`
	VariantRules string `json:"variantRules"`
}

// SystemPromptInput is the body of PUT /settings/ai/system-prompt.
type SystemPromptInput struct {
	Custom domain.Opt[string] `json:"custom"`
}

func systemPromptOf(custom string) SystemPrompt {
	out := SystemPrompt{
		BuiltIn: strings.TrimSpace(ai.EditableConventions), Fixed: strings.TrimSpace(ai.FixedConventions),
		DraftRules: strings.TrimSpace(ai.DraftRules()), VariantRules: strings.TrimSpace(ai.VariantRules()),
	}
	if custom != "" {
		out.Custom, out.IsCustom = &custom, true
	}
	return out
}

// customPrompt reads the custom text saved under key, or "" for none.
func customPrompt(tx store.Tx, key string) (string, error) {
	v, ok, err := tx.GetSetting(key)
	if err != nil || !ok {
		return "", err
	}
	return strings.TrimSpace(v), nil
}

func (a *App) readCustomPrompt(ctx context.Context, key string) (string, error) {
	var custom string
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		custom, err = customPrompt(tx, key)
		return err
	})
	return custom, err
}

// saveCustomPrompt validates and saves a custom text under key, and returns
// what is now in effect: the text, or "" when it was builtIn unchanged and
// the custom one was removed instead.
func (a *App) saveCustomPrompt(ctx context.Context, key, builtIn string, in domain.Opt[string]) (string, error) {
	if !in.Set || in.Null {
		return "", errField("custom", "is required; reset to the built-in text with DELETE")
	}
	text, msg := domain.ValidateSystemPrompt(in.Val)
	if msg != "" {
		return "", errField("custom", msg)
	}
	if text == strings.TrimSpace(builtIn) {
		return "", a.deleteCustomPrompt(ctx, key)
	}
	return text, a.store.Write(ctx, func(tx store.Tx) error { return tx.SetSetting(key, text) })
}

func (a *App) deleteCustomPrompt(ctx context.Context, key string) error {
	return a.store.Write(ctx, func(tx store.Tx) error { return tx.DeleteSetting(key) })
}

// GetSystemPrompt returns the built-in conventions, the custom system
// prompt if one is saved, and the fixed rules.
func (a *App) GetSystemPrompt(ctx context.Context) (SystemPrompt, error) {
	custom, err := a.Conventions(ctx)
	return systemPromptOf(custom), err
}

// SetSystemPrompt saves a custom system prompt. Saving the built-in text
// unchanged removes the custom one, so the built-in conventions apply as
// they are.
func (a *App) SetSystemPrompt(ctx context.Context, in SystemPromptInput) (SystemPrompt, error) {
	text, err := a.saveCustomPrompt(ctx, keySystemPrompt, ai.EditableConventions, in.Custom)
	if err != nil {
		return SystemPrompt{}, err
	}
	return systemPromptOf(text), nil
}

// ResetSystemPrompt removes the custom system prompt.
func (a *App) ResetSystemPrompt(ctx context.Context) error {
	return a.deleteCustomPrompt(ctx, keySystemPrompt)
}

// Conventions returns the custom system prompt for building a prompt, or ""
// for the built-in conventions.
func (a *App) Conventions(ctx context.Context) (string, error) {
	return a.readCustomPrompt(ctx, keySystemPrompt)
}
