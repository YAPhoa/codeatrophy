package mcpserver

import "codeatrophy/internal/domain"

// JSON Schema helpers for tool input schemas.

type props map[string]any

func object(p props, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": map[string]any(p)}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }

func nullableStr(desc string) map[string]any {
	return map[string]any{"type": []any{"string", "null"}, "description": desc}
}

func enumStr(desc string, values ...string) map[string]any {
	return map[string]any{"type": "string", "description": desc, "enum": values}
}

func integer(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

func boolean(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}

func arrayOf(items map[string]any, desc string) map[string]any {
	return map[string]any{"type": "array", "items": items, "description": desc}
}

func languageEnum(desc string) map[string]any {
	ids := make([]string, len(domain.Languages))
	for i, l := range domain.Languages {
		ids[i] = l.ID
	}
	return enumStr(desc, ids...)
}

var expectedRevision = integer("The item revision you last read. If the item has changed since, the call fails with a conflict and nothing is written.")

func testCaseSchema() map[string]any {
	return object(props{
		"name":           str("Short name, e.g. \"Example 1\""),
		"stdin":          str("Exact standard input"),
		"expectedStdout": str("Exact expected standard output. May be a placeholder when you will run verify_test_cases with updateExpected"),
		"isSample":       boolean("Shown with the statement and used by run (default false)"),
		"origin":         enumStr("How the case came to exist (default manual; use ai for cases you wrote)", "manual", "ai", "import"),
		"verified":       boolean("Whether the expected output was produced by running a reference solution"),
	}, "expectedStdout")
}

func solutionSchema() map[string]any {
	return object(props{
		"language": languageEnum("Language id"),
		"source":   str(solutionSource),
	}, "language", "source")
}

// solutionSource describes the source of a solution or a run.
const solutionSource = "For a program problem, a complete program reading stdin and writing stdout; for a function " +
	"problem, only the solution part (what fills in the stub), which runs inside the language's harness"

func harnessSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"description": "Function problems: runner code keyed by language id; replaces all harness entries. The program " +
			"that runs is prefix, the solution and suffix, each on a new line. Must be {} for a program problem",
		"additionalProperties": object(props{
			"prefix": str("Code before the solution: imports and helper types (Python: start with `from __future__ import annotations`)"),
			"suffix": str("Code after the solution: reads one JSON value per line per argument, calls the solution, prints one compact JSON value"),
		}, "prefix", "suffix"),
	}
}

// itemFieldProps are the writable item fields shared by create_item and
// update_item.
func itemFieldProps() props {
	return props{
		"title":      str("1-200 characters"),
		"summary":    str("One sentence"),
		"body":       str("Markdown body following the authoring conventions"),
		"difficulty": map[string]any{"type": []any{"string", "null"}, "enum": []any{"easy", "medium", "hard", nil}},
		"tags":       arrayOf(str("Lower-case tag"), "Replaces all tags (at most 30, 1-40 characters each)"),
		"status":     enumStr("Personal progress", "todo", "in_progress", "done"),
		"favorite":   boolean("Personal favorite flag"),
		"notes":      str("The user's private Markdown notes"),
		"source": object(props{
			"url":  nullableStr("Where the item came from (http or https URL)"),
			"note": nullableStr("Free-form attribution"),
		}),
		"problem": object(props{
			"interface":         enumStr("What the solver writes: program (a full program, the default) or function (only a function or class, run inside the harness)", "program", "function"),
			"harness":           harnessSchema(),
			"timeLimitMs":       integer("100-30000"),
			"memoryLimitKb":     integer("16384-2097152"),
			"compare":           enumStr("Output comparison", "tokens", "exact"),
			"starterCode":       map[string]any{"type": "object", "description": "Starter code keyed by language id (for a function problem, the stub); replaces all starter code", "additionalProperties": map[string]any{"type": "string"}},
			"referenceSolution": map[string]any{"anyOf": []any{solutionSchema(), map[string]any{"type": "null"}}},
		}),
		"collectionIds": arrayOf(str("Collection id"), "Replaces the item's collection memberships"),
		"variantOf":     nullableStr("Id of the item this one was derived from"),
	}
}

func itemQueryProps() props {
	return props{
		"q":            str("Full-text search over title, summary, body and tags"),
		"id":           arrayOf(str("Item id"), "Only these items (any of them)"),
		"type":         enumStr("Item type", "problem", "reading"),
		"status":       arrayOf(enumStr("", "todo", "in_progress", "done"), "Any of these statuses"),
		"difficulty":   arrayOf(enumStr("", "easy", "medium", "hard", "none"), "Any of these difficulties"),
		"tag":          arrayOf(str("Tag"), "Items must carry all of these tags"),
		"collectionId": str("Members of this collection"),
		"recursive":    boolean("With collectionId, include descendant collections"),
		"uncollected":  boolean("Only items in no collection"),
		"variantOf":    str("Items derived from this item id"),
		"favorite":     boolean("Filter by favorite flag"),
		"sort":         enumStr("Sort order (default updated)", "updated", "created", "title", "difficulty", "position", "relevance"),
		"order":        enumStr("Direction", "asc", "desc"),
		"limit":        integer("Page size, 1-200 (default 50)"),
		"offset":       integer("Offset for pagination"),
	}
}
