package ai

import (
	"slices"

	"codeatrophy/internal/domain"
)

// Schema helpers. Every object lists all of its properties as required and
// forbids additional properties, which is what strict structured-output
// modes require.

func obj(props map[string]any) map[string]any {
	req := make([]string, 0, len(props))
	for k := range props {
		req = append(req, k)
	}
	slices.Sort(req)
	return map[string]any{"type": "object", "properties": props, "required": req, "additionalProperties": false}
}

func str(desc string) map[string]any {
	m := map[string]any{"type": "string"}
	if desc != "" {
		m["description"] = desc
	}
	return m
}

func enum(desc string, values ...string) map[string]any {
	m := str(desc)
	m["enum"] = values
	return m
}

func integer(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

func boolean(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}

func array(items any, desc string) map[string]any {
	m := map[string]any{"type": "array", "items": items}
	if desc != "" {
		m["description"] = desc
	}
	return m
}

func nullable(s map[string]any) map[string]any {
	return map[string]any{"anyOf": []any{s, map[string]any{"type": "null"}}}
}

func languageIDs() []string {
	out := make([]string, len(domain.Languages))
	for i, l := range domain.Languages {
		out[i] = l.ID
	}
	return out
}

// largeCaseSchema is the generator of a large test case, asked for only
// when a generation wants one.
func largeCaseSchema() map[string]any {
	return nullable(obj(map[string]any{
		"name":      str("What the input is, e.g. \"30,000 values in runs of three\""),
		"rationale": str("Why this input makes a slow solution run out of time, one sentence"),
		"language":  enum("Language id of the generator; one the judge runs", languageIDs()...),
		"source":    str("Complete program that reads nothing and prints the stdin of one large test case"),
	}))
}

// DraftSchema is the output schema for drafts and variants; with large it
// also asks for the generator of a large test case.
func DraftSchema(large bool) map[string]any {
	starter := obj(map[string]any{
		"language": enum("Language id", languageIDs()...),
		"source":   str("Program problem: starter code that reads the input. Function problem: the stub the solver fills in"),
	})
	harness := obj(map[string]any{
		"language": enum("Language id", languageIDs()...),
		"prefix":   str("Code before the solver's code: imports, helper type definitions (Python: first line `from __future__ import annotations`)"),
		"suffix":   str("Code after the solver's code: reads one JSON value per line per argument, calls the solution, prints one compact JSON value"),
	})
	reference := obj(map[string]any{
		"language": enum("Language id; for a function problem one that has a harness", languageIDs()...),
		"source":   str("Program problem: a complete program. Function problem: only the solution part, as a solver would write it"),
	})
	problem := obj(map[string]any{
		"interface":         enum("What the solver writes: program (a full program) or function (only a function or class)", "program", "function"),
		"timeLimitMs":       integer("Time limit in milliseconds, 100-30000"),
		"memoryLimitKb":     integer("Memory limit in KB, 16384-2097152"),
		"compare":           enum("Output comparison: tokens (whitespace-insensitive) or exact", "tokens", "exact"),
		"starterCode":       array(starter, "Starter code per language"),
		"harness":           array(harness, "Function problems: runner code per language; empty for a program problem"),
		"referenceSolution": nullable(reference),
	})
	testCase := obj(map[string]any{
		"name":           str("Short name, e.g. \"Example 1\""),
		"stdin":          str("Exact standard input"),
		"expectedStdout": str("Exact expected standard output"),
		"isSample":       boolean("Shown with the statement"),
	})
	props := map[string]any{
		"type":        enum("Item type", "problem", "reading"),
		"title":       str("Short, specific title"),
		"summary":     str("One-sentence summary"),
		"body":        str("Markdown body following the conventions"),
		"difficulty":  nullable(enum("Difficulty", "easy", "medium", "hard")),
		"tags":        array(str(""), "1-6 lower-case topic tags"),
		"problem":     nullable(problem),
		"testCases":   array(testCase, "Sample test cases (empty for readings)"),
		"assumptions": array(str(""), "What the user should check: inferred or invented content, most important first"),
	}
	if large {
		props["largeCase"] = largeCaseSchema()
	}
	return obj(props)
}

// ModelLargeCase is the generator of a large test case a model wrote.
type ModelLargeCase struct {
	Name      string `json:"name"`
	Rationale string `json:"rationale"`
	Language  string `json:"language"`
	Source    string `json:"source"`
}

// ModelDraft is the decoded output of DraftSchema.
type ModelDraft struct {
	Type       string   `json:"type"`
	Title      string   `json:"title"`
	Summary    string   `json:"summary"`
	Body       string   `json:"body"`
	Difficulty *string  `json:"difficulty"`
	Tags       []string `json:"tags"`
	Problem    *struct {
		Interface     string `json:"interface"`
		TimeLimitMs   int    `json:"timeLimitMs"`
		MemoryLimitKb int    `json:"memoryLimitKb"`
		Compare       string `json:"compare"`
		StarterCode   []struct {
			Language string `json:"language"`
			Source   string `json:"source"`
		} `json:"starterCode"`
		Harness []struct {
			Language string `json:"language"`
			Prefix   string `json:"prefix"`
			Suffix   string `json:"suffix"`
		} `json:"harness"`
		ReferenceSolution *struct {
			Language string `json:"language"`
			Source   string `json:"source"`
		} `json:"referenceSolution"`
	} `json:"problem"`
	TestCases []struct {
		Name           string `json:"name"`
		Stdin          string `json:"stdin"`
		ExpectedStdout string `json:"expectedStdout"`
		IsSample       bool   `json:"isSample"`
	} `json:"testCases"`
	Assumptions []string        `json:"assumptions"`
	LargeCase   *ModelLargeCase `json:"largeCase"`
}

// TestCasesSchema is the output schema for test-case generation. The
// reference solution must be in the requested language; for a function
// problem it is only the solution part.
func TestCasesSchema(language string, function, large bool) map[string]any {
	source := "Complete program reading stdin and writing stdout"
	if function {
		source = "Only the solution part, filling in the stub; the harness turns it into a program"
	}
	props := map[string]any{
		"referenceSolution": obj(map[string]any{
			"language": enum("Language id; must be the requested language", language),
			"source":   str(source),
		}),
		"cases": array(obj(map[string]any{
			"name":            str("Short name"),
			"rationale":       str("Why this case is useful, one sentence"),
			"stdin":           str("Exact standard input"),
			"predictedStdout": str("The output you expect the reference solution to print"),
			"isSample":        boolean("Whether to show it with the statement"),
		}), "Proposed test cases"),
	}
	if large {
		props["largeCase"] = largeCaseSchema()
	}
	return obj(props)
}

// ModelTestCases is the decoded output of TestCasesSchema.
type ModelTestCases struct {
	ReferenceSolution struct {
		Language string `json:"language"`
		Source   string `json:"source"`
	} `json:"referenceSolution"`
	Cases []struct {
		Name            string `json:"name"`
		Rationale       string `json:"rationale"`
		Stdin           string `json:"stdin"`
		PredictedStdout string `json:"predictedStdout"`
		IsSample        bool   `json:"isSample"`
	} `json:"cases"`
	LargeCase *ModelLargeCase `json:"largeCase"`
}

// PingSchema is the output schema of a connection test.
func PingSchema() map[string]any {
	return obj(map[string]any{"ok": boolean("Always true")})
}
