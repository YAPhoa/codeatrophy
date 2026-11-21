package mcpserver_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// A large test case is added as a generator over MCP, and every tool
// result shows large test data by its size and head only.
func TestGeneratorsAndElidedTestData(t *testing.T) {
	f := newFixture(t, "")
	s := f.connect(t, "")
	it, isErr := call(t, s, "create_item", map[string]any{"type": "problem", "title": "Echo",
		"problem":   map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "echo"}},
		"testCases": []map[string]any{{"stdin": "1 2", "expectedStdout": "1 2", "isSample": true}}})
	if isErr {
		t.Fatalf("create_item: %v", it)
	}
	id := it["id"].(string)
	// The fake engine prints a program it does not know: this generator
	// prints itself, 20000 bytes.
	gen := strings.Repeat("7 ", 10000)
	added, isErr := call(t, s, "add_test_cases", map[string]any{"itemId": id,
		"cases": []map[string]any{{"name": "Many sevens", "generator": map[string]any{"language": "python", "source": gen}}}})
	if isErr {
		t.Fatalf("add_test_cases: %v", added)
	}
	large := added["items"].([]any)[1].(map[string]any)
	if large["stdin"] != nil || large["stdinBytes"] != float64(20000) || large["stdinHead"] != gen[:200] ||
		large["expectedStdout"] != "" || large["generator"].(map[string]any)["language"] != "python" {
		t.Errorf("added: %.500v", large)
	}
	sample := added["items"].([]any)[0].(map[string]any)
	if sample["stdin"] != "1 2" || sample["stdinBytes"] != nil {
		t.Errorf("a small case was changed: %v", sample)
	}

	ver, isErr := call(t, s, "verify_test_cases", map[string]any{"itemId": id, "updateExpected": true})
	r := ver["results"].([]any)[1].(map[string]any)
	if isErr || r["actualStdout"] != nil || r["actualStdoutBytes"] != float64(20000) || r["ok"] != true {
		t.Errorf("verify: %.400v", r)
	}
	for name, got := range map[string]map[string]any{
		"list_test_cases": first(call(t, s, "list_test_cases", map[string]any{"itemId": id}))["items"].([]any)[1].(map[string]any),
		"get_item":        first(call(t, s, "get_item", map[string]any{"id": id, "include": []string{"testCases"}}))["testCases"].([]any)[1].(map[string]any),
	} {
		if got["stdin"] != nil || got["expectedStdout"] != nil || got["expectedStdoutBytes"] != float64(20000) ||
			got["verified"] != true || got["generator"] == nil {
			t.Errorf("%s: %.400v", name, got)
		}
	}
	tcID := large["id"].(string)
	run, _ := call(t, s, "run_code", map[string]any{"itemId": id, "language": "python", "source": "echo", "mode": "submit"})
	sub := first(call(t, s, "get_submission", map[string]any{"id": run["id"]}))
	for name, v := range map[string]map[string]any{"run_code": run, "get_submission": sub} {
		res := v["results"].([]any)[1].(map[string]any)
		if res["stdin"] != nil || res["stdout"] != nil || res["stdoutBytes"] != float64(20000) || v["verdict"] != "accepted" {
			t.Errorf("%s: %.400v", name, res)
		}
	}
	// A run on custom input shows the input elided too.
	custom := first(call(t, s, "run_code", map[string]any{"itemId": id, "language": "python", "source": "echo", "stdin": gen}))
	if res := custom["results"].([]any)[0].(map[string]any); res["stdin"] != nil || res["stdinBytes"] != float64(20000) ||
		res["stdout"] != nil || res["stdoutBytes"] != float64(20000) {
		t.Errorf("custom run: %.300v", custom)
	}

	// update_test_case: both at once is refused, null keeps the stdin.
	bad, isErr := call(t, s, "update_test_case", map[string]any{"id": tcID, "stdin": "1", "generator": map[string]any{"language": "python", "source": "print 1"}})
	if !isErr || bad["error"].(map[string]any)["fields"].(map[string]any)["generator"] == nil {
		t.Errorf("both: %v", bad)
	}
	up, isErr := call(t, s, "update_test_case", map[string]any{"id": tcID, "generator": map[string]any{"language": "python", "source": "print 9 9"}})
	if isErr || up["stdin"] != "9 9\n" || up["verified"] != false {
		t.Errorf("new generator: %v", up)
	}
	up, _ = call(t, s, "update_test_case", map[string]any{"id": tcID, "generator": nil})
	if up["generator"] != nil || up["stdin"] != "9 9\n" {
		t.Errorf("dropped: %v", up)
	}
	// On create, a case with both is stored as given.
	kept, isErr := call(t, s, "add_test_cases", map[string]any{"itemId": id,
		"cases": []map[string]any{{"stdin": "4 4", "expectedStdout": "4 4", "generator": map[string]any{"language": "python", "source": "crash"}}}})
	if isErr || kept["items"].([]any)[2].(map[string]any)["stdin"] != "4 4" {
		t.Errorf("both on create: %v", kept)
	}
	// A generator that fails names its field.
	fail, isErr := call(t, s, "add_test_cases", map[string]any{"itemId": id,
		"cases": []map[string]any{{"generator": map[string]any{"language": "python", "source": "crash"}}}})
	if !isErr || !strings.Contains(fail["error"].(map[string]any)["fields"].(map[string]any)["cases.0.generator"].(string), "the generator") {
		t.Errorf("failure: %v", fail)
	}
}

