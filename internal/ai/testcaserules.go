package ai

import "strings"

// The test-case rules are the system prompt of a test-case generation after
// its opening line and the data-block rules. Like the authoring conventions
// they are made of two kinds of part, though they are a separate text: the
// conventions do not apply to test generation.
//
// The editable parts are test-design guidance: how to write the reference
// solution and how to choose and cover inputs. A user may replace all of
// them with a text of their own (a custom test case prompt). The fixed parts
// are rules the server, the judge and the response schema depend on: the
// program and function-harness contract, the judge's language versions, the
// input-size cap, predicted outputs and the server running the solution,
// samples, the Java and Kotlin entry points, the large-case rules and the
// JSON-only answer. They always apply.
//
// An editable part whose built-in wording also carries a rule the app
// depends on restates that rule in keep, which is sent in its place, among
// the fixed rules, with a custom text. Without a custom text the parts are
// sent in their order here, as they always were.

type tcPart struct {
	text  string
	fixed bool
	keep  string // for an editable part: its fixed rules, restated
}

var tcParts = []tcPart{
	{text: `- For a program problem, write a correct, efficient reference solution in the requested language that
  reads stdin and writes stdout exactly in the format the statement specifies.
`, keep: `- For a program problem, the reference solution is a whole program in the requested language that
  reads stdin and writes stdout exactly in the format the statement specifies.
`},
	{fixed: true, text: `- For a function problem ("interface": "function"), the program that runs is the harness prefix, your
  solution and the harness suffix. Write only the solution part, exactly as a solver would fill in the
  stub ("stub" in the problem block), so that it works with that harness. The test stdin is the input
  the harness suffix reads: one JSON value per line, one line per argument, in signature order.
- Write the code for the language versions the judge runs.
`},
	{text: `- Propose test inputs that follow the input format and constraints exactly. Cover: the examples,
  minimum sizes, larger sizes (keep each input under about 100 KB), edge values, and cases that defeat
  common wrong approaches. Give each case a short name and a one-sentence rationale.
`, keep: `- Test inputs follow the input format and constraints exactly. Keep each input under about 100 KB.
`},
	{fixed: true, text: `- For each input, give the output you predict the reference solution prints, as "predictedStdout".
  The server will run the solution to compute the real expected output, so focus on good inputs.
- Mark one or two simple cases as samples (isSample: true) only if the problem has fewer than two
  sample cases already; otherwise mark none.
- Java programs use "public class Main"; Kotlin programs use a top-level "fun main()".
`},
}

// tcFixedIntro opens the fixed rules sent after a custom text.
const tcFixedIntro = "# Fixed rules\n\n" +
	"These rules are how the app works, and they always apply. Where the\n" +
	"text above says otherwise, these rules win.\n\n"

func renderTestCaseRules(pick func(tcPart) string) string {
	var b strings.Builder
	for _, p := range tcParts {
		b.WriteString(pick(p))
	}
	return b.String()
}

var (
	// builtinTestCaseRules are all the parts, as sent without a custom text.
	builtinTestCaseRules = renderTestCaseRules(func(p tcPart) string { return p.text })
	// EditableTestCaseRules are the parts of the built-in test-case rules
	// that a custom test case prompt replaces.
	EditableTestCaseRules = renderTestCaseRules(func(p tcPart) string {
		if p.fixed {
			return ""
		}
		return p.text
	})
	// fixedTestCaseRules are the rules that follow a custom text.
	fixedTestCaseRules = tcFixedIntro + renderTestCaseRules(func(p tcPart) string {
		if p.fixed {
			return p.text
		}
		return p.keep
	})
)

// testCaseRules returns the rules of a test-case generation's system prompt
// after the data-block rules: the built-in rules when custom is blank,
// otherwise the custom text followed by the fixed rules. Either way they end
// with the large-case rules (when asked for) and the JSON-only answer. The
// custom text is the user's own, from the instance's settings; tag-like text
// in it is defanged, and the caller must pass it to NewEnvelope with the
// prompt's other untrusted texts.
func testCaseRules(custom string, l LargeCases) string {
	rules := builtinTestCaseRules
	if custom = strings.TrimSpace(custom); custom != "" {
		rules = Defang(custom) + "\n\n" + fixedTestCaseRules
	}
	return rules + largeSection(l) + "\n" + jsonOnly
}

// testDesignGuidance returns the test-design guidance a draft's or
// variant's hidden test cases follow: the editable test-case rules, or the
// custom test case prompt that replaces them (defanged; the caller passes it
// to NewEnvelope). The fixed test-case rules are left out: they describe a
// test-case generation's own answer, and a draft's rules and the
// conventions say the same for a draft.
func testDesignGuidance(custom string) string {
	if custom = strings.TrimSpace(custom); custom != "" {
		return Defang(custom) + "\n"
	}
	return EditableTestCaseRules
}

// FixedTestCaseRules returns the rules a custom test case prompt is always
// followed by, as sent when no large test cases are asked for (asking for
// them adds rules).
func FixedTestCaseRules() string {
	return fixedTestCaseRules + "\n" + jsonOnly
}
