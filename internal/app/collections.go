package app

import (
	"context"
	"fmt"
	"slices"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// ListCollections returns every collection, flat.
func (a *App) ListCollections(ctx context.Context) (List[domain.Collection], error) {
	var out List[domain.Collection]
	err := a.store.Read(ctx, func(tx store.Tx) error {
		cs, err := tx.ListCollections()
		out.Items = cs
		return err
	})
	return out, err
}

// GetCollection returns one collection.
func (a *App) GetCollection(ctx context.Context, id string) (domain.Collection, error) {
	var out domain.Collection
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		out, err = tx.GetCollection(id)
		return notFoundAs(err, "collection")
	})
	return out, err
}

func samePtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// siblings returns the collections under parent, in order, excluding skipID.
func siblings(all []domain.Collection, parent *string, skipID string) []domain.Collection {
	var out []domain.Collection
	for _, c := range all {
		if c.ID != skipID && samePtr(c.ParentID, parent) {
			out = append(out, c)
		}
	}
	slices.SortStableFunc(out, func(x, y domain.Collection) int { return x.Position - y.Position })
	return out
}

// renumber writes positions 0..n-1 for the given ordered siblings.
func (a *App) renumber(tx store.Tx, ordered []domain.Collection) error {
	now := a.clock()
	for i := range ordered {
		if ordered[i].Position != i {
			ordered[i].Position = i
			ordered[i].UpdatedAt = now
			if err := tx.UpdateCollection(&ordered[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

// CreateCollection creates a collection appended after its siblings.
func (a *App) CreateCollection(ctx context.Context, in domain.CollectionInput) (domain.Collection, error) {
	now := a.clock()
	c := domain.Collection{ID: newID(), CreatedAt: now, UpdatedAt: now}
	fe := domain.FieldErrors{}
	if in.Name.HasValue() {
		c.Name = in.Name.Val
	}
	if in.Description.HasValue() {
		c.Description = in.Description.Val
	}
	c.ParentID = in.ParentID.Ptr()
	fe.Merge("", domain.ValidateCollection(&c))
	if err := errValidation(fe); err != nil {
		return c, err
	}
	var out domain.Collection
	err := a.store.Write(ctx, func(tx store.Tx) error {
		all, err := tx.ListCollections()
		if err != nil {
			return err
		}
		if c.ParentID != nil && !slices.ContainsFunc(all, func(x domain.Collection) bool { return x.ID == *c.ParentID }) {
			return errField("parentId", "collection does not exist")
		}
		sib := siblings(all, c.ParentID, "")
		if err := a.renumber(tx, sib); err != nil {
			return err
		}
		c.Position = len(sib)
		if err := tx.InsertCollection(&c); err != nil {
			return err
		}
		out, err = tx.GetCollection(c.ID)
		return err
	})
	return out, err
}

// UpdateCollection renames, describes, moves or reorders a collection.
func (a *App) UpdateCollection(ctx context.Context, id string, in domain.CollectionInput) (domain.Collection, error) {
	var out domain.Collection
	err := a.store.Write(ctx, func(tx store.Tx) error {
		all, err := tx.ListCollections()
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(all, func(x domain.Collection) bool { return x.ID == id })
		if idx < 0 {
			return errNotFound("collection")
		}
		cur := all[idx]
		next := cur
		fe := domain.FieldErrors{}
		if in.Name.Set {
			if in.Name.Null {
				fe.Add("name", "cannot be null")
			} else {
				next.Name = in.Name.Val
			}
		}
		if in.Description.Set {
			next.Description = in.Description.Val // null clears
		}
		if in.Position.Set && (in.Position.Null || in.Position.Val < 0) {
			fe.Add("position", "must be a non-negative integer")
		}
		fe.Merge("", domain.ValidateCollection(&next))
		if err := errValidation(fe); err != nil {
			return err
		}
		if in.ParentID.Set {
			next.ParentID = in.ParentID.Ptr()
			if next.ParentID != nil {
				if !slices.ContainsFunc(all, func(x domain.Collection) bool { return x.ID == *next.ParentID }) {
					return errField("parentId", "collection does not exist")
				}
				// Walk up from the new parent; reaching id means a cycle.
				parentOf := map[string]*string{}
				for _, x := range all {
					parentOf[x.ID] = x.ParentID
				}
				for p := next.ParentID; p != nil; p = parentOf[*p] {
					if *p == id {
						return errConflict("a collection cannot be moved under itself or one of its descendants",
							map[string]any{"parentId": "would create a cycle"})
					}
				}
			}
		}
		moved := !samePtr(cur.ParentID, next.ParentID)
		next.UpdatedAt = a.clock()
		if moved || in.Position.HasValue() {
			sib := siblings(all, next.ParentID, id)
			pos := len(sib)
			if in.Position.HasValue() {
				pos = min(in.Position.Val, len(sib))
			}
			ordered := slices.Insert(slices.Clone(sib), pos, next)
			for i := range ordered {
				if ordered[i].ID == id {
					ordered[i].Position = -1 // force a write below
				}
			}
			if err := tx.UpdateCollection(&next); err != nil {
				return err
			}
			if err := a.renumber(tx, ordered); err != nil {
				return err
			}
			if moved {
				if err := a.renumber(tx, siblings(all, cur.ParentID, id)); err != nil {
					return err
				}
			}
		} else if err := tx.UpdateCollection(&next); err != nil {
			return err
		}
		out, err = tx.GetCollection(id)
		return err
	})
	return out, err
}

// DeleteCollection deletes a collection. Its children move up to its parent,
// taking its place; its items are kept.
func (a *App) DeleteCollection(ctx context.Context, id string) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		all, err := tx.ListCollections()
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(all, func(x domain.Collection) bool { return x.ID == id })
		if idx < 0 {
			return errNotFound("collection")
		}
		cur := all[idx]
		children := siblings(all, &cur.ID, "")
		sib := siblings(all, cur.ParentID, "")
		pos := slices.IndexFunc(sib, func(x domain.Collection) bool { return x.ID == id })
		var ordered []domain.Collection
		ordered = append(ordered, sib[:pos]...)
		now := a.clock()
		for _, ch := range children {
			ch.ParentID = cur.ParentID
			ch.Position = -1
			ch.UpdatedAt = now
			ordered = append(ordered, ch)
		}
		ordered = append(ordered, sib[pos+1:]...)
		for _, ch := range children {
			ch.ParentID = cur.ParentID
			ch.UpdatedAt = now
			if err := tx.UpdateCollection(&ch); err != nil {
				return err
			}
		}
		if err := tx.DeleteCollection(id); err != nil {
			return err
		}
		return a.renumber(tx, ordered)
	})
}

// CollectionItems is a collection's ordered membership.
type CollectionItems struct {
	ItemIDs []string `json:"itemIds"`
}

func (a *App) checkMembers(tx store.Tx, ids []string, allowDuplicates bool) error {
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] && !allowDuplicates {
			return errField("itemIds", fmt.Sprintf("item %s is listed more than once", id))
		}
		seen[id] = true
	}
	existing, err := tx.ExistingItemIDs(ids)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if !existing[id] {
			return errField("itemIds", fmt.Sprintf("item %s does not exist", id))
		}
	}
	return nil
}

