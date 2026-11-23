package mcpserver

import (
	"fmt"

	"codeatrophy/internal/domain"
)

// JSON Schema helpers for tool input schemas. A field with a bound the
// server checks carries it as maxLength or maxItems, taken from the domain
// constants or, for a configurable bound, from the instance's limits when
// the server is built. The schemas are advisory: the server validates the
// arguments itself.

type props map[string]any

func object(p props, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": map[string]any(p)}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }

// maxLen sets the most characters (code points) a string schema allows.
func maxLen(m map[string]any, n int) map[string]any {
	m["maxLength"] = n
	return m
}

// maxItems sets the most elements an array schema allows.
func maxItems(m map[string]any, n int) map[string]any {
	m["maxItems"] = n
	return m
}

func nullableStr(desc string) map[string]any {
	return map[string]any{"type": []any{"string", "null"}, "description": desc}
}

// enumStr is a string schema with the given values; desc may be empty.
func enumStr(desc string, values ...string) map[string]any {
	m := map[string]any{"type": "string", "enum": values}
	if desc != "" {
		m["description"] = desc
	}
	return m
}

// enumOf is enumStr over a list of the domain's values, then extra.
func enumOf[T ~string](desc string, values []T, extra ...string) map[string]any {
	out := make([]string, 0, len(values)+len(extra))
	for _, v := range values {
		out = append(out, string(v))
	}
	return enumStr(desc, append(out, extra...)...)
}

// difficultyOrNull is the enum of a difficulty that may be cleared.
func difficultyOrNull() []any {
	out := make([]any, 0, len(domain.Difficulties)+1)
	for _, d := range domain.Difficulties {
		out = append(out, string(d))
	}
	return append(out, nil)
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
	return enumStr(desc, domain.LanguageIDs()...)
}

var expectedRevision = integer("The revision you last read; if the item has changed since, nothing is written (conflict)")

// testCaseSchema is a new test case, whose generator property genDesc
// describes.
func testCaseSchema(genDesc string) map[string]any {
	return object(props{
		"name":           maxLen(str("Short name, e.g. \"Example 1\"; for a large case, say what the input is"), domain.MaxTestCaseNameChars),
		"stdin":          str("Exact standard input; omit it for a generator"),
		"expectedStdout": str("Exact expected output. Required unless you give a generator; may be a placeholder until verify_test_cases with updateExpected"),
		"isSample":       boolean("Shown with the statement and used by run (default false)"),
		"origin":         enumStr("How the case came to exist (default manual; use ai for cases you wrote)", "manual", "ai", "import"),
		"verified":       boolean("Whether the expected output was produced by running a reference solution"),
		"generator":      generatorSchema(genDesc),
	})
}

// generatorDesc says what a generator is and what the server does with it,
// once, on add_test_cases; the other tools that take one point to it.
const generatorDesc = "For a large case, instead of stdin: a deterministic program (fixed seed, no clock) in a judge " +
	"language that reads nothing and prints the case's stdin, at most limits.maxLargeInputBytes. The server runs it " +
	"before storing anything and stores its output as stdin, with the generator; if it fails or prints another case's " +
	"input, the error is on this field and nothing is stored. Then verify_test_cases with updateExpected: true. " +
	"Given with stdin, both are stored as given and nothing runs"

// itemGeneratorDesc describes the generator of a test case create_item adds.
const itemGeneratorDesc = "For a large case, instead of stdin: a generator, as in add_test_cases"

func generatorSchema(desc string) map[string]any {
	g := object(props{
		"language": languageEnum("Language id"),
		"source":   str("The program: it reads nothing and prints one test input"),
	}, "language", "source")
	if desc != "" {
		g["description"] = desc
	}
	return g
}

func solutionSchema() map[string]any {
	return object(props{
		"language": languageEnum("Language id"),
		"source":   str(solutionSource),
	}, "language", "source")
}

// solutionSource describes the source of a solution or a run.
const solutionSource = "A complete program (stdin to stdout); for a function problem, only the solution part " +
	"(what fills in the stub), run in the harness"

func harnessSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"description": "Function problems: runner code by language id, replacing all entries; the program run is " +
			"prefix, solution, suffix, each on a new line. {} for a program problem",
		"additionalProperties": object(props{
			"prefix": str("Before the solution: imports and helper types (Python: start with `from __future__ import annotations`)"),
			"suffix": str("After the solution: reads one JSON value per line per argument, calls the solution, prints the result as compact JSON"),
		}, "prefix", "suffix"),
	}
}

// itemFieldProps are the writable item fields shared by create_item and
// update_item; lim gives the configurable bounds.
func itemFieldProps(lim domain.Limits) props {
	return props{
		"title":      maxLen(str(fmt.Sprintf("1-%d characters", domain.MaxTitleChars)), domain.MaxTitleChars),
		"summary":    maxLen(str("One sentence"), domain.MaxSummaryChars),
		"body":       str("Markdown body, in the format of get_authoring_guide"),
		"difficulty": map[string]any{"type": []any{"string", "null"}, "enum": difficultyOrNull()},
		"tags": maxItems(arrayOf(maxLen(str("Lower-case tag"), domain.MaxTagChars),
			fmt.Sprintf("Replaces all tags (at most %d, 1-%d characters each)", domain.MaxTags, domain.MaxTagChars)), domain.MaxTags),
		"status":   enumOf("Personal progress", domain.Statuses),
		"favorite": boolean("Personal favorite flag"),
		"notes":    maxLen(str("The user's private Markdown notes, at most limits.maxNotesChars characters (get_overview)"), lim.MaxNotesChars),
		"source": object(props{
			"url":  maxLen(nullableStr("Where the item came from (http or https URL)"), domain.MaxURLChars),
			"note": maxLen(nullableStr("Free-form attribution"), domain.MaxSourceNoteChars),
		}),
		"problem": object(props{
			"interface":         enumStr("What the solver writes: program (a full program, the default) or function (only a function or class, run inside the harness)", "program", "function"),
			"harness":           harnessSchema(),
			"timeLimitMs":       integer(fmt.Sprintf("%d-%d", domain.MinTimeLimitMs, domain.MaxTimeLimitMs)),
			"memoryLimitKb":     integer(fmt.Sprintf("%d-%d", domain.MinMemoryLimitKb, domain.MaxMemoryLimitKb)),
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
		"status":       arrayOf(enumOf("", domain.Statuses), "Any of these statuses"),
		"difficulty":   arrayOf(enumOf("", domain.Difficulties, "none"), "Any of these difficulties"),
		"tag":          arrayOf(str("Tag"), "Items must carry all of these tags"),
		"collectionId": str("Members of this collection"),
		"recursive":    boolean("With collectionId, include descendant collections"),
		"uncollected":  boolean("Only items in no collection"),
		"variantOf":    str("Items derived from this item id"),
		"favorite":     boolean("Filter by favorite flag"),
		"sort":         enumStr("Sort order (default updated)", "updated", "created", "title", "difficulty", "position", "relevance"),
		"order":        enumStr("Direction", "asc", "desc"),
		"limit":        integer(fmt.Sprintf("Page size, 1-%d (default %d)", domain.MaxPageSize, searchLimit)),
		"offset":       integer("Offset for pagination"),
	}
}
