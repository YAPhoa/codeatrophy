package httpapi

import "testing"

func TestLongRunningRoutes(t *testing.T) {
	long := []string{"/api/v1/settings/ai/test", "/api/v1/settings/ai/models", "/api/v1/items/x/ai/testcases",
		"/api/v1/items/x/testcases/verify", "/api/v1/export", "/api/v1/import", "/api/v1/import/preview"}
	short := []string{"/api/v1/items", "/api/v1/items/x", "/api/v1/meta", "/api/v1/items/x/testcases", "/api/v1/settings/ai"}
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
