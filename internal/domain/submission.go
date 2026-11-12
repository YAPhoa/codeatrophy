package domain

import "time"

// MaxResultTextBytes is the size each text field of a submission result is
// truncated to.
const MaxResultTextBytes = 64 << 10

// SubmissionSummary is a submission without source, results and compile
// output.
type SubmissionSummary struct {
	ID          string           `json:"id"`
	ItemID      string           `json:"itemId"`
	Mode        SubmissionMode   `json:"mode"`
	Language    string           `json:"language"`
	Status      SubmissionStatus `json:"status"`
	Verdict     *Verdict         `json:"verdict"`
	PassedCount int              `json:"passedCount"`
	TotalCount  int              `json:"totalCount"`
	TimeMs      *int             `json:"timeMs"`
	MemoryKb    *int             `json:"memoryKb"`
	Error       *string          `json:"error"`
	CreatedAt   time.Time        `json:"createdAt"`
	FinishedAt  *time.Time       `json:"finishedAt"`
}

// Submission is one execution of user code against a problem.
type Submission struct {
	ID            string             `json:"id"`
	ItemID        string             `json:"itemId"`
	Mode          SubmissionMode     `json:"mode"`
	Language      string             `json:"language"`
	Source        string             `json:"source"`
	Status        SubmissionStatus   `json:"status"`
	Verdict       *Verdict           `json:"verdict"`
	PassedCount   int                `json:"passedCount"`
	TotalCount    int                `json:"totalCount"`
	TimeMs        *int               `json:"timeMs"`
	MemoryKb      *int               `json:"memoryKb"`
	CompileOutput string             `json:"compileOutput"`
	Error         *string            `json:"error"`
	Results       []SubmissionResult `json:"results"`
	CreatedAt     time.Time          `json:"createdAt"`
	FinishedAt    *time.Time         `json:"finishedAt"`

	// Stdin is the custom input of a run, or nil to use test cases. It is
	// not part of the API shape.
	Stdin *string `json:"-"`
	// CaseIDs are the test cases the submission runs, fixed at creation.
	CaseIDs []string `json:"-"`
}

// Summary returns the summary form of the submission.
func (s *Submission) Summary() SubmissionSummary {
	return SubmissionSummary{
		ID: s.ID, ItemID: s.ItemID, Mode: s.Mode, Language: s.Language, Status: s.Status,
		Verdict: s.Verdict, PassedCount: s.PassedCount, TotalCount: s.TotalCount,
		TimeMs: s.TimeMs, MemoryKb: s.MemoryKb, Error: s.Error,
		CreatedAt: s.CreatedAt, FinishedAt: s.FinishedAt,
	}
}

// SubmissionResult is the outcome of one test case of a submission.
type SubmissionResult struct {
	TestCaseID     *string `json:"testCaseId"`
	Name           string  `json:"name"`
	IsSample       bool    `json:"isSample"`
	Verdict        Verdict `json:"verdict"`
	Stdin          string  `json:"stdin"`
	ExpectedStdout *string `json:"expectedStdout"`
	Stdout         string  `json:"stdout"`
	Stderr         string  `json:"stderr"`
	TimeMs         *int    `json:"timeMs"`
	MemoryKb       *int    `json:"memoryKb"`
}

// Truncate cuts s to at most n bytes without splitting a UTF-8 sequence.
func Truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && cut > n-4 && !isRuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }
