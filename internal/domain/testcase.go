package domain

import "time"

// Bounds for test cases.
const (
	MaxTestCaseBytes     = 8 << 20 // stdin and expected output, each
	MaxTestCaseNameChars = 200
	MaxTestCasesPerItem  = 1000
)

// TestCase is one stdin / expected stdout pair of a problem.
type TestCase struct {
	ID             string     `json:"id"`
	ItemID         string     `json:"itemId"`
	Position       int        `json:"position"`
	Name           string     `json:"name"`
	Stdin          string     `json:"stdin"`
	ExpectedStdout string     `json:"expectedStdout"`
	IsSample       bool       `json:"isSample"`
	Origin         TestOrigin `json:"origin"`
	Verified       bool       `json:"verified"`
	// Generator is the program that printed Stdin, for a large test case,
	// or nil. Stdin is always stored too: nothing needs to run it again.
	Generator *GeneratorSpec `json:"generator"`
	CreatedAt time.Time      `json:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

// GeneratorSpec is the program that builds a large test case's input: a
// complete, deterministic program that reads nothing and prints the input.
type GeneratorSpec struct {
	Language string `json:"language"`
	Source   string `json:"source"`
}

// Solution returns the generator as a program to validate or run.
func (g GeneratorSpec) Solution() Solution { return Solution{Language: g.Language, Source: g.Source} }

// GeneratorEqual reports whether two generators are the same program.
func GeneratorEqual(a, b *GeneratorSpec) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// TestCaseEqual reports whether two test cases have the same fields.
func TestCaseEqual(a, b *TestCase) bool {
	x, y := *a, *b
	x.Generator, y.Generator = nil, nil
	return x == y && GeneratorEqual(a.Generator, b.Generator)
}

// TestCaseInput is the body of test case create and update requests.
type TestCaseInput struct {
	Name           Opt[string]        `json:"name"`
	Stdin          Opt[string]        `json:"stdin"`
	ExpectedStdout Opt[string]        `json:"expectedStdout"`
	IsSample       Opt[bool]          `json:"isSample"`
	Origin         Opt[TestOrigin]    `json:"origin"`
	Verified       Opt[bool]          `json:"verified"`
	Generator      Opt[GeneratorSpec] `json:"generator"`
}

// NewTestCaseFromInput builds a test case from create input, applying
// defaults. expectedStdout is required, unless a generator is given (it is
// then "" until the case is verified).
func NewTestCaseFromInput(in TestCaseInput) (TestCase, FieldErrors) {
	tc := TestCase{Origin: OriginManual}
	errs := FieldErrors{}
	if (!in.ExpectedStdout.Set || in.ExpectedStdout.Null) && !in.Generator.HasValue() {
		errs.Add("expectedStdout", "is required")
	}
	if in.ExpectedStdout.Set && in.ExpectedStdout.Null && in.Generator.HasValue() {
		in.ExpectedStdout = Opt[string]{}
	}
	errs.Merge("", ApplyTestCaseInput(&tc, in))
	return tc, errs
}

// ApplyTestCaseInput merges in onto tc. Changing stdin or expectedStdout
// resets verified unless the same input sets it. A non-null generator is
// stored as given (the caller runs it for the new stdin); null drops it and
// keeps stdin, and setting stdin without a generator drops it too: the
// stdin is no longer what the generator printed.
func ApplyTestCaseInput(tc *TestCase, in TestCaseInput) FieldErrors {
	errs := FieldErrors{}
	str := func(name string, o Opt[string], dst *string) bool {
		if !o.Set {
			return false
		}
		if o.Null {
			errs.Add(name, "cannot be null")
			return false
		}
		changed := *dst != o.Val
		*dst = o.Val
		return changed
	}
	str("name", in.Name, &tc.Name)
	tc.Name = NormalizeText(tc.Name)
	c1 := str("stdin", in.Stdin, &tc.Stdin)
	c2 := str("expectedStdout", in.ExpectedStdout, &tc.ExpectedStdout)
	if in.IsSample.Set {
		if in.IsSample.Null {
			errs.Add("isSample", "cannot be null")
		} else {
			tc.IsSample = in.IsSample.Val
		}
	}
	if in.Origin.Set {
		if in.Origin.Null {
			errs.Add("origin", "cannot be null")
		} else {
			tc.Origin = in.Origin.Val
		}
	}
	switch {
	case in.Generator.HasValue():
		g := in.Generator.Val
		g.Source = NormalizeText(g.Source)
		tc.Generator = &g
	case in.Generator.Set, in.Stdin.HasValue():
		tc.Generator = nil
	}
	if (c1 || c2) && !in.Verified.Set {
		tc.Verified = false
	}
	if in.Verified.Set {
		if in.Verified.Null {
			errs.Add("verified", "cannot be null")
		} else {
			tc.Verified = in.Verified.Val
		}
	}
	return errs
}

// ValidateTestCase checks a test case's fields.
func ValidateTestCase(tc *TestCase) FieldErrors {
	errs := FieldErrors{}
	if len([]rune(tc.Name)) > MaxTestCaseNameChars {
		errs.Add("name", "is too long")
	}
	if len(tc.Stdin) > MaxTestCaseBytes {
		errs.Add("stdin", "is too large")
	}
	if len(tc.ExpectedStdout) > MaxTestCaseBytes {
		errs.Add("expectedStdout", "is too large")
	}
	if !tc.Origin.Valid() {
		errs.Add("origin", "must be manual, ai or import")
	}
	return errs
}

// ValidateGenerator checks a generator's language and size, returning a
// message for the generator field or "".
func ValidateGenerator(g GeneratorSpec, lim Limits) string {
	if fe := ValidateSolution(g.Solution(), lim); len(fe) > 0 {
		return "the generator is not usable: " + fe.First()
	}
	return ""
}
