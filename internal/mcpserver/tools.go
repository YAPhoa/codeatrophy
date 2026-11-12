package mcpserver

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"codeathropy/internal/app"
	"codeathropy/internal/domain"
)

type tools struct {
	app *app.App
}

type toolFunc func(ctx context.Context, args json.RawMessage) (any, error)

func ptr(b bool) *bool { return &b }

var (
	readOnly    = &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: ptr(false), OpenWorldHint: ptr(false)}
	additive    = &mcp.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(false)}
	idempotent  = &mcp.ToolAnnotations{IdempotentHint: true, DestructiveHint: ptr(false), OpenWorldHint: ptr(false)}
	overwriting = &mcp.ToolAnnotations{IdempotentHint: true, DestructiveHint: ptr(true), OpenWorldHint: ptr(false)}
	destructive = &mcp.ToolAnnotations{DestructiveHint: ptr(true), OpenWorldHint: ptr(false)}
)

func (t *tools) add(s *mcp.Server, name, title, desc string, schema map[string]any, ann *mcp.ToolAnnotations, fn toolFunc) {
	a := *ann
	a.Title = title
	s.AddTool(&mcp.Tool{Name: name, Title: title, Description: desc, InputSchema: schema, Annotations: &a},
		func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var raw json.RawMessage
			if req.Params != nil {
				raw = req.Params.Arguments
			}
			v, err := fn(ctx, raw)
			if err != nil {
				return toolError(err), nil
			}
			return result(v), nil
		})
}

type idArg struct {
	ID string `json:"id"`
}

