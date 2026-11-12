package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Bounds for saved solutions. The source is bounded by the instance's
// MaxSourceBytes.
const (
	MaxSolutionsPerItem   = 50
	MaxSolutionNameChars  = 100
	MaxSolutionNotesChars = 5000
	// ReferenceSolutionName is the name given to a solution created by
	// writing problem.referenceSolution.
	ReferenceSolutionName = "Reference solution"
)

// ItemSolution is a saved solution of a problem.
type ItemSolution struct {
	ID          string    `json:"id"`
	ItemID      string    `json:"itemId"`
	Name        string    `json:"name"`
	Language    string    `json:"language"`
	Source      string    `json:"source"`
	Notes       string    `json:"notes"`
	IsReference bool      `json:"isReference"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ItemSolutionInput is the body of solution create and update requests.
type ItemSolutionInput struct {
	Name             Opt[string] `json:"name"`
	Language         Opt[string] `json:"language"`
	Source           Opt[string] `json:"source"`
	Notes            Opt[string] `json:"notes"`
	IsReference      Opt[bool]   `json:"isReference"`
	ExpectedRevision Opt[int]    `json:"expectedRevision"`
}

// ApplyItemSolutionInput merges in onto s.
func ApplyItemSolutionInput(s *ItemSolution, in ItemSolutionInput) FieldErrors {
	errs := FieldErrors{}
	str := func(name string, o Opt[string], dst *string) {
		if !o.Set {
			return
		}
		if o.Null {
			errs.Add(name, "cannot be null")
			return
		}
		*dst = o.Val
	}
	str("name", in.Name, &s.Name)
	str("language", in.Language, &s.Language)
	str("source", in.Source, &s.Source)
	str("notes", in.Notes, &s.Notes)
	if in.IsReference.Set {
		if in.IsReference.Null {
			errs.Add("isReference", "cannot be null")
		} else {
			s.IsReference = in.IsReference.Val
		}
	}
	return errs
}

// ValidateItemSolution normalizes and checks a solution in place.
func ValidateItemSolution(s *ItemSolution, lim Limits) FieldErrors {
	errs := FieldErrors{}
	s.Name = strings.TrimSpace(NormalizeText(s.Name))
	s.Source = NormalizeText(s.Source)
	s.Notes = NormalizeText(s.Notes)
	switch n := utf8.RuneCountInString(s.Name); {
	case n == 0:
		errs.Add("name", "is required")
	case n > MaxSolutionNameChars:
		errs.Add("name", fmt.Sprintf("must be at most %d characters", MaxSolutionNameChars))
	case !IsSingleLine(s.Name):
		errs.Add("name", SingleLineMessage)
	}
	if utf8.RuneCountInString(s.Notes) > MaxSolutionNotesChars {
		errs.Add("notes", fmt.Sprintf("must be at most %d characters", MaxSolutionNotesChars))
	}
	errs.Merge("", ValidateSolution(Solution{Language: s.Language, Source: s.Source}, lim))
	return errs
}

// RefOf returns the reference-solution view of a list of solutions.
func RefOf(sols []ItemSolution) *Solution {
	for _, s := range sols {
		if s.IsReference {
			return &Solution{ID: s.ID, Language: s.Language, Source: s.Source}
		}
	}
	return nil
}

// RefEqual reports whether two reference-solution views report the same
// language and source (the id does not count).
func RefEqual(a, b *Solution) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Language == b.Language && a.Source == b.Source
}