// SetCollectionItems replaces a collection's membership and order.
func (a *App) SetCollectionItems(ctx context.Context, id string, itemIDs []string) (CollectionItems, error) {
	var out CollectionItems
	err := a.store.Write(ctx, func(tx store.Tx) error {
		if _, err := tx.GetCollection(id); err != nil {
			return notFoundAs(err, "collection")
		}
		if err := a.checkMembers(tx, itemIDs, false); err != nil {
			return err
		}
		if err := tx.SetCollectionItemIDs(id, itemIDs); err != nil {
			return err
		}
		ids, err := tx.CollectionItemIDs(id)
		out.ItemIDs = ids
		return err
	})
	return out, err
}

// AddCollectionItems appends items that are not yet members.
func (a *App) AddCollectionItems(ctx context.Context, id string, itemIDs []string) (CollectionItems, error) {
	var out CollectionItems
	err := a.store.Write(ctx, func(tx store.Tx) error {
		if _, err := tx.GetCollection(id); err != nil {
			return notFoundAs(err, "collection")
		}
		if err := a.checkMembers(tx, itemIDs, true); err != nil {
			return err
		}
		if err := tx.AddCollectionItems(id, dedupe(itemIDs)); err != nil {
			return err
		}
		ids, err := tx.CollectionItemIDs(id)
		out.ItemIDs = ids
		return err
	})
	return out, err
}

// RemoveCollectionItem removes one item from a collection. Removing an item
// that is not a member is not an error.
func (a *App) RemoveCollectionItem(ctx context.Context, id, itemID string) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		if _, err := tx.GetCollection(id); err != nil {
			return notFoundAs(err, "collection")
		}
		ids, err := tx.CollectionItemIDs(id)
		if err != nil {
			return err
		}
		if _, err := tx.RemoveCollectionItem(id, itemID); err != nil {
			return err
		}
		rest := slices.DeleteFunc(ids, func(x string) bool { return x == itemID })
		return tx.SetCollectionItemIDs(id, rest)
	})
}

// CollectionItemIDs returns a collection's full ordered membership.
func (a *App) CollectionItemIDs(ctx context.Context, id string) (CollectionItems, error) {
	var out CollectionItems
	err := a.store.Read(ctx, func(tx store.Tx) error {
		if _, err := tx.GetCollection(id); err != nil {
			return notFoundAs(err, "collection")
		}
		ids, err := tx.CollectionItemIDs(id)
		out.ItemIDs = ids
		return err
	})
	return out, err
}