func (t *tools) register(s *mcp.Server) {
	a := t.app

	// Reading.
	t.add(s, "get_overview", "Library overview",
		"Library statistics, the collection tree, the tag list, and which languages the judge engine offers. A good first call.",
		object(props{}), readOnly, func(ctx context.Context, _ json.RawMessage) (any, error) {
			return a.Overview(ctx)
		})

	t.add(s, "search_items", "Search items",
		"Filter and full-text search the library; same filters as GET /items. Returns item summaries (no bodies) and the total count.",
		object(itemQueryProps()), readOnly, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var q app.ItemQuery
			if err := decodeArgs(raw, &q); err != nil {
				return nil, err
			}
			return a.ListItems(ctx, q)
		})

	t.add(s, "get_item", "Get item",
		"One item in full, including its body and revision. include selects optional parts: testCases, submissions (the 10 most recent).",
		object(props{
			"id":      str("Item id"),
			"include": arrayOf(enumStr("", "testCases", "submissions"), "Optional parts to include"),
		}, "id"), readOnly, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ID      string   `json:"id"`
				Include []string `json:"include"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			it, err := a.GetItem(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			out := map[string]any{"item": it}
			if slices.Contains(in.Include, "testCases") && it.Type == domain.TypeProblem {
				tcs, err := a.ListTestCases(ctx, in.ID)
				if err != nil {
					return nil, err
				}
				out["testCases"] = tcs.Items
			}
			if slices.Contains(in.Include, "submissions") {
				limit := 10
				subs, err := a.ListSubmissions(ctx, in.ID, app.SubmissionQuery{Limit: &limit})
				if err != nil {
					return nil, err
				}
				out["submissions"] = subs.Items
			}
			return out, nil
		})

	t.add(s, "list_test_cases", "List test cases", "The test cases of a problem, in order.",
		object(props{"itemId": str("Problem id")}, "itemId"), readOnly,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID string `json:"itemId"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.ListTestCases(ctx, in.ItemID)
		})

	t.add(s, "get_submission", "Get submission", "A submission with its per-case results.",
		object(props{"id": str("Submission id")}, "id"), readOnly,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in idArg
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.GetSubmission(ctx, in.ID)
		})

	t.add(s, "list_style_presets", "List style presets",
		"The user's style presets (standing writing instructions) and which one is the default. Read-only: presets can only be changed in the app's settings.",
		object(props{}), readOnly, func(ctx context.Context, _ json.RawMessage) (any, error) {
			return a.ListStylePresets(ctx)
		})

	// Writing items.
	createProps := itemFieldProps()
	createProps["type"] = enumStr("Item type", "problem", "reading")
	createProps["testCases"] = arrayOf(testCaseSchema(), "Test cases to create with the item (problems only)")
	t.add(s, "create_item", "Create item",
		"Create a problem or reading. May include tags, collectionIds, variantOf and test cases in the same call. Returns the item with its revision.",
		object(createProps, "type", "title"), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in domain.ItemInput
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.CreateItem(ctx, in)
		})

	updateProps := itemFieldProps()
	updateProps["id"] = str("Item id")
	updateProps["expectedRevision"] = expectedRevision
	t.add(s, "update_item", "Update item",
		"Partial update of an item (merge semantics: omitted fields are unchanged; arrays replace; null clears a nullable field; problem and source merge field by field). Pass expectedRevision.",
		object(updateProps, "id"), idempotent, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var id idArg
			var in domain.ItemInput
			if err := decodeArgs(raw, &id); err != nil {
				return nil, err
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.UpdateItem(ctx, id.ID, in)
		})

	t.add(s, "edit_item_text", "Edit item text",
		"Exact-match text replacements inside body or notes, for small changes to long text. Each oldText must occur exactly once at the point it is applied; otherwise nothing is written.",
		object(props{
			"id":    str("Item id"),
			"field": enumStr("Which text to edit", "body", "notes"),
			"edits": arrayOf(object(props{
				"oldText": str("Exact text to replace; must occur exactly once"),
				"newText": str("Replacement text"),
			}, "oldText", "newText"), "Edits, applied in order"),
			"expectedRevision": expectedRevision,
		}, "id", "field", "edits"), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var id idArg
			var in app.EditTextInput
			if err := decodeArgs(raw, &id); err != nil {
				return nil, err
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.EditItemText(ctx, id.ID, in)
		})

	t.add(s, "delete_item", "Delete item", "Delete an item with its test cases and submissions.",
		object(props{"id": str("Item id")}, "id"), destructive,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in idArg
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			if err := a.DeleteItem(ctx, in.ID); err != nil {
				return nil, err
			}
			return map[string]any{"deleted": in.ID}, nil
		})

	t.add(s, "bulk_update_items", "Bulk update items",
		"Apply one action to many items: addTags, removeTags, setStatus, setFavorite, addToCollection, removeFromCollection or delete. Unknown ids are ignored.",
		object(props{
			"ids":          arrayOf(str("Item id"), "Items to change"),
			"action":       enumStr("Action", "delete", "addTags", "removeTags", "setStatus", "setFavorite", "addToCollection", "removeFromCollection"),
			"tags":         arrayOf(str("Tag"), "For addTags and removeTags"),
			"status":       enumStr("For setStatus", "todo", "in_progress", "done"),
			"favorite":     boolean("For setFavorite"),
			"collectionId": str("For addToCollection and removeFromCollection"),
		}, "ids", "action"), destructive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in app.BulkInput
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.BulkItems(ctx, in)
		})

	// Organising.
	t.add(s, "create_collection", "Create collection", "Create a collection, optionally nested under a parent. It is appended after its siblings.",
		object(props{
			"name":        str("1-200 characters"),
			"description": str("Optional description"),
			"parentId":    nullableStr("Parent collection id, or null for the top level"),
		}, "name"), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in domain.CollectionInput
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.CreateCollection(ctx, in)
		})

	t.add(s, "update_collection", "Update collection",
		"Rename, describe, move (parentId) or reorder (position among siblings) a collection.",
		object(props{
			"id":          str("Collection id"),
			"name":        str("New name"),
			"description": str("New description"),
			"parentId":    nullableStr("New parent id, or null for the top level"),
			"position":    integer("Index among the (new) siblings"),
		}, "id"), idempotent, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var id idArg
			var in domain.CollectionInput
			if err := decodeArgs(raw, &id); err != nil {
				return nil, err
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.UpdateCollection(ctx, id.ID, in)
		})

	t.add(s, "delete_collection", "Delete collection",
		"Delete a collection. Its items are kept; child collections move up to its parent.",
		object(props{"id": str("Collection id")}, "id"), destructive,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in idArg
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			if err := a.DeleteCollection(ctx, in.ID); err != nil {
				return nil, err
			}
			return map[string]any{"deleted": in.ID}, nil
		})

	membership := object(props{
		"id":      str("Collection id"),
		"itemIds": arrayOf(str("Item id"), "Item ids, in order"),
	}, "id", "itemIds")
	t.add(s, "set_collection_items", "Set collection items",
		"Set a collection's exact ordered membership (replaces the current list).",
		membership, overwriting, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ID      string   `json:"id"`
				ItemIDs []string `json:"itemIds"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			if in.ItemIDs == nil {
				in.ItemIDs = []string{}
			}
			return a.SetCollectionItems(ctx, in.ID, in.ItemIDs)
		})

	t.add(s, "add_items_to_collection", "Add items to collection",
		"Append items to a collection; items that are already members keep their place.",
		membership, idempotent, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ID      string   `json:"id"`
				ItemIDs []string `json:"itemIds"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.AddCollectionItems(ctx, in.ID, in.ItemIDs)
		})

	t.add(s, "remove_item_from_collection", "Remove item from collection", "Remove one item from a collection. The item is kept.",
		object(props{"id": str("Collection id"), "itemId": str("Item id")}, "id", "itemId"), idempotent,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ID     string `json:"id"`
				ItemID string `json:"itemId"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			if err := a.RemoveCollectionItem(ctx, in.ID, in.ItemID); err != nil {
				return nil, err
			}
			return map[string]any{"removed": in.ItemID, "collectionId": in.ID}, nil
		})

	t.add(s, "rename_tag", "Rename tag", "Rename a tag on every item, merging with an existing tag of the new name.",
		object(props{"name": str("Current tag name"), "newName": str("New tag name")}, "name", "newName"), idempotent,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				Name    string `json:"name"`
				NewName string `json:"newName"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.RenameTag(ctx, in.Name, in.NewName)
		})

	t.add(s, "delete_tag", "Delete tag", "Remove a tag from every item.",
		object(props{"name": str("Tag name")}, "name"), destructive,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				Name string `json:"name"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			if err := a.DeleteTag(ctx, in.Name); err != nil {
				return nil, err
			}
			return map[string]any{"deleted": in.Name}, nil
		})

	// Test cases and execution.
	t.add(s, "add_test_cases", "Add test cases",
		"Append test cases to a problem, or replace all of them with replace: true. May set the reference solution in the same call (item content: pass expectedRevision then). Test-case changes do not change the item revision. Then call verify_test_cases with updateExpected: true so expected outputs come from running the solution.",
		object(props{
			"itemId":            str("Problem id"),
			"cases":             arrayOf(testCaseSchema(), "Test cases to add"),
			"replace":           boolean("Replace all existing test cases"),
			"referenceSolution": map[string]any{"anyOf": []any{solutionSchema(), map[string]any{"type": "null"}}},
			"expectedRevision":  expectedRevision,
		}, "itemId", "cases"), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID string `json:"itemId"`
				app.BulkTestCasesInput
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.BulkTestCases(ctx, in.ItemID, in.BulkTestCasesInput)
		})

	t.add(s, "update_test_case", "Update test case",
		"Change one test case (partial). Changing stdin or expectedStdout resets verified unless you set it.",
		object(props{
			"id":             str("Test case id"),
			"name":           str("Name"),
			"stdin":          str("Standard input"),
			"expectedStdout": str("Expected output"),
			"isSample":       boolean("Sample flag"),
			"verified":       boolean("Verified flag"),
		}, "id"), idempotent, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ID string `json:"id"`
				domain.TestCaseInput
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.UpdateTestCase(ctx, in.ID, in.TestCaseInput)
		})

	t.add(s, "delete_test_case", "Delete test case", "Delete one test case.",
		object(props{"id": str("Test case id")}, "id"), destructive,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in idArg
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			if err := a.DeleteTestCase(ctx, in.ID); err != nil {
				return nil, err
			}
			return map[string]any{"deleted": in.ID}, nil
		})

	t.add(s, "verify_test_cases", "Verify test cases",
		"Run the problem's reference solution on every test case and report mismatches. Matching cases are marked verified; with updateExpected: true, the actual output replaces the expected output of mismatching cases. Needs a judge engine.",
		object(props{
			"itemId":         str("Problem id"),
			"updateExpected": boolean("Replace expected outputs with the actual output"),
		}, "itemId"), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID         string `json:"itemId"`
				UpdateExpected bool   `json:"updateExpected"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.VerifyTestCases(ctx, in.ItemID, in.UpdateExpected)
		})

	t.add(s, "run_code", "Run code",
		"Execute code for a problem and wait for the verdict: mode run (sample cases, or custom stdin) or submit (all cases). Needs a judge engine.",
		object(props{
			"itemId":         str("Problem id"),
			"language":       languageEnum("Language id"),
			"source":         str("Program source"),
			"mode":           enumStr("run (default) or submit", "run", "submit"),
			"stdin":          nullableStr("Custom input for a run; omit to use the sample cases"),
			"timeoutSeconds": integer("How long to wait for the verdict (default 120, max 600)"),
		}, "itemId", "language", "source"), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID string `json:"itemId"`
				app.SubmissionInput
				TimeoutSeconds int `json:"timeoutSeconds"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			sub, err := a.CreateSubmission(ctx, in.ItemID, in.SubmissionInput)
			if err != nil {
				return nil, err
			}
			timeout := 120
			if in.TimeoutSeconds > 0 {
				timeout = min(in.TimeoutSeconds, 600)
			}
			wctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
			defer cancel()
			done, err := a.WaitSubmission(wctx, sub.ID)
			if err != nil && wctx.Err() == nil {
				return nil, err
			}
			return done, nil
		})
}
