package domain

import "time"

// DefaultMaxLinksPerItem is the default bound on the links an item has,
// counting links to items that no longer exist (Limits.MaxLinksPerItem).
// MaxLinksPerItemCeiling is the highest an instance may set it to: the most
// ids a bundle item's related field holds (bundle.MaxRelated), so that an
// exported item's links always fit the bundle format.
const (
	DefaultMaxLinksPerItem = 30
	MaxLinksPerItemCeiling = 50
)

// LinkedItem is an item as seen from another one: the other end of a link,
// or a variant's origin. Links and variantOf are kept when the item they
// name is deleted, so the item may be unavailable. Title and Type then come
// from the record kept of the deleted item, and are nil when there is none
// (an id that never existed in this library, such as one an import
// brought); Status and Difficulty are nil.
type LinkedItem struct {
	ID         string      `json:"id"`
	Available  bool        `json:"available"`
	Title      *string     `json:"title"`
	Type       *ItemType   `json:"type"`
	Status     *ItemStatus `json:"status"`
	Difficulty *Difficulty `json:"difficulty"`
	// LinkedAt is when the link was made; nil for a variant's origin.
	LinkedAt *time.Time `json:"linkedAt"`
}

// ItemLinks is an item's list of links.
type ItemLinks struct {
	Links []LinkedItem `json:"links"`
}
