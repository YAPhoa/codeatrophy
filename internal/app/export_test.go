package app

import "context"

// ClipLabel exposes clipLabel to the tests.
var ClipLabel = clipLabel

// The generations run as AI jobs in production (StartAIJob, drafts). These
// synchronous forms exist for the tests only: they validate a request and
// run it in the caller, returning what the job would store as its result.

// Draft turns rough input into a complete item draft. Nothing is saved.
func (a *App) Draft(ctx context.Context, in DraftInput) (DraftResponse, error) {
	t, err := a.prepareDraft(ctx, in)
	if err != nil {
		return DraftResponse{}, err
	}
	return t.run(ctx)
}

// Variant drafts a new item derived from an existing one. Nothing is saved.
func (a *App) Variant(ctx context.Context, itemID string, in VariantInput) (DraftResponse, error) {
	t, err := a.prepareVariant(ctx, itemID, in)
	if err != nil {
		return DraftResponse{}, err
	}
	return t.run(ctx)
}

// GenerateTestCases asks the model for a reference solution and inputs, then
// runs the solution to compute the expected outputs when an engine is
// available. Nothing is saved. Style presets and the custom system prompt
// do not apply; a custom test case prompt does.
func (a *App) GenerateTestCases(ctx context.Context, itemID string, in GenerateTestCasesInput) (GenerateTestCasesResponse, error) {
	t, err := a.prepareTestCases(ctx, itemID, in)
	if err != nil {
		return GenerateTestCasesResponse{}, err
	}
	return t.run(ctx)
}

// GenerateCode asks the model for the starter code of a problem in the
// given languages, and for a function problem the harness too, then runs
// each runner the way the draft check does. Only languages that were asked
// for come back. Nothing is saved; the problem need not be saved either.
func (a *App) GenerateCode(ctx context.Context, in CodeInput) (CodeResponse, error) {
	t, err := a.prepareCode(ctx, in)
	if err != nil {
		return CodeResponse{}, err
	}
	return t.run(ctx)
}

// FastPasswordHashes lowers the bcrypt work factor for the rest of the
// test binary, so that tests that sign in run quickly.
func FastPasswordHashes() { bcryptCost = 4 }
