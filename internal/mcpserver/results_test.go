package mcpserver_test

import (
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/mcpserver"
)

// rawCall returns a tool's result as it came.
func rawCall(t *testing.T, s *mcp.ClientSession, name string, args any) *mcp.CallToolResult {
	t.Helper()
	res, err := s.CallTool(t.Context(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return res
}

// Tool results are compact JSON by default and indented with PrettyJSON;
// the text and the structured content carry the same document either way.
func TestCompactAndPrettyJSON(t *testing.T) {
	for _, pretty := range []bool{false, true} {
		f := newFixture(t, "", func(o *mcpserver.Options) { o.PrettyJSON = pretty })
		s := f.connect(t, "")
		for _, res := range []*mcp.CallToolResult{
			rawCall(t, s, "get_overview", map[string]any{}),
			rawCall(t, s, "get_item", map[string]any{"id": "nope"}),
		} {
			text := res.Content[0].(*mcp.TextContent).Text
			if indented := strings.Contains(text, "\n  \""); indented != pretty {
				t.Errorf("pretty %v: %.120s", pretty, text)
			}
			if !pretty && strings.ContainsAny(text, "\n") {
				t.Errorf("compact JSON with a newline: %.120s", text)
			}
			var fromText any
			if err := json.Unmarshal([]byte(text), &fromText); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(fromText, res.StructuredContent) {
				t.Errorf("pretty %v: the structured content differs from the text", pretty)
			}
		}
	}
}

// The instructions are a short static brief: the same for every session
// whatever the user's settings, pointing to get_authoring_guide early on.
func TestInstructionsAreStatic(t *testing.T) {
	f := newFixture(t, "")
	before := f.connect(t, "").InitializeResult().Instructions
	if _, err := f.app.CreateStylePreset(f.ctx, domain.StylePresetInput{Name: domain.Some("S"),
		Instructions: domain.Some("STYLE-MARKER"), IsDefault: domain.Some(true)}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.SetSystemPrompt(f.ctx, app.SystemPromptInput{Custom: domain.Some("CONVENTIONS-MARKER")}); err != nil {
		t.Fatal(err)
	}
	after := f.connect(t, "").InitializeResult().Instructions
	if before != after || strings.Contains(after, "MARKER") {
		t.Error("the instructions follow the user's settings")
	}
	if i := strings.Index(after, "get_authoring_guide"); i < 0 || i > 500 {
		t.Errorf("get_authoring_guide is not named in the first 500 characters: %d", i)
	}
}

// search_items returns 20 summaries unless limit asks for more; total
// counts them all.
func TestSearchItemsDefaultLimit(t *testing.T) {
	f := newFixture(t, "")
	for range 25 {
		if _, err := f.app.CreateItem(f.ctx, domain.ItemInput{Type: domain.Some(domain.TypeReading), Title: domain.Some("R")}); err != nil {
			t.Fatal(err)
		}
	}
	s := f.connect(t, "")
	got, _ := call(t, s, "search_items", map[string]any{})
	if len(got["items"].([]any)) != 20 || got["total"] != float64(25) {
		t.Errorf("default page: %d items, total %v", len(got["items"].([]any)), got["total"])
	}
	got, _ = call(t, s, "search_items", map[string]any{"limit": 25})
	if len(got["items"].([]any)) != 25 {
		t.Errorf("limit 25: %d items", len(got["items"].([]any)))
	}
}

// The write tools return the item's summary, as search_items lists it.
func TestWriteToolsReturnSummaries(t *testing.T) {
	f := newFixture(t, "")
	s := f.connect(t, "")
	created, isErr := call(t, s, "create_item", map[string]any{"type": "reading", "title": "R", "body": "Some body text."})
	if isErr {
		t.Fatal(created)
	}
	id := created["id"].(string)
	updated, _ := call(t, s, "update_item", map[string]any{"id": id, "title": "R2", "expectedRevision": 1})
	edited, _ := call(t, s, "edit_item_text", map[string]any{"id": id, "field": "body", "expectedRevision": 2,
		"edits": []map[string]any{{"oldText": "Some", "newText": "The"}}})
	listed, _ := call(t, s, "search_items", map[string]any{"id": []string{id}})
	summary := listed["items"].([]any)[0].(map[string]any)
	keys := slices.Sorted(maps.Keys(summary))
	for name, r := range map[string]map[string]any{"create_item": created, "update_item": updated, "edit_item_text": edited} {
		if got := slices.Sorted(maps.Keys(r)); !slices.Equal(got, keys) {
			t.Errorf("%s: fields %v, want the summary's %v", name, got, keys)
		}
	}
	if created["revision"] != float64(1) || updated["revision"] != float64(2) || updated["title"] != "R2" ||
		!reflect.DeepEqual(edited, summary) {
		t.Errorf("summaries: %v / %v / %v", created, updated, edited)
	}
}

// Test data is elided above 2 KiB by default, above 16 KiB with full: true,
// and above 512 bytes in the results of the tools that write test cases;
// list_test_cases can return only some cases; verify_test_cases leaves out
// the output of a case that matched.
func TestElisionTiers(t *testing.T) {
	f := newFixture(t, "")
	s := f.connect(t, "")
	data := func(n int) string { return strings.Repeat("7 ", n/2) }
	small, mid, big := data(1000), data(3000), data(20000)
	it, isErr := call(t, s, "create_item", map[string]any{"type": "problem", "title": "Echo",
		"problem": map[string]any{"referenceSolution": map[string]any{"language": "python", "source": "echo"}},
		"testCases": []map[string]any{
			{"name": "small", "stdin": small, "expectedStdout": small},
			{"name": "mid", "stdin": mid, "expectedStdout": "x"},
			{"name": "big", "stdin": big, "expectedStdout": big},
		}})
	if isErr {
		t.Fatal(it)
	}
	id := it["id"].(string)
	// kept reports whether field of m came whole, and checks the shape of
	// an elided one.
	kept := func(m map[string]any, field string, want string) bool {
		t.Helper()
		if v, ok := m[field].(string); ok {
			if v != want {
				t.Errorf("%s: a different value", field)
			}
			return true
		}
		if m[field+"Bytes"] != float64(len(want)) || m[field+"Head"] != want[:200] {
			t.Errorf("%s elided as %v, %v", field, m[field+"Bytes"], m[field+"Head"])
		}
		return false
	}
	cases := func(m map[string]any) []map[string]any {
		var out []map[string]any
		for _, x := range m["items"].([]any) {
			out = append(out, x.(map[string]any))
		}
		return out
	}

	list := cases(first(call(t, s, "list_test_cases", map[string]any{"itemId": id})))
	if !kept(list[0], "stdin", small) || kept(list[1], "stdin", mid) || kept(list[2], "stdin", big) {
		t.Error("list_test_cases: the default limit is not 2 KiB")
	}
	full := cases(first(call(t, s, "list_test_cases", map[string]any{"itemId": id, "full": true})))
	if !kept(full[0], "stdin", small) || !kept(full[1], "stdin", mid) || kept(full[2], "stdin", big) {
		t.Error("list_test_cases full: the limit is not 16 KiB")
	}
	some := cases(first(call(t, s, "list_test_cases", map[string]any{"itemId": id, "ids": []string{list[1]["id"].(string), "nope"}})))
	if len(some) != 1 || some[0]["id"] != list[1]["id"] {
		t.Errorf("list_test_cases ids: %v", some)
	}

	for _, full := range []bool{false, true} {
		ver, isErr := call(t, s, "verify_test_cases", map[string]any{"itemId": id, "full": full})
		if isErr {
			t.Fatal(ver)
		}
		var rs []map[string]any
		for _, x := range ver["results"].([]any) {
			rs = append(rs, x.(map[string]any))
		}
		for _, i := range []int{0, 2} {
			if _, ok := rs[i]["actualStdout"]; ok || rs[i]["matches"] != true || rs[i]["actualStdoutBytes"] != nil || rs[i]["testCaseId"] == nil {
				t.Errorf("verify: a matching case: %.200v", rs[i])
			}
		}
		if rs[1]["matches"] != false || kept(rs[1], "actualStdout", mid) != full {
			t.Errorf("verify full %v: the mismatching case: %.200v", full, rs[1])
		}

		run, _ := call(t, s, "run_code", map[string]any{"itemId": id, "language": "python", "source": "echo", "mode": "submit", "full": full})
		sub, _ := call(t, s, "get_submission", map[string]any{"id": run["id"], "full": full})
		for name, v := range map[string]map[string]any{"run_code": run, "get_submission": sub} {
			r := v["results"].([]any)[1].(map[string]any)
			if kept(r, "stdout", mid) != full {
				t.Errorf("%s full %v: %.200v", name, full, r)
			}
		}
	}

	// The writing tools elide above 512 bytes.
	added := cases(first(call(t, s, "add_test_cases", map[string]any{"itemId": id,
		"cases": []map[string]any{{"stdin": "1 2", "expectedStdout": "1 2"}}})))
	if kept(added[0], "stdin", small) || !kept(added[3], "stdin", "1 2") {
		t.Error("add_test_cases: the limit is not 512 bytes")
	}
	up, isErr := call(t, s, "update_test_case", map[string]any{"id": list[0]["id"], "name": "renamed"})
	if isErr || up["name"] != "renamed" || kept(up, "stdin", small) || kept(up, "expectedStdout", small) {
		t.Errorf("update_test_case: %.300v", up)
	}
}
