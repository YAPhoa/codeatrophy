package domain

import (
	"fmt"
	"time"
)

// WorkingCopy is the code the user is writing on a problem in one language,
// kept so that it follows them across browsers. It is personal work in
// progress, not content: bundles do not carry it and writing it changes
// neither the item's revision nor its updatedAt.
type WorkingCopy struct {
	ItemID    string    `json:"-"`
	Language  string    `json:"language"`
	Source    string    `json:"source"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// WorkingCopyInput is the body of a working copy write.
type WorkingCopyInput struct {
	Source Opt[string] `json:"source"`
}

// ValidateWorkingCopy normalizes and checks a working copy in place. The
// language is any canonical language id; the source may be empty.
func ValidateWorkingCopy(w *WorkingCopy, lim Limits) FieldErrors {
	errs := FieldErrors{}
	w.Source = NormalizeText(w.Source)
	if !KnownLanguage(w.Language) {
		errs.Add("language", "unknown language")
	}
	if lim.MaxSourceBytes > 0 && len(w.Source) > lim.MaxSourceBytes {
		errs.Add("source", fmt.Sprintf("must be at most %d bytes", lim.MaxSourceBytes))
	}
	return errs
}
