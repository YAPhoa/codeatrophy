package ai

import "strings"

// The authoring conventions are the rules every item follows, whether it was
// drafted by the built-in AI features or written by an assistant over MCP.
//
// They are made of two kinds of part. The editable parts are conventions for
// the prose: how a statement is laid out, how readings are structured, what
// makes a good title or test set. A user may replace all of them with a text
// of their own (a custom system prompt). The fixed parts are rules the app
// depends on: the stdin/stdout judging, the program and function interfaces
// and their harness protocol, the folded input region, comparison, limits,
// language ids and versions, and expected outputs coming from a reference
// solution. They always apply.
//
// Without a custom text the parts are sent interleaved, in their order here,
// as AuthoringConventions. With one, the custom text is sent followed by
// FixedConventions.

// convPart is one part of the conventions: a heading, or a run of text under
// the latest heading.
type convPart struct {
	heading string // "## Problems", …; the part is a heading when set
	fixed   bool
	text    string
}

var convParts = []convPart{
	{text: `# Codeatrophy authoring conventions

An item is either a **problem** (a coding challenge judged by running code) or
a **reading** (a technical note or article).
`},
	{heading: "## Problems"},
	{fixed: true, text: `- Every problem is judged on a **stdin/stdout** basis: a program reads a test
  case from standard input and its standard output is compared with the
  expected output. Never ask for interactive I/O.
- The **interface** says what the solver writes:
  - ` + "`program`" + `: the whole program, which reads the input and prints the answer.
  - ` + "`function`" + `: only the solution, a function or a class, as on interview
    sites. Hidden per-language runner code (the **harness**) turns it into a
    program.
`},
	{text: `- Choose ` + "`function`" + ` for an algorithmic problem whose heart is one routine
  (data in, value out). Choose ` + "`program`" + ` when reading and printing are part
  of the task, for simulations and design exercises with many operations, or
  when the source text is written that way. An explicit choice by the user
  settles it.
- The body is GitHub-flavoured Markdown (math with $...$ and $$...$$) with
  these sections, in this order:
  1. ` + "`## Problem`" + `: the statement of the task, written so that it can be solved
     from the statement alone.
  2. ` + "`## Input`" + `: for a program, the exact input format, line by line,
     naming every value; for a function, each parameter with its type.
  3. ` + "`## Output`" + `: for a program, the exact output format; for a function,
     what it returns, giving the return value a name when the function also
     changes an argument in place. When a function problem's runner prints
     anything other than the plain return value (an in-place result, a
     normalised order), say in one sentence what a test's output shows.
  4. ` + "`## Examples`" + `: at least one example as fenced code blocks (input, then
     output; for a function, the arguments as the solver would write them and
     the output exactly as the runner prints it), each followed by a
     short explanation when it helps.
  5. ` + "`## Constraints`" + `: bounds for every input value, e.g. $1 \le n \le 10^5$.
  6. ` + "`## Notes`" + ` (optional): hints, edge cases, references.
`},
	{fixed: true, text: `- When several answers are valid, the statement must say which one counts
  (for example "print the smallest index first") or, for a function, the
  runner must normalise the result (for example sort it) before printing,
  because output is compared automatically.
- Output is compared token by token (whitespace-insensitive) unless the
  problem uses exact comparison, so do not rely on spacing.
- Time limits are in milliseconds (100–30000, typically 1000–2000) and memory
  limits in KB (16384–2097152, typically 262144).
- Language ids: c, cpp, csharp, go, java, javascript, kotlin, python, ruby,
  rust, typescript.
- Write all code for the language versions the judge actually runs, which
  can be old (for example Python 3.8, Java 13, Go 1.13, Node.js 12, Rust
  1.40): no newer syntax or library functions.
`},
	{heading: "### Program problems"},
	{text: `- Starter code, when given, reads the input in the documented format and
  leaves the solving to the user.
`},
	{fixed: true, text: `- In starter code, put the lines that only read the input between two
  comment lines, ` + "`# region input`" + ` and ` + "`# endregion`" + ` (` + "`// region input`" + ` and
  ` + "`// endregion`" + ` in languages with ` + "`//`" + ` comments). The editor shows them
  folded. The place where the solver writes stays outside the region.
- Java code uses ` + "`public class Main`" + `; Kotlin uses a top-level ` + "`fun main()`" + `.
`},
	{heading: "### Function problems"},
	{fixed: true, text: `For each language there are three parts. The program that runs is the
prefix, the solver's code and the suffix, each starting on a new line:

- **Starter code** (the stub) is what the solver sees: the class and method
  (or function) with a precise signature and types. It must compile and run
  as it stands, so its body is a placeholder with no logic (` + "`pass`" + ` in
  Python, a typed zero value elsewhere: ` + "`return 0;`" + `, ` + "`return {};`" + `,
  ` + "`return nullptr;`" + `, ` + "`return null;`" + ` …), and an untouched stub ends in a
  plain wrong answer. Helper types the signature uses (list nodes, tree
  nodes) are **described in a comment**, never defined there, because the
  real definition is in the prefix. The comment is the first thing in the
  stub, above the class, never inside it. Every language's stub carries
  it, in its own comment syntax: it is the only place the solver sees the
  type's fields. For example:

  ` + "```" + `python
  # Definition for singly-linked list.
  # class ListNode:
  #     def __init__(self, val=0, next=None):
  #         self.val = val
  #         self.next = next
  class Solution:
      def mergeKLists(self, lists: list[ListNode | None]) -> ListNode | None:
          pass
  ` + "```" + `

- The **harness prefix** holds what the solution relies on but should not have
  to write: imports and the real definitions of the helper types. Imports
  cannot follow the solver's code in most languages, so the prefix imports
  what a solution is likely to need (in Go, keep each import used, e.g.
  ` + "`var _ = sort.Ints`" + `). A **Python prefix must begin with
  ` + "`from __future__ import annotations`" + `**, its very first line, so that hints
  such as ` + "`list[int]`" + ` or ` + "`ListNode | None`" + ` in the solver's code do not fail on
  Python 3.8.
- The **harness suffix** reads one test case from stdin, builds the arguments,
  calls the solution once and prints the result:
  - input: one JSON value per line, one line per argument, in signature
    order; a linked list or tree is written as the array a person would
    write (` + "`[1,4,5]`" + `, ` + "`[3,9,20,null,null,15,7]`" + `) and the suffix converts it;
  - output: the return value, as exactly one JSON value on one line, compact
    (no spaces: ` + "`[1,2,3]`" + `), with ` + "`true`" + `/` + "`false`" + `/` + "`null`" + `, structures converted
    back to arrays, so that every language prints the same text; normalise
    the result first when several answers are valid;
  - a function that changes an argument in place: when it returns nothing,
    print that argument after the call, the same way. When it also returns
    a value, print two lines, the return value and then the argument, each
    as ` + "`name = value`" + ` with the names the statement uses and one space on
    each side of the ` + "`=`" + ` (` + "`k = 2`" + `, then ` + "`nums = [1,2]`" + `), showing only the part
    of the argument that counts. Never pack the two into one array: the
    output must read like the signature;
  - no other output, no assumptions about the solver's helper names, and no
    crash on the smallest valid input.
- Language layout. Java: imports and helper classes in the prefix, the
  solver's ` + "`class Solution`" + ` is not public, ` + "`public class Main`" + ` with ` + "`main`" + ` in the
  suffix (the file is Main.java; Java has no JSON parser, so parse the needed
  shapes by hand). C++: includes, ` + "`using namespace std;`" + ` and helper structs in
  the prefix, ` + "`main`" + ` in the suffix. Kotlin: imports and helper classes in the
  prefix, a top-level ` + "`fun main()`" + ` in the suffix. Go: ` + "`package main`" + ` and the
  imports in the prefix. TypeScript: ` + "`declare const require: any;`" + ` in the
  prefix to read stdin. Others: declarations before, the driver after.
- Every language with starter code needs a harness entry; a language without
  one cannot be used for the problem.
- Test cases and reference solutions follow the same split: test-case
  stdin is the JSON-per-line input, the expected output is what the suffix
  prints, and a reference solution is only the solution part, exactly as a
  solver would write it.
`},
	{heading: "## Test cases"},
	{fixed: true, text: `- Each test case is a stdin and the exact expected stdout.
- Sample cases (` + "`isSample: true`" + `) are shown with the statement and used by "Run";
  they should match the examples in the body. Hidden cases are used by
  "Submit".
`},
	{text: `- A good test set covers: the examples, minimum sizes, maximum sizes (or close
  to them, within reason), edge values (zero, negative, duplicates, all equal,
  already sorted / reverse sorted, empty answer), and cases that defeat common
  wrong approaches.
`},
	{fixed: true, text: `- Expected outputs must come from running a reference solution, never from
  hand computation. Provide the reference solution together with the inputs
  and verify, so the server computes the expected output.
`},
	{heading: "## Readings"},
	{text: `- The body is a well-structured Markdown article or note: a short
  introduction, sections with headings, code samples in fenced blocks with a
  language tag, and a short summary or key takeaways.
`},
	{heading: "## All items"},
	{text: `- Title: short and specific (at most 200 characters).
- Summary: one sentence saying what the item is about.
- Tags: 1–6 lower-case topic labels such as "dynamic-programming", "graphs",
  "hash-map", "concurrency" (at most 40 characters each). Prefer tags that
  already exist in the library.
- Difficulty: easy, medium or hard (or null for readings without one).
- Never use an em dash in anything you write (title, summary, body, notes):
  use a comma, a colon, parentheses or a new sentence.
`},
}