func first(m map[string]any, _ bool) map[string]any { return m }

// get_overview reports the user's test case preferences and the test case
// limits.
func TestOverviewPreferencesAndLimits(t *testing.T) {
	f := newFixture(t, "")
	s := f.connect(t, "")
	ov, _ := call(t, s, "get_overview", map[string]any{})
	p, l := ov["preferences"].(map[string]any), ov["limits"].(map[string]any)
	if p["generatedTestCases"] != float64(8) || p["largeTestCase"] != false || p["largeTestCaseCount"] != float64(3) || p["hideTestCases"] != true {
		t.Errorf("default preferences: %v", p)
	}
	if l["maxLargeInputBytes"] != float64(1<<20) || l["maxTestDataBytes"] != float64(8<<20) || l["maxTestCasesPerItem"] != float64(1000) ||
		l["maxSourceBytes"] != float64(1<<16) || l["timeLimitMs"].(map[string]any)["max"] != float64(30000) || l["memoryLimitKb"] == nil {
		t.Errorf("limits: %v", l)
	}
	if _, err := f.app.UpdatePreferences(f.ctx, json.RawMessage(`{"generatedTestCases":5,"largeTestCase":true,"largeTestCaseCount":2,"hideTestCases":false}`)); err != nil {
		t.Fatal(err)
	}
	ov, _ = call(t, s, "get_overview", map[string]any{})
	if p := ov["preferences"].(map[string]any); p["generatedTestCases"] != float64(5) || p["largeTestCase"] != true ||
		p["largeTestCaseCount"] != float64(2) || p["hideTestCases"] != false {
		t.Errorf("preferences: %v", p)
	}
}

// The prompts that ask for test cases follow the user's preferences: how
// many cases, and large ones as generators; and end by re-reading the item.
func TestPromptsFollowTestCasePreferences(t *testing.T) {
	f := newFixture(t, "")
	s := f.connect(t, "")
	it, _ := call(t, s, "create_item", map[string]any{"type": "problem", "title": "P"})
	prompt := func(name string, args map[string]string) string {
		t.Helper()
		res, err := s.GetPrompt(f.ctx, &mcp.GetPromptParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return res.Messages[0].Content.(*mcp.TextContent).Text
	}
	id := it["id"].(string)
	all := func() map[string]string {
		return map[string]string{
			"write_test_cases": prompt("write_test_cases", map[string]string{"itemId": id}),
			"draft_item":       prompt("draft_item", map[string]string{"text": "two sum"}),
			"create_variant":   prompt("create_variant", map[string]string{"itemId": id}),
		}
	}
	for name, text := range all() {
		if strings.Contains(text, "generator") || !strings.Contains(text, "re-read it end to end") ||
			!strings.Contains(text, "Report only after a clean read") {
			t.Errorf("%s by default: %s", name, text[strings.Index(text, "---"):])
		}
	}
	if text := all()["write_test_cases"]; !strings.Contains(text, "and 8 test cases") || !strings.Contains(text, "\n6. Before you report") {
		t.Errorf("write_test_cases: %s", text[strings.Index(text, "---"):])
	}
	if _, err := f.app.UpdatePreferences(f.ctx, json.RawMessage(`{"generatedTestCases":5,"largeTestCase":true,"largeTestCaseCount":2}`)); err != nil {
		t.Fatal(err)
	}
	for name, text := range all() {
		if !strings.Contains(text, "Also add 2 large test cases") || !strings.Contains(text, "each as a generator in add_test_cases") ||
			!strings.Contains(text, "at most 1048576 bytes") || !strings.Contains(text, "Make the 2 generators differ in the shape") ||
			!strings.Contains(text, "5 ") {
			t.Errorf("%s with large cases: %s", name, text[strings.Index(text, "---"):])
		}
	}
	text := all()["write_test_cases"]
	if !strings.Contains(text, "and 5 test cases") || !strings.Contains(text, "\n4. Also add 2") || !strings.Contains(text, "\n5. Save them") ||
		!strings.Contains(text, "\n7. Before you report") {
		t.Errorf("write_test_cases with large cases: %s", text[strings.Index(text, "---"):])
	}
	if text := prompt("write_test_cases", map[string]string{"itemId": id, "count": "12"}); !strings.Contains(text, "and 12 test cases") {
		t.Error("an explicit count is not used")
	}
	if _, err := f.app.UpdatePreferences(f.ctx, json.RawMessage(`{"largeTestCaseCount":1}`)); err != nil {
		t.Fatal(err)
	}
	if text := all()["write_test_cases"]; !strings.Contains(text, "Also add one large test case") || !strings.Contains(text, "Make what it prints the input most likely") {
		t.Errorf("one large case: %s", text[strings.Index(text, "---"):])
	}
}
