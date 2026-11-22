package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"slices"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

type tools struct {
	app *app.App
	// pretty indents the JSON of results.
	pretty bool
	log    *slog.Logger
}

// toolFunc returns the value of a tool's result, which is sent as JSON with
// test data elided above elideBytes, unless it is a limited or a textResult.
type toolFunc func(ctx context.Context, args json.RawMessage) (any, error)

// limited is a tool result whose test data is elided above limit bytes
// instead of elideBytes.
type limited struct {
	v     any
	limit int
}

// textResult is a tool result sent as plain text only, for a model to read
// as it is: no JSON and no structured content.
type textResult string

// searchLimit is search_items's default page size, smaller than the HTTP
// API's, since every summary is paid for in a model's context.
const searchLimit = 20

// fullDesc describes the full argument of the tools that offer it.
const fullDesc = "Return test data up to 16 KiB whole instead of shortening it above 2 KiB"

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
		func(ctx context.Context, req *mcp.CallToolRequest) (res *mcp.CallToolResult, err error) {
			// A panic is an internal error of this call, as it is over the
			// HTTP API, and must not end the process (the SDK runs each
			// call on a goroutine of its own, with no recovery).
			defer func() {
				if p := recover(); p != nil {
					t.log.Error("panic in an MCP tool", "tool", name, "panic", p, "stack", string(debug.Stack()))
					res, err = toolError(errors.New("panic"), t.pretty), nil
				}
			}()
			var raw json.RawMessage
			if req.Params != nil {
				raw = req.Params.Arguments
			}
			ctx = app.WithChangeSource(ctx, domain.ViaMCP, clientName(req), modelArg(raw))
			v, err := fn(ctx, raw)
			if err != nil {
				t.logError(ctx, name, err)
				return toolError(err, t.pretty), nil
			}
			switch r := v.(type) {
			case textResult:
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(r)}}}, nil
			case limited:
				return result(r.v, r.limit, t.pretty), nil
			}
			return result(v, elideBytes, t.pretty), nil
		})
}

// logError logs a tool's internal error, whose cause its result does not
// tell the client, as the HTTP API logs one (a call the client cancelled
// is only noted).
func (t *tools) logError(ctx context.Context, name string, err error) {
	if ctx.Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		t.log.Debug("MCP tool call canceled by the client", "tool", name)
		return
	}
	if app.AsError(err).Code == app.CodeInternal {
		t.log.Error("MCP tool failed", "tool", name, "error", err)
	}
}

// clientName is the name the client gave in the initialize handshake, or
// "".
func clientName(req *mcp.CallToolRequest) string {
	if info := req.ClientInfo(); info != nil {
		return info.Name
	}
	return ""
}

// modelArg is the optional model argument of a tool call, or "" when it is
// missing or not a string. It is never an error.
func modelArg(raw json.RawMessage) string {
	var in struct {
		Model json.RawMessage `json:"model"`
	}
	var model string
	if json.Unmarshal(raw, &in) == nil && json.Unmarshal(in.Model, &model) == nil {
		return model
	}
	return ""
}

// tracked adds the optional model argument to the schema of a tool that
// changes an item's content.
func tracked(schema map[string]any) map[string]any {
	// No maxLength: a long value is cut by the server, never refused.
	schema["properties"].(map[string]any)["model"] = str("Your model id, for tracking")
	return schema
}

type idArg struct {
	ID string `json:"id"`
}

// matchedResult is a verification result whose output matched: it leaves
// out actualStdout, which equals the expected output the caller has. The
// outer field hides the embedded one when encoding.
type matchedResult struct {
	app.VerifyResult
	ActualStdout *string `json:"actualStdout,omitempty"`
}

// verifyView is a verification as a tool returns it: actualStdout only on
// the results that did not match.
func verifyView(res app.VerifyResponse) map[string]any {
	out := make([]any, len(res.Results))
	for i, r := range res.Results {
		if r.Matches {
			out[i] = matchedResult{VerifyResult: r}
		} else {
			out[i] = r
		}
	}
	return map[string]any{"results": out}
}

// summary is the result of the tools that write an item: its summary, as
// search_items lists it, without the body the caller has just sent.
func summary(it domain.Item, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return it.ItemSummary, nil
}

