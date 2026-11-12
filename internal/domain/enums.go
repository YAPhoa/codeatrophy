// Package domain holds the core types of the library and their validation
// rules. It performs no I/O.
package domain

// ItemType distinguishes coding problems from readings.
type ItemType string

const (
	TypeProblem ItemType = "problem"
	TypeReading ItemType = "reading"
)

// Valid reports whether t is a known item type.
func (t ItemType) Valid() bool { return t == TypeProblem || t == TypeReading }

// Difficulty is the optional difficulty of an item.
type Difficulty string

const (
	DifficultyEasy   Difficulty = "easy"
	DifficultyMedium Difficulty = "medium"
	DifficultyHard   Difficulty = "hard"
)

// Valid reports whether d is a known difficulty.
func (d Difficulty) Valid() bool {
	return d == DifficultyEasy || d == DifficultyMedium || d == DifficultyHard
}

// Difficulties lists all difficulties in ascending order.
var Difficulties = []Difficulty{DifficultyEasy, DifficultyMedium, DifficultyHard}

// ItemStatus is the user's progress on an item.
type ItemStatus string

const (
	StatusTodo       ItemStatus = "todo"
	StatusInProgress ItemStatus = "in_progress"
	StatusDone       ItemStatus = "done"
)

// Valid reports whether s is a known status.
func (s ItemStatus) Valid() bool {
	return s == StatusTodo || s == StatusInProgress || s == StatusDone
}

// Statuses lists all statuses.
var Statuses = []ItemStatus{StatusTodo, StatusInProgress, StatusDone}

// CompareMode selects how actual output is compared with expected output.
type CompareMode string

const (
	// CompareTokens compares whitespace-separated tokens.
	CompareTokens CompareMode = "tokens"
	// CompareExact compares bytes after stripping trailing whitespace on each
	// line and trailing blank lines.
	CompareExact CompareMode = "exact"
)

// Valid reports whether m is a known compare mode.
func (m CompareMode) Valid() bool { return m == CompareTokens || m == CompareExact }

// TestOrigin records how a test case came to exist.
type TestOrigin string

const (
	OriginManual TestOrigin = "manual"
	OriginAI     TestOrigin = "ai"
	OriginImport TestOrigin = "import"
)

// Valid reports whether o is a known origin.
func (o TestOrigin) Valid() bool {
	return o == OriginManual || o == OriginAI || o == OriginImport
}

// SubmissionMode selects which test cases a submission runs.
type SubmissionMode string

const (
	ModeRun    SubmissionMode = "run"
	ModeSubmit SubmissionMode = "submit"
)

// Valid reports whether m is a known submission mode.
func (m SubmissionMode) Valid() bool { return m == ModeRun || m == ModeSubmit }

// SubmissionStatus is the lifecycle state of a submission.
type SubmissionStatus string

const (
	SubmissionQueued    SubmissionStatus = "queued"
	SubmissionRunning   SubmissionStatus = "running"
	SubmissionCompleted SubmissionStatus = "completed"
)

// Verdict is the outcome of running code against a test case, or of a
// whole submission.
type Verdict string

const (
	VerdictAccepted            Verdict = "accepted"
	VerdictWrongAnswer         Verdict = "wrong_answer"
	VerdictTimeLimitExceeded   Verdict = "time_limit_exceeded"
	VerdictMemoryLimitExceeded Verdict = "memory_limit_exceeded"
	VerdictRuntimeError        Verdict = "runtime_error"
	VerdictCompileError        Verdict = "compile_error"
	VerdictInternalError       Verdict = "internal_error"
	// VerdictExecuted is the verdict of a run that had no expected output.
	VerdictExecuted Verdict = "executed"
)

// Language describes a canonical language id owned by the app.
type Language struct {
	ID        string
	Name      string
	Extension string
}

// Languages is the canonical language list, sorted by id.
var Languages = []Language{
	{"c", "C", "c"},
	{"cpp", "C++", "cpp"},
	{"csharp", "C#", "cs"},
	{"go", "Go", "go"},
	{"java", "Java", "java"},
	{"javascript", "JavaScript", "js"},
	{"kotlin", "Kotlin", "kt"},
	{"python", "Python", "py"},
	{"ruby", "Ruby", "rb"},
	{"rust", "Rust", "rs"},
	{"typescript", "TypeScript", "ts"},
}

// LookupLanguage returns the canonical language with the given id.
func LookupLanguage(id string) (Language, bool) {
	for _, l := range Languages {
		if l.ID == id {
			return l, true
		}
	}
	return Language{}, false
}

// KnownLanguage reports whether id is a canonical language id.
func KnownLanguage(id string) bool {
	_, ok := LookupLanguage(id)
	return ok
}