// fixedIntro opens FixedConventions.
const fixedIntro = "# Fixed rules\n\n" +
	"These rules are how the app works, and they always apply. Where the\n" +
	"conventions above say otherwise, these rules win.\n"

// renderConventions joins the parts, all of them or only the fixed or only
// the editable ones, each with the headings it sits under.
func renderConventions(keep func(convPart) bool) string {
	var b strings.Builder
	var pending []string // headings not yet written, outermost first
	for _, p := range convParts {
		if p.heading != "" {
			level := strings.IndexByte(p.heading, ' ')
			for len(pending) > 0 && strings.IndexByte(pending[len(pending)-1], ' ') >= level {
				pending = pending[:len(pending)-1]
			}
			pending = append(pending, p.heading)
			continue
		}
		if !keep(p) {
			continue
		}
		for _, h := range pending {
			b.WriteString("\n" + h + "\n\n")
		}
		pending = pending[:0]
		b.WriteString(p.text)
	}
	return b.String()
}

var (
	// AuthoringConventions are the built-in conventions as one text: what a
	// prompt carries when the user has no custom system prompt.
	AuthoringConventions = renderConventions(func(convPart) bool { return true })
	// EditableConventions are the parts of the built-in conventions that a
	// custom system prompt replaces.
	EditableConventions = renderConventions(func(p convPart) bool { return !p.fixed })
	// FixedConventions are the rules the app depends on, which follow a
	// custom system prompt.
	FixedConventions = fixedIntro + renderConventions(func(p convPart) bool { return p.fixed })
)

// ConventionsText returns the conventions a prompt carries: the built-in
// AuthoringConventions when custom is blank, otherwise the custom text
// followed by FixedConventions. The custom text is the user's own, from the
// instance's settings; like a style preset, its size and characters are
// capped by the application. Tag-like text in it is defanged, and the
// caller must pass it to NewEnvelope with the prompt's other untrusted texts.
func ConventionsText(custom string) string {
	custom = strings.TrimSpace(custom)
	if custom == "" {
		return AuthoringConventions
	}
	return Defang(custom) + "\n\n" + FixedConventions
}
