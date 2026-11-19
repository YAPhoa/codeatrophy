package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Bounds for collections.
const (
	MaxCollectionNameChars        = 200
	MaxCollectionDescriptionChars = 5000
)

// Collection is a named, ordered list of items, nested in a tree.
type Collection struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	ParentID    *string   `json:"parentId"`
	Position    int       `json:"position"`
	ItemCount   int       `json:"itemCount"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// CollectionInput is the body of collection create and update requests.
type CollectionInput struct {
	Name        Opt[string] `json:"name"`
	Description Opt[string] `json:"description"`
	ParentID    Opt[string] `json:"parentId"`
	Position    Opt[int]    `json:"position"`
}

// ValidateCollection checks a collection's own fields.
func ValidateCollection(c *Collection) FieldErrors {
	errs := FieldErrors{}
	c.Name = strings.TrimSpace(NormalizeText(c.Name))
	c.Description = NormalizeText(c.Description)
	if n := utf8.RuneCountInString(c.Name); n < 1 || n > MaxCollectionNameChars {
		if n == 0 {
			errs.Add("name", "is required")
		} else {
			errs.Add("name", fmt.Sprintf("must be at most %d characters", MaxCollectionNameChars))
		}
	} else if !IsSingleLine(c.Name) {
		errs.Add("name", SingleLineMessage)
	}
	if utf8.RuneCountInString(c.Description) > MaxCollectionDescriptionChars {
		errs.Add("description", "is too long")
	}
	return errs
}

// Tag is a tag name with the number of items carrying it.
type Tag struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// Stats are library-wide counts.
type Stats struct {
	Items       ItemStats       `json:"items"`
	Collections int             `json:"collections"`
	Tags        int             `json:"tags"`
	Submissions SubmissionStats `json:"submissions"`
}

// ItemStats break the item count down by enum. Favorites and Uncollected
// equal the totals of an item list filtered by favorite=true, or by
// uncollected alone.
type ItemStats struct {
	Total        int            `json:"total"`
	ByType       map[string]int `json:"byType"`
	ByStatus     map[string]int `json:"byStatus"`
	ByDifficulty map[string]int `json:"byDifficulty"`
	Favorites    int            `json:"favorites"`
	Uncollected  int            `json:"uncollected"`
}

// SubmissionStats count submissions.
type SubmissionStats struct {
	Total    int `json:"total"`
	Accepted int `json:"accepted"`
}

// NewStats returns zeroed stats with every enum key present.
func NewStats() Stats {
	s := Stats{Items: ItemStats{
		ByType:       map[string]int{string(TypeProblem): 0, string(TypeReading): 0},
		ByStatus:     map[string]int{},
		ByDifficulty: map[string]int{"none": 0},
	}}
	for _, st := range Statuses {
		s.Items.ByStatus[string(st)] = 0
	}
	for _, d := range Difficulties {
		s.Items.ByDifficulty[string(d)] = 0
	}
	return s
}

// ItemFacets count the items of a filtered list by type, status,
// difficulty and tag: each count is how many items with that value the list
// shows once the value is picked. ByType is counted without the filter's
// type (picking one replaces it), ByStatus and ByDifficulty without the
// filter's own statuses or difficulties (values within one combine with
// OR); ByTag is counted with every filter, since tags combine with AND.
type ItemFacets struct {
	ByType       map[string]int `json:"byType"`
	ByStatus     map[string]int `json:"byStatus"`
	ByDifficulty map[string]int `json:"byDifficulty"`
	ByTag        map[string]int `json:"byTag"`
}