func (t *tools) register(s *mcp.Server) {
	a := t.app
	lim := a.Limits()

	// Reading.
	t.add(s, "get_overview", "Library overview",
		"Library statistics, collections, tags with item counts, the judge's languages, the user's test case preferences (read-only) and the limits items and test cases keep to. A good first call.",
		object(props{}), readOnly, func(ctx context.Context, _ json.RawMessage) (any, error) {
			return a.Overview(ctx)
		})

	t.add(s, "get_authoring_guide", "Authoring guide",
		"The authoring guide, as Markdown text rather than JSON: the format of items and test cases and the user's writing style. Call it once per session before writing item content.",
		object(props{
			"style": str("Name or id of a style preset to write in (default: the user's default preset; see list_style_presets)"),
		}), readOnly, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				Style string `json:"style"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			preset, err := stylePreset(ctx, a, in.Style)
			if err != nil {
				return nil, &app.Error{Code: app.CodeNotFound, Message: err.Error()}
			}
			return textResult(guide(ctx, a, preset)), nil
		})

	t.add(s, "search_items", "Search items",
		"Filter and full-text search the library (the filters of GET /items). Returns item summaries, without bodies, and the total count.",
		object(itemQueryProps()), readOnly, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var q app.ItemQuery
			if err := decodeArgs(raw, &q); err != nil {
				return nil, err
			}
			if q.Limit == nil {
				l := searchLimit
				q.Limit = &l
			}
			return a.ListItems(ctx, q)
		})

	t.add(s, "get_item", "Get item",
		"One item in full, with its links; available: false marks a deleted item, in links and in variantOrigin. include adds optional parts: testCases, solutions, submissions (the 10 most recent submits; runs are not kept).",
		object(props{
			"id":      str("Item id"),
			"include": arrayOf(enumStr("", "testCases", "solutions", "submissions"), "Optional parts to include"),
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
			links, err := a.ItemLinks(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			out := map[string]any{"item": it, "links": links.Links}
			if slices.Contains(in.Include, "testCases") && it.Type == domain.TypeProblem {
				tcs, err := a.ListTestCases(ctx, in.ID)
				if err != nil {
					return nil, err
				}
				out["testCases"] = tcs.Items
			}
			if slices.Contains(in.Include, "solutions") && it.Type == domain.TypeProblem {
				sols, err := a.ListSolutions(ctx, in.ID)
				if err != nil {
					return nil, err
				}
				out["solutions"] = sols.Items
			}
			if slices.Contains(in.Include, "submissions") {
				limit := 10
				subs, err := a.ListSubmissions(ctx, in.ID, app.SubmissionQuery{Mode: string(domain.ModeSubmit), Limit: &limit})
				if err != nil {
					return nil, err
				}
				out["submissions"] = subs.Items
			}
			return out, nil
		})

	t.add(s, "list_test_cases", "List test cases", "The test cases of a problem, in order.",
		object(props{
			"itemId": str("Problem id"),
			"ids":    arrayOf(str("Test case id"), "Only these test cases; an id that is not one of the problem's is ignored"),
			"full":   boolean(fullDesc),
		}, "itemId"), readOnly,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID string   `json:"itemId"`
				IDs    []string `json:"ids"`
				Full   bool     `json:"full"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			tcs, err := a.ListTestCases(ctx, in.ItemID)
			if err != nil {
				return nil, err
			}
			if in.IDs != nil {
				tcs.Items = slices.DeleteFunc(tcs.Items, func(tc domain.TestCase) bool { return !slices.Contains(in.IDs, tc.ID) })
			}
			return limited{tcs, elideLimit(in.Full)}, nil
		})

	t.add(s, "list_solutions", "List solutions",
		"The saved solutions of a problem, the reference solution first, then oldest first.",
		object(props{"itemId": str("Problem id")}, "itemId"), readOnly,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID string `json:"itemId"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.ListSolutions(ctx, in.ItemID)
		})

	t.add(s, "get_submission", "Get submission", "A submission with its per-case results.",
		object(props{"id": str("Submission id"), "full": boolean(fullDesc)}, "id"), readOnly,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ID   string `json:"id"`
				Full bool   `json:"full"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			sub, err := a.GetSubmission(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			return limited{sub, elideLimit(in.Full)}, nil
		})

	t.add(s, "list_style_presets", "List style presets",
		"The user's style presets (standing writing instructions) and which one is the default. Read-only: only the user changes them, in the app's settings.",
		object(props{}), readOnly, func(ctx context.Context, _ json.RawMessage) (any, error) {
			return a.ListStylePresets(ctx)
		})

	// Writing items.
	createProps := itemFieldProps(lim)
	createProps["type"] = enumStr("Item type", "problem", "reading")
	createProps["testCases"] = arrayOf(testCaseSchema(itemGeneratorDesc), "Test cases to create with the item (problems only)")
	t.add(s, "create_item", "Create item",
		"Create a problem or reading, in the format get_authoring_guide gives. May include tags, collectionIds, variantOf and test cases in the same call. A solution-only problem sets problem.interface to function, with starterCode (the stubs) and a harness entry per language. Returns the item's summary, with its revision.",
		tracked(object(createProps, "type", "title")), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in domain.ItemInput
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return summary(a.CreateItem(ctx, in))
		})

	updateProps := itemFieldProps(lim)
	updateProps["id"] = str("Item id")
	updateProps["expectedRevision"] = expectedRevision
	t.add(s, "update_item", "Update item",
		"Partial update of an item, in the format get_authoring_guide gives (merge semantics: omitted fields are unchanged; arrays replace; null clears a nullable field; problem and source merge field by field; problem.starterCode and problem.harness replace all entries). Setting problem.interface to program on a problem with a harness needs harness: {} in the same call. Returns the item's summary.",
		tracked(object(updateProps, "id")), idempotent, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var id idArg
			var in domain.ItemInput
			if err := decodeArgs(raw, &id); err != nil {
				return nil, err
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return summary(a.UpdateItem(ctx, id.ID, in))
		})

	t.add(s, "edit_item_text", "Edit item text",
		"Exact-match text replacements inside body or notes, for small changes to long text. Each oldText must occur exactly once when its edit is applied; otherwise nothing is written. Returns the item's summary.",
		tracked(object(props{
			"id":    str("Item id"),
			"field": enumStr("Which text to edit", "body", "notes"),
			"edits": arrayOf(object(props{
				"oldText": str("Exact text to replace; must occur exactly once"),
				"newText": str("Replacement text"),
			}, "oldText", "newText"), "Edits, applied in order"),
			"expectedRevision": expectedRevision,
		}, "id", "field", "edits")), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var id idArg
			var in app.EditTextInput
			if err := decodeArgs(raw, &id); err != nil {
				return nil, err
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return summary(a.EditItemText(ctx, id.ID, in))
		})

	t.add(s, "delete_item", "Delete item", "Delete an item with its test cases and submissions. Links to it and the variantOf of its variants are kept, and then name an unavailable item.",
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
		tracked(object(props{
			"ids":          arrayOf(str("Item id"), "Items to change"),
			"action":       enumStr("Action", "delete", "addTags", "removeTags", "setStatus", "setFavorite", "addToCollection", "removeFromCollection"),
			"tags":         arrayOf(maxLen(str("Tag"), domain.MaxTagChars), "For addTags and removeTags"),
			"status":       enumStr("For setStatus", "todo", "in_progress", "done"),
			"favorite":     boolean("For setFavorite"),
			"collectionId": str("For addToCollection and removeFromCollection"),
		}, "ids", "action")), destructive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in app.BulkInput
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.BulkItems(ctx, in)
		})

	// Linking.
	linking := func(maxIDs int, desc string) map[string]any {
		return object(props{
			"itemId":   str("Item id"),
			"otherIds": maxItems(arrayOf(str("Item id"), desc), maxIDs),
		}, "itemId", "otherIds")
	}
	t.add(s, "link_items", "Link items",
		fmt.Sprintf("Link an item to closely related items, such as a problem and the reading that explains its technique. Links go both ways, have no label and are not content (the revision stays); linking a linked pair does nothing. If an id names no item, nothing is linked and the error names each bad one (otherIds.<index>). An item has at most %d links (limits.maxLinksPerItem). Returns the item's links.", lim.MaxLinksPerItem),
		linking(lim.MaxLinksPerItem, fmt.Sprintf("The other items, at most %d", lim.MaxLinksPerItem)), idempotent, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID   string   `json:"itemId"`
				OtherIDs []string `json:"otherIds"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.LinkItems(ctx, in.ItemID, in.OtherIDs)
		})

	t.add(s, "unlink_items", "Unlink items",
		"Remove the links between an item and other items, also to deleted items (available: false). An id that is not linked is ignored. Returns the item's links.",
		linking(domain.MaxLinksPerItemCeiling, fmt.Sprintf("The other items, at most %d", domain.MaxLinksPerItemCeiling)), idempotent, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID   string   `json:"itemId"`
				OtherIDs []string `json:"otherIds"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			return a.UnlinkItems(ctx, in.ItemID, in.OtherIDs)
		})

	// Organising.
	t.add(s, "create_collection", "Create collection", "Create a collection, optionally nested under a parent. It is appended after its siblings.",
		object(props{
			"name":        maxLen(str(fmt.Sprintf("1-%d characters", domain.MaxCollectionNameChars)), domain.MaxCollectionNameChars),
			"description": maxLen(str("Optional description"), domain.MaxCollectionDescriptionChars),
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
			"name":        maxLen(str("New name"), domain.MaxCollectionNameChars),
			"description": maxLen(str("New description"), domain.MaxCollectionDescriptionChars),
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
		tracked(object(props{"name": str("Current tag name"), "newName": maxLen(str("New tag name"), domain.MaxTagChars)}, "name", "newName")), idempotent,
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

	t.add(s, "delete_tag", "Delete tag", "Remove a tag from every item and delete it, so that it is no longer listed.",
		tracked(object(props{"name": str("Tag name")}, "name")), destructive,
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
		"Append test cases to a problem, or replace all of them with replace: true. May set the reference solution in the same call (item content: pass expectedRevision then; for a function problem, only the solution part). Give a large case as a generator instead of stdin. Returns the problem's test cases, with test data over 512 bytes shortened.",
		tracked(object(props{
			"itemId":            str("Problem id"),
			"cases":             arrayOf(testCaseSchema(generatorDesc), "Test cases to add"),
			"replace":           boolean("Replace the existing test cases; sample cases are kept"),
			"referenceSolution": map[string]any{"anyOf": []any{solutionSchema(), map[string]any{"type": "null"}}},
			"expectedRevision":  expectedRevision,
		}, "itemId", "cases")), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID string `json:"itemId"`
				app.BulkTestCasesInput
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			tcs, err := a.BulkTestCases(ctx, in.ItemID, in.BulkTestCasesInput)
			if err != nil {
				return nil, err
			}
			return limited{tcs, echoElideBytes}, nil
		})

	t.add(s, "update_test_case", "Update test case",
		"Change one test case (partial). Changing stdin or expectedStdout resets verified unless you set it; setting stdin without a generator drops the generator. Returns the case, with test data over 512 bytes shortened.",
		tracked(object(props{
			"id":             str("Test case id"),
			"name":           maxLen(str("Name"), domain.MaxTestCaseNameChars),
			"stdin":          str("Standard input"),
			"expectedStdout": str("Expected output"),
			"isSample":       boolean("Sample flag"),
			"verified":       boolean("Verified flag"),
			"generator": map[string]any{"anyOf": []any{generatorSchema(""), map[string]any{"type": "null"}},
				"description": "A generator as in add_test_cases: it runs and its output replaces stdin. null drops the generator and keeps stdin; stdin with a non-null generator is refused"},
		}, "id")), idempotent, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ID string `json:"id"`
				domain.TestCaseInput
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			tc, err := a.UpdateTestCase(ctx, in.ID, in.TestCaseInput)
			if err != nil {
				return nil, err
			}
			return limited{tc, echoElideBytes}, nil
		})

	t.add(s, "delete_test_case", "Delete test case", "Delete one test case.",
		tracked(object(props{"id": str("Test case id")}, "id")), destructive,
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
		"Run a saved solution on every test case. With the reference solution (the default), each case is marked verified or not by whether its output matches, and with updateExpected: true mismatching cases take the actual output as expected. Another solutionId only checks that solution and leaves the cases alone. Either way the run becomes the solution's lastRun, unless the engine failed on a case. A function problem runs in the language's harness (a language without one is rejected). Matching results leave out actualStdout. Needs a judge engine.",
		tracked(object(props{
			"itemId":         str("Problem id"),
			"solutionId":     str("Solution to run; omit for the reference solution"),
			"updateExpected": boolean("Replace expected outputs with the actual output (reference solution only)"),
			"full":           boolean(fullDesc),
		}, "itemId")), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID         string `json:"itemId"`
				UpdateExpected bool   `json:"updateExpected"`
				SolutionID     string `json:"solutionId"`
				Full           bool   `json:"full"`
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			res, err := a.VerifyTestCases(ctx, in.ItemID, in.UpdateExpected, in.SolutionID)
			if err != nil {
				return nil, err
			}
			return limited{verifyView(res), elideLimit(in.Full)}, nil
		})

	t.add(s, "save_solution", "Save solution",
		"Create a saved solution on a problem (give itemId), or change one (give id; omitted fields are kept). isReference: true makes it the reference solution, which computes and verifies expected outputs, and clears the flag on the others. Changing which solution is the reference, or the reference's language or source, is item content: pass expectedRevision then. lastRun is its last run on the test cases; a new language or source clears it.",
		tracked(object(props{
			"itemId":           str("Problem id, to create a solution"),
			"id":               str("Solution id, to change an existing solution"),
			"name":             maxLen(str("Short single-line name, e.g. the approach"), domain.MaxSolutionNameChars),
			"language":         languageEnum("Language id"),
			"source":           str(solutionSource),
			"notes":            maxLen(str("Markdown notes, e.g. complexity"), domain.MaxSolutionNotesChars),
			"isReference":      boolean("Make this the reference solution"),
			"expectedRevision": expectedRevision,
			"submissionId":     str("When creating: a completed run_code submission of this problem with the same language and source, whose figures become lastRun; ignored otherwise"),
		})), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID string `json:"itemId"`
				ID     string `json:"id"`
				domain.ItemSolutionInput
			}
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			switch {
			case in.ID != "" && in.ItemID != "":
				return nil, &app.Error{Code: app.CodeValidation, Message: "give either id (to change a solution) or itemId (to create one), not both"}
			case in.ID != "":
				return a.UpdateSolution(ctx, in.ID, in.ItemSolutionInput)
			case in.ItemID != "":
				return a.CreateSolution(ctx, in.ItemID, in.ItemSolutionInput)
			}
			return nil, &app.Error{Code: app.CodeValidation, Message: "give id to change a solution or itemId to create one"}
		})

	t.add(s, "delete_solution", "Delete solution",
		"Delete one saved solution. Deleting the reference solution leaves the problem without one.",
		tracked(object(props{"id": str("Solution id")}, "id")), destructive,
		func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in idArg
			if err := decodeArgs(raw, &in); err != nil {
				return nil, err
			}
			if err := a.DeleteSolution(ctx, in.ID); err != nil {
				return nil, err
			}
			return map[string]any{"deleted": in.ID}, nil
		})

	t.add(s, "run_code", "Run code",
		"Execute code for a problem and wait for the verdict. For a function problem give only the solution part: it runs inside the language's harness, line numbers in errors refer to it (<runner prefix> and <runner suffix> mark lines in the runner) and lineOffset is how many lines the harness puts before it. Only submits are kept: a run replaces the problem's earlier completed runs. Needs a judge engine.",
		object(props{
			"itemId":         str("Problem id"),
			"language":       languageEnum("Language id; for a function problem, one with a harness"),
			"source":         str(solutionSource),
			"mode":           enumStr("run (default): the sample cases, or stdin; submit: all cases", "run", "submit"),
			"stdin":          nullableStr("Custom input for a run; omit to use the sample cases"),
			"timeoutSeconds": integer("How long to wait for the verdict (default 120, max 600)"),
			"full":           boolean(fullDesc),
		}, "itemId", "language", "source"), additive, func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in struct {
				ItemID string `json:"itemId"`
				app.SubmissionInput
				TimeoutSeconds int  `json:"timeoutSeconds"`
				Full           bool `json:"full"`
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
			return limited{done, elideLimit(in.Full)}, nil
		})
}
