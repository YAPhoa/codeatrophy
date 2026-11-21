package httpapi

import "testing"

// Only the requests that wait on something slow get the long deadline. AI
// generations are jobs that answer at once: starting, reading, cancelling
// and dismissing them get the default one, as do the AI settings other than
// the provider's connection test and model list.
func TestLongRunningRoutes(t *testing.T) {
	long := []string{
		"/api/v1/items/check", "/api/v1/items/x/testcases/verify",
		"/api/v1/export", "/api/v1/import", "/api/v1/import/preview",
		"/api/v1/settings/ai/test", "/api/v1/settings/ai/models",
	}
	short := []string{
		"/api/v1/items", "/api/v1/items/x", "/api/v1/meta", "/api/v1/items/x/testcases",
		// AI jobs.
		"/api/v1/ai/jobs", "/api/v1/ai/jobs/x", "/api/v1/ai/jobs/x/cancel", "/api/v1/ai/jobs/x/pickup",
		// The requests that start one.
		"/api/v1/items/x/ai/testcases", "/api/v1/ai/code", "/api/v1/drafts", "/api/v1/drafts/x/generate",
		// AI settings.
		"/api/v1/settings/ai", "/api/v1/settings/ai/log", "/api/v1/settings/ai/log/x",
		"/api/v1/settings/ai/providers", "/api/v1/settings/ai/providers/x",
		"/api/v1/settings/ai/system-prompt", "/api/v1/settings/ai/testcase-prompt",
	}
	for _, p := range long {
		if !longRunning(p) {
			t.Errorf("%s should get the long deadline", p)
		}
	}
	for _, p := range short {
		if longRunning(p) {
			t.Errorf("%s should get the default deadline", p)
		}
	}
}
