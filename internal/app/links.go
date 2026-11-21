package app

import (
	"context"
	"fmt"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Links are hand-made, undirected and unlabelled connections between two
// items. A link is made between two existing items and stays when either
// of them is deleted: the other side then lists it as unavailable, until
// an item with that id exists again (re-created by an import, say).
// Linking and unlinking are not content changes: neither revision nor
// updatedAt moves.

// ItemLinks lists an item's links: available items first, each group
// oldest link first.
func (a *App) ItemLinks(ctx context.Context, id string) (domain.ItemLinks, error) {
	var out domain.ItemLinks
	err := a.store.Read(ctx, func(tx store.Tx) error {
		if _, err := tx.GetItem(id); err != nil {
			return notFoundAs(err, "item")
		}
		var err error
		out.Links, err = tx.ItemLinks(id)
		return err
	})
	return out, err
}

// LinkItem links an item to another one, as POST /items/{id}/links does;
// validation errors name the field itemId. It returns the item's links.
func (a *App) LinkItem(ctx context.Context, id, otherID string) (domain.ItemLinks, error) {
	return a.linkItems(ctx, id, []string{otherID}, "itemId", func(int) string { return "itemId" })
}

// LinkItems links an item to each of the others, all or none; validation
// errors name otherIds.<index>. It returns the item's links.
func (a *App) LinkItems(ctx context.Context, id string, otherIDs []string) (domain.ItemLinks, error) {
	if len(otherIDs) == 0 {
		return domain.ItemLinks{}, errField("otherIds", "at least one item id is required")
	}
	return a.linkItems(ctx, id, otherIDs, "otherIds", func(i int) string { return fmt.Sprintf("otherIds.%d", i) })
}

// linkItems links id to each of others. A pair already linked is left as
// it is. Every other item must exist and differ from the item, and neither
// side may go over domain.MaxLinksPerItem links; otherwise nothing is
// written.
func (a *App) linkItems(ctx context.Context, id string, others []string, listField string, field func(int) string) (domain.ItemLinks, error) {
	var out domain.ItemLinks
	err := a.store.Write(ctx, func(tx store.Tx) error {
		it, err := tx.GetItem(id)
		if err != nil {
			return notFoundAs(err, "item")
		}
		current, err := tx.ItemLinks(id)
		if err != nil {
			return err
		}
		linked := map[string]bool{}
		for _, l := range current {
			linked[l.ID] = true
		}
		existing, err := tx.ExistingItemIDs(others)
		if err != nil {
			return err
		}
		fe := domain.FieldErrors{}
		var add []string
		index := map[string]int{} // other id -> its index in others
		for i, other := range others {
			switch {
			case other == "":
				fe.Add(field(i), "is required")
			case other == id:
				fe.Add(field(i), "an item cannot be linked to itself")
			case !existing[other]:
				fe.Add(field(i), fmt.Sprintf("item %s does not exist", other))
			case linked[other]:
			default:
				if _, seen := index[other]; !seen {
					index[other] = i
					add = append(add, other)
				}
			}
		}
		if err := errValidation(fe); err != nil {
			return err
		}
		if it.LinkCount+len(add) > domain.MaxLinksPerItem {
			return errField(listField, fmt.Sprintf("an item can have at most %d links; this one has %d",
				domain.MaxLinksPerItem, it.LinkCount))
		}
		if len(add) > 0 {
			sums, _, err := tx.ListItems(store.ItemFilter{IDs: add})
			if err != nil {
				return err
			}
			for _, s := range sums {
				if s.LinkCount >= domain.MaxLinksPerItem {
					fe.Add(field(index[s.ID]), fmt.Sprintf("item %s already has %d links, the most an item can have",
						s.ID, s.LinkCount))
				}
			}
			if err := errValidation(fe); err != nil {
				return err
			}
		}
		now := a.clock()
		for _, other := range add {
			if _, err := tx.LinkItems(id, other, now); err != nil {
				return err
			}
		}
		out.Links, err = tx.ItemLinks(id)
		return err
	})
	return out, err
}

// UnlinkItem removes the link between an item and another one, whether or
// not the other one still exists. Removing a link that does not exist
// succeeds.
func (a *App) UnlinkItem(ctx context.Context, id, otherID string) error {
	_, err := a.unlinkItems(ctx, id, []string{otherID}, func(int) string { return "otherId" })
	return err
}

// UnlinkItems removes the links between an item and each of the others, as
// UnlinkItem does, and returns the item's links.
func (a *App) UnlinkItems(ctx context.Context, id string, otherIDs []string) (domain.ItemLinks, error) {
	if len(otherIDs) == 0 {
		return domain.ItemLinks{}, errField("otherIds", "at least one item id is required")
	}
	return a.unlinkItems(ctx, id, otherIDs, func(i int) string { return fmt.Sprintf("otherIds.%d", i) })
}

func (a *App) unlinkItems(ctx context.Context, id string, others []string, field func(int) string) (domain.ItemLinks, error) {
	fe := domain.FieldErrors{}
	for i, other := range others {
		if other == "" {
			fe.Add(field(i), "is required")
		}
	}
	if err := errValidation(fe); err != nil {
		return domain.ItemLinks{}, err
	}
	var out domain.ItemLinks
	err := a.store.Write(ctx, func(tx store.Tx) error {
		if _, err := tx.GetItem(id); err != nil {
			return notFoundAs(err, "item")
		}
		for _, other := range others {
			if other == id {
				continue
			}
			if _, err := tx.UnlinkItems(id, other); err != nil {
				return err
			}
		}
		var err error
		out.Links, err = tx.ItemLinks(id)
		return err
	})
	return out, err
}
