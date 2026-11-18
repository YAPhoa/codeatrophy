package app

import (
	"context"
	"strings"

	"codeatrophy/internal/ai"
)

// A custom test case prompt replaces the editable part of the test-case
// rules (ai.EditableTestCaseRules), the test-design guidance, in test-case
// generation; the fixed rules (ai.FixedTestCaseRules) still follow it. It is
// separate from the custom system prompt, which test generation does not
// use, and like it is local configuration: one value per instance, set only
// through the instance's own settings, never exported and never readable or
// writable through an MCP tool.

// keyTestCasePrompt holds the custom test case prompt; without it the
// built-in test-case rules apply.
const keyTestCasePrompt = "ai.testcase_prompt"

// TestCasePrompt is the body of GET /settings/ai/testcase-prompt.
type TestCasePrompt struct {
	// BuiltIn is the editable part of the built-in test-case rules.
	BuiltIn string `json:"builtIn"`
	// Custom is the saved replacement for BuiltIn, or nil.
	Custom   *string `json:"custom"`
	IsCustom bool    `json:"isCustom"`
	// Fixed are the rules that follow it in every test-case generation.
	Fixed string `json:"fixed"`
}

// TestCasePromptInput is the body of PUT /settings/ai/testcase-prompt.
type TestCasePromptInput = SystemPromptInput

func testCasePromptOf(custom string) TestCasePrompt {
	out := TestCasePrompt{BuiltIn: strings.TrimSpace(ai.EditableTestCaseRules), Fixed: strings.TrimSpace(ai.FixedTestCaseRules())}
	if custom != "" {
		out.Custom, out.IsCustom = &custom, true
	}
	return out
}

// GetTestCasePrompt returns the built-in test-design guidance, the custom
// test case prompt if one is saved, and the fixed rules.
func (a *App) GetTestCasePrompt(ctx context.Context) (TestCasePrompt, error) {
	custom, err := a.testCaseGuidance(ctx)
	return testCasePromptOf(custom), err
}

// SetTestCasePrompt saves a custom test case prompt, under the same rules as
// a custom system prompt: saving the built-in text unchanged removes it.
func (a *App) SetTestCasePrompt(ctx context.Context, in TestCasePromptInput) (TestCasePrompt, error) {
	text, err := a.saveCustomPrompt(ctx, keyTestCasePrompt, ai.EditableTestCaseRules, in.Custom)
	if err != nil {
		return TestCasePrompt{}, err
	}
	return testCasePromptOf(text), nil
}

// ResetTestCasePrompt removes the custom test case prompt.
func (a *App) ResetTestCasePrompt(ctx context.Context) error {
	return a.deleteCustomPrompt(ctx, keyTestCasePrompt)
}

// testCaseGuidance returns the custom test case prompt for building a
// prompt, or "" for the built-in rules.
func (a *App) testCaseGuidance(ctx context.Context) (string, error) {
	return a.readCustomPrompt(ctx, keyTestCasePrompt)
}
