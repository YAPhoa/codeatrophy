package app

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// ItemQuery is the set of filters for listing items, as accepted by both
// transports.
type ItemQuery struct {
	Q            string   `json:"q"`
	ID           []string `json:"id"`
	Type         string   `json:"type"`
	Status       []string `json:"status"`
	Difficulty   []string `json:"difficulty"`
	Tag          []string `json:"tag"`
	CollectionID string   `json:"collectionId"`
	Recursive    bool     `json:"recursive"`
	Uncollected  bool     `json:"uncollected"`
	VariantOf    string   `json:"variantOf"`
	Favorite     *bool    `json:"favorite"`
	Sort         string   `json:"sort"`
	Order        string   `json:"order"`
	Limit        *int     `json:"limit"`
	Offset       int      `json:"offset"`
}

// Page is a paginated list.
type Page[T any] struct {
	Items []T `json:"items"`
	Total int `json:"total"`
}

// List is a non-paginated list.
type List[T any] struct {
	Items []T `json:"items"`
}

// Pagination bounds.
const (
	DefaultLimit = 50
	MaxLimit     = domain.MaxPageSize
)

func pageBounds(limit *int, offset int) (int, int, error) {
	l := DefaultLimit
	if limit != nil {
		l = *limit
	}
	if l < 1 || l > MaxLimit {
		return 0, 0, errBadRequest("limit must be between 1 and %d", MaxLimit)
	}
	if offset < 0 {
		return 0, 0, errBadRequest("offset must not be negative")
	}
	return l, offset, nil
}

// itemFilter validates the filters of q (not its order or page).
func itemFilter(q ItemQuery) (store.ItemFilter, error) {
	f := store.ItemFilter{
		Query:        strings.TrimSpace(q.Q),
		CollectionID: q.CollectionID,
		Recursive:    q.Recursive,
		Uncollected:  q.Uncollected,
		VariantOf:    q.VariantOf,
		Favorite:     q.Favorite,
		IDs:          dedupe(q.ID),
	}
	if q.Type != "" {
		t := domain.ItemType(q.Type)
		if !t.Valid() {
			return f, errBadRequest("type must be problem or reading")
		}
		f.Type = t
	}
	for _, s := range q.Status {
		st := domain.ItemStatus(s)
		if !st.Valid() {
			return f, errBadRequest("unknown status %q", s)
		}
		f.Statuses = append(f.Statuses, st)
	}
	for _, d := range q.Difficulty {
		if d != "none" && !domain.Difficulty(d).Valid() {
			return f, errBadRequest("unknown difficulty %q", d)
		}
		f.Difficulties = append(f.Difficulties, d)
	}
	for _, t := range q.Tag {
		if t = domain.NormalizeTag(t); t != "" {
			f.Tags = append(f.Tags, t)
		}
	}
	return f, nil
}

// ListItems lists items matching the query.
func (a *App) ListItems(ctx context.Context, q ItemQuery) (Page[domain.ItemSummary], error) {
	f, err := itemFilter(q)
	if err != nil {
		return Page[domain.ItemSummary]{}, err
	}
	f.Sort = q.Sort
	if f.Sort == "" {
		f.Sort = store.SortUpdated
	}
	switch f.Sort {
	case store.SortUpdated, store.SortCreated, store.SortTitle, store.SortDifficulty:
	case store.SortPosition:
		if f.CollectionID == "" || f.Recursive {
			return Page[domain.ItemSummary]{}, errBadRequest("sort=position requires a non-recursive collectionId")
		}
	case store.SortRelevance:
		if f.Query == "" {
			return Page[domain.ItemSummary]{}, errBadRequest("sort=relevance requires q")
		}
	default:
		return Page[domain.ItemSummary]{}, errBadRequest("unknown sort %q", q.Sort)
	}
	switch q.Order {
	case "":
		f.Desc = f.Sort == store.SortUpdated || f.Sort == store.SortCreated || f.Sort == store.SortRelevance
	case "asc":
	case "desc":
		f.Desc = true
	default:
		return Page[domain.ItemSummary]{}, errBadRequest("order must be asc or desc")
	}
	if f.Limit, f.Offset, err = pageBounds(q.Limit, q.Offset); err != nil {
		return Page[domain.ItemSummary]{}, err
	}
	var out Page[domain.ItemSummary]
	err = a.store.Read(ctx, func(tx store.Tx) error {
		items, total, err := tx.ListItems(f)
		out = Page[domain.ItemSummary]{Items: items, Total: total}
		return err
	})
	return out, err
}

// ItemFacets counts the items of the query's list by type, status,
// difficulty and tag, as described on domain.ItemFacets. The query's order and page
// are ignored.
func (a *App) ItemFacets(ctx context.Context, q ItemQuery) (domain.ItemFacets, error) {
	f, err := itemFilter(q)
	if err != nil {
		return domain.ItemFacets{}, err
	}
	stats := domain.NewStats().Items
	out := domain.ItemFacets{ByType: stats.ByType, ByStatus: stats.ByStatus, ByDifficulty: stats.ByDifficulty, ByTag: map[string]int{}}
	byType, byStatus, byDifficulty := f, f, f
	byType.Type, byStatus.Statuses, byDifficulty.Difficulties = "", nil, nil
	err = a.store.Read(ctx, func(tx store.Tx) error {
		for _, g := range []struct {
			group string
			f     store.ItemFilter
			into  map[string]int
		}{
			{store.GroupType, byType, out.ByType},
			{store.GroupStatus, byStatus, out.ByStatus},
			{store.GroupDifficulty, byDifficulty, out.ByDifficulty},
			{store.GroupTag, f, out.ByTag},
		} {
			counts, err := tx.CountItemsBy(g.f, g.group)
			if err != nil {
				return err
			}
			for k, n := range counts {
				g.into[k] = n
			}
		}
		return nil
	})
	return out, err
}

// GetItem returns one item.
func (a *App) GetItem(ctx context.Context, id string) (domain.Item, error) {
	var it domain.Item
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		it, err = tx.GetItem(id)
		return notFoundAs(err, "item")
	})
	return it, err
}

// CreateItem creates an item, optionally with test cases and collection
// memberships, in one transaction.
func (a *App) CreateItem(ctx context.Context, in domain.ItemInput) (domain.Item, error) {
	if err := a.generateItemCases(ctx, &in); err != nil {
		return domain.Item{}, err
	}
	n, err := a.newItem(in)
	if err != nil {
		return domain.Item{}, err
	}
	var out domain.Item
	err = a.store.Write(ctx, func(tx store.Tx) (err error) {
		out, err = a.insertNewItem(ctx, tx, n)
		return err
	})
	return out, err
}

// generateItemCases runs the generators of the new item's test cases that
// have one but no stdin, before anything is stored, and sets their stdin.
// A case that gives both keeps them as given, as on every create path (see
// generatedInputs). The item is validated first, so that nothing runs for
// a request that would fail anyway.
func (a *App) generateItemCases(ctx context.Context, in *domain.ItemInput) error {
	if !in.TestCases.HasValue() || !slices.ContainsFunc(in.TestCases.Val, needsRun) {
		return nil
	}
	if _, err := a.newItem(*in); err != nil {
		return err
	}
	cases := slices.Clone(in.TestCases.Val)
	if _, err := a.generatedInputs(ctx, cases, func(i int) string { return fmt.Sprintf("testCases.%d.generator", i) }); err != nil {
		return err
	}
	in.TestCases = domain.Some(cases)
	return nil
}

// newItemRecords is a new item as it is written: the item, its test cases
// and the collections it goes into.
type newItemRecords struct {
	item    domain.Item
	cases   []domain.TestCase
	collIDs []string
}

// newItem validates the input of a new item and builds its records.
func (a *App) newItem(in domain.ItemInput) (newItemRecords, error) {
	fe := domain.FieldErrors{}
	if !in.Type.HasValue() {
		fe.Add("type", "is required")
	} else if !in.Type.Val.Valid() {
		fe.Add("type", "must be problem or reading")
	}
	if !in.Title.HasValue() {
		fe.Add("title", "is required")
	}
	if in.ExpectedRevision.Set {
		fe.Add("expectedRevision", "is not accepted on create")
	}
	if len(fe) > 0 {
		return newItemRecords{}, errValidation(fe)
	}
	now := a.clock()
	it := domain.Item{ItemSummary: domain.ItemSummary{
		ID: newID(), Type: in.Type.Val, Status: domain.StatusTodo, Revision: 1, CreatedAt: now, UpdatedAt: now,
	}}
	if it.Type == domain.TypeProblem {
		it.Problem = domain.DefaultProblemSpec()
	}
	fe.Merge("", domain.ApplyItemInput(&it, in))
	domain.NormalizeItem(&it)
	fe.Merge("", domain.ValidateItem(&it, a.limits))
	if msg := domain.ValidateNotes(it.Notes, a.limits); msg != "" {
		fe.Add("notes", msg)
	}

	var cases []domain.TestCase
	if in.TestCases.HasValue() && len(in.TestCases.Val) > 0 {
		if it.Type != domain.TypeProblem {
			fe.Add("testCases", "readings have no test cases")
		} else if len(in.TestCases.Val) > domain.MaxTestCasesPerItem {
			fe.Add("testCases", fmt.Sprintf("at most %d test cases", domain.MaxTestCasesPerItem))
		} else {
			for i, tci := range in.TestCases.Val {
				tc, tfe := domain.NewTestCaseFromInput(tci)
				tfe.Merge("", a.validateCase(&tc))
				fe.Merge(fmt.Sprintf("testCases.%d.", i), tfe)
				tc.ID, tc.ItemID, tc.Position, tc.CreatedAt, tc.UpdatedAt = newID(), it.ID, i, now, now
				cases = append(cases, tc)
			}
		}
	}
	var collIDs []string
	if in.CollectionIDs.Set {
		if in.CollectionIDs.Null {
			fe.Add("collectionIds", "cannot be null")
		}
		collIDs = dedupe(in.CollectionIDs.Val)
	}
	if err := errValidation(fe); err != nil {
		return newItemRecords{}, err
	}
	return newItemRecords{item: it, cases: cases, collIDs: collIDs}, nil
}

// insertNewItem writes a new item built by newItem, recording who created
// it, and returns it as stored.
func (a *App) insertNewItem(ctx context.Context, tx store.Tx, n newItemRecords) (domain.Item, error) {
	it := n.item
	it.CreatedBy, it.LastUpdatedBy = changedBy(ctx), changedBy(ctx)
	if err := checkVariantOf(tx, it.ID, it.VariantOf); err != nil {
		return domain.Item{}, err
	}
	if err := checkCollections(tx, n.collIDs); err != nil {
		return domain.Item{}, err
	}
	if err := tx.InsertItem(&it); err != nil {
		return domain.Item{}, err
	}
	if ref := refOf(&it); ref != nil {
		if err := a.writeReference(tx, it.ID, ref); err != nil {
			return domain.Item{}, err
		}
	}
	for i := range n.cases {
		if err := tx.InsertTestCase(&n.cases[i]); err != nil {
			return domain.Item{}, err
		}
	}
	if len(n.collIDs) > 0 {
		if err := tx.SetItemCollections(it.ID, n.collIDs); err != nil {
			return domain.Item{}, err
		}
	}
	return tx.GetItem(it.ID)
}

func dedupe(ids []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func checkVariantOf(tx store.Tx, itemID string, variantOf *string) error {
	if variantOf == nil {
		return nil
	}
	if *variantOf == itemID {
		return errField("variantOf", "an item cannot be a variant of itself")
	}
	ok, err := tx.ExistingItemIDs([]string{*variantOf})
	if err != nil {
		return err
	}
	if !ok[*variantOf] {
		return errField("variantOf", "item does not exist")
	}
	return nil
}

func checkCollections(tx store.Tx, ids []string) error {
	for _, id := range ids {
		if _, err := tx.GetCollection(id); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return errField("collectionIds", fmt.Sprintf("collection %s does not exist", id))
			}
			return err
		}
	}
	return nil
}

// checkRevision enforces an expectedRevision precondition.
func checkRevision(expected domain.Opt[int], it *domain.Item) error {
	if !expected.HasValue() || expected.Val == it.Revision {
		return nil
	}
	return errConflict(
		fmt.Sprintf("the item has changed since revision %d (current revision is %d)", expected.Val, it.Revision),
		map[string]any{"revision": it.Revision})
}

// saveItem writes an updated item. A content change increases the revision,
// moves updatedAt and records who made it; a change to personal state only
// (status, favorite, notes, raw input) changes none of them; an unchanged
// item is not written.
func (a *App) saveItem(ctx context.Context, tx store.Tx, before, after *domain.Item) error {
	changed := !domain.ContentEqual(before, after)
	if !changed && domain.PersonalEqual(before, after) {
		return nil
	}
	after.Revision, after.UpdatedAt, after.LastUpdatedBy = before.Revision, before.UpdatedAt, before.LastUpdatedBy.Clone()
	if changed {
		after.Revision = before.Revision + 1
		a.contentChanged(ctx, after)
	}
	// The reference solution is a view of a saved solution; persist a
	// change to it there.
	if !domain.RefEqual(refOf(before), refOf(after)) {
		if err := a.writeReference(tx, after.ID, refOf(after)); err != nil {
			return err
		}
	}
	return tx.UpdateItem(after)
}

// testCasesChanged records a change to the item's test cases: updatedAt
// moves and who made the change is recorded; the revision does not move.
func (a *App) testCasesChanged(ctx context.Context, tx store.Tx, it *domain.Item) error {
	a.contentChanged(ctx, it)
	return tx.UpdateItem(it)
}

// UpdateItem applies a partial update with merge semantics.
func (a *App) UpdateItem(ctx context.Context, id string, in domain.ItemInput) (domain.Item, error) {
	if in.TestCases.Set {
		return domain.Item{}, errField("testCases", "cannot be changed here; use the test case endpoints")
	}
	var out domain.Item
	err := a.store.Write(ctx, func(tx store.Tx) error {
		cur, err := tx.GetItem(id)
		if err != nil {
			return notFoundAs(err, "item")
		}
		if err := checkRevision(in.ExpectedRevision, &cur); err != nil {
			return err
		}
		if in.Type.Set && (in.Type.Null || in.Type.Val != cur.Type) {
			return errField("type", "cannot be changed after creation")
		}
		next := cur.Clone()
		fe := domain.ApplyItemInput(&next, in)
		domain.NormalizeItem(&next)
		fe.Merge("", domain.ValidateItem(&next, a.limits))
		if next.Notes != cur.Notes {
			if msg := domain.ValidateNotes(next.Notes, a.limits); msg != "" {
				fe.Add("notes", msg)
			}
		}
		var collIDs []string
		if in.CollectionIDs.Set {
			if in.CollectionIDs.Null {
				fe.Add("collectionIds", "cannot be null")
			}
			collIDs = dedupe(in.CollectionIDs.Val)
		}
		if err := errValidation(fe); err != nil {
			return err
		}
		// An origin that has been deleted may be kept, not set anew.
		if in.VariantOf.HasValue() && !samePtr(next.VariantOf, cur.VariantOf) {
			if err := checkVariantOf(tx, id, next.VariantOf); err != nil {
				return err
			}
		}
		if in.CollectionIDs.Set {
			if err := checkCollections(tx, collIDs); err != nil {
				return err
			}
			if err := tx.SetItemCollections(id, collIDs); err != nil {
				return err
			}
		}
		if err := a.saveItem(ctx, tx, &cur, &next); err != nil {
			return err
		}
		out, err = tx.GetItem(id)
		return err
	})
	return out, err
}

// TextEdit is one exact-match replacement.
type TextEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

// EditTextInput is the body of a targeted text edit.
type EditTextInput struct {
	Field            string          `json:"field"`
	ExpectedRevision domain.Opt[int] `json:"expectedRevision"`
	Edits            []TextEdit      `json:"edits"`
}

// EditItemText applies exact-match replacements to body or notes.
func (a *App) EditItemText(ctx context.Context, id string, in EditTextInput) (domain.Item, error) {
	if in.Field != "body" && in.Field != "notes" {
		return domain.Item{}, errField("field", "must be body or notes")
	}
	if len(in.Edits) == 0 {
		return domain.Item{}, errField("edits", "at least one edit is required")
	}
	var out domain.Item
	err := a.store.Write(ctx, func(tx store.Tx) error {
		cur, err := tx.GetItem(id)
		if err != nil {
			return notFoundAs(err, "item")
		}
		if err := checkRevision(in.ExpectedRevision, &cur); err != nil {
			return err
		}
		text := cur.Body
		if in.Field == "notes" {
			text = cur.Notes
		}
		for i, e := range in.Edits {
			key := "edits." + strconv.Itoa(i)
			e.OldText, e.NewText = domain.NormalizeText(e.OldText), domain.NormalizeText(e.NewText)
			if e.OldText == "" {
				return errField(key, "oldText must not be empty")
			}
			switch n := strings.Count(text, e.OldText); n {
			case 1:
				text = strings.Replace(text, e.OldText, e.NewText, 1)
			case 0:
				return errField(key, "oldText was not found")
			default:
				return errField(key, fmt.Sprintf("oldText occurs %d times; it must occur exactly once", n))
			}
		}
		if len(text) > domain.MaxTextBytes {
			return errField(in.Field, "is too long")
		}
		if in.Field == "notes" && text != cur.Notes {
			if msg := domain.ValidateNotes(text, a.limits); msg != "" {
				return errField("notes", msg)
			}
		}
		next := cur.Clone()
		if in.Field == "body" {
			next.Body = text
		} else {
			next.Notes = text
		}
		if err := a.saveItem(ctx, tx, &cur, &next); err != nil {
			return err
		}
		out, err = tx.GetItem(id)
		return err
	})
	return out, err
}

// DeleteItem deletes an item with its test cases and submissions. Its
// links, and the variantOf of its variants, are kept: they now name an
// unavailable item.
func (a *App) DeleteItem(ctx context.Context, id string) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		ok, err := tx.DeleteItem(id, a.clock())
		if err != nil {
			return err
		}
		if !ok {
			return errNotFound("item")
		}
		return nil
	})
}

// BulkInput is one action applied to many items.
type BulkInput struct {
	IDs          []string `json:"ids"`
	Action       string   `json:"action"`
	Tags         []string `json:"tags"`
	Status       string   `json:"status"`
	Favorite     *bool    `json:"favorite"`
	CollectionID string   `json:"collectionId"`
}

// BulkResult reports how many items an action affected.
type BulkResult struct {
	Affected int `json:"affected"`
}

// BulkItems applies one action to many items in one transaction. Unknown
// ids are ignored.
func (a *App) BulkItems(ctx context.Context, in BulkInput) (BulkResult, error) {
	tags := domain.NormalizeTags(in.Tags)
	switch in.Action {
	case "delete":
	case "addTags", "removeTags":
		if len(tags) == 0 {
			return BulkResult{}, errField("tags", "at least one tag is required")
		}
		for _, t := range tags {
			if msg := domain.ValidateTag(t); msg != "" {
				return BulkResult{}, errField("tags", fmt.Sprintf("tag %q %s", t, msg))
			}
		}
	case "setStatus":
		if !domain.ItemStatus(in.Status).Valid() {
			return BulkResult{}, errField("status", "must be todo, in_progress or done")
		}
	case "setFavorite":
		if in.Favorite == nil {
			return BulkResult{}, errField("favorite", "is required")
		}
	case "addToCollection", "removeFromCollection":
		if in.CollectionID == "" {
			return BulkResult{}, errField("collectionId", "is required")
		}
	default:
		return BulkResult{}, errField("action", "unknown action")
	}
	ids := dedupe(in.IDs)
	var res BulkResult
	err := a.store.Write(ctx, func(tx store.Tx) error {
		if in.Action == "addToCollection" || in.Action == "removeFromCollection" {
			if _, err := tx.GetCollection(in.CollectionID); err != nil {
				return notFoundAs(err, "collection")
			}
		}
		existing, err := tx.ExistingItemIDs(ids)
		if err != nil {
			return err
		}
		var targets []string
		for _, id := range ids {
			if existing[id] {
				targets = append(targets, id)
			}
		}
		res.Affected = len(targets)
		switch in.Action {
		case "delete":
			now := a.clock()
			for _, id := range targets {
				if _, err := tx.DeleteItem(id, now); err != nil {
					return err
				}
			}
			return nil
		case "addToCollection":
			return tx.AddCollectionItems(in.CollectionID, targets)
		case "removeFromCollection":
			for _, id := range targets {
				if _, err := tx.RemoveCollectionItem(in.CollectionID, id); err != nil {
					return err
				}
			}
			return nil
		}
		for _, id := range targets {
			cur, err := tx.GetItem(id)
			if err != nil {
				return err
			}
			next := cur.Clone()
			switch in.Action {
			case "addTags":
				next.Tags = domain.NormalizeTags(append(next.Tags, tags...))
				if len(next.Tags) > domain.MaxTags {
					return errField("tags", fmt.Sprintf("item %s would have more than %d tags", id, domain.MaxTags))
				}
			case "removeTags":
				next.Tags = slices.DeleteFunc(next.Tags, func(t string) bool { return slices.Contains(tags, t) })
			case "setStatus":
				next.Status = domain.ItemStatus(in.Status)
			case "setFavorite":
				next.Favorite = *in.Favorite
			}
			if err := a.saveItem(ctx, tx, &cur, &next); err != nil {
				return err
			}
		}
		return nil
	})
	return res, err
}

// ListTags lists every tag with its item count, empty tags included.
func (a *App) ListTags(ctx context.Context) (List[domain.Tag], error) {
	var out List[domain.Tag]
	err := a.store.Read(ctx, func(tx store.Tx) error {
		tags, err := tx.ListTags()
		out.Items = tags
		return err
	})
	return out, err
}

// RenameTag renames a tag on every item, merging with an existing tag of the
// new name. An empty tag can be renamed too.
func (a *App) RenameTag(ctx context.Context, oldName, newName string) (domain.Tag, error) {
	oldName = domain.NormalizeTag(oldName)
	newName = domain.NormalizeTag(newName)
	if msg := domain.ValidateTag(newName); msg != "" {
		return domain.Tag{}, errField("name", msg)
	}
	var out domain.Tag
	err := a.store.Write(ctx, func(tx store.Tx) error {
		if err := tagExists(tx, oldName); err != nil {
			return err
		}
		if oldName != newName {
			ids, err := tx.ItemIDsWithTag(oldName)
			if err != nil {
				return err
			}
			for _, id := range ids {
				cur, err := tx.GetItem(id)
				if err != nil {
					return err
				}
				next := cur.Clone()
				for i, t := range next.Tags {
					if t == oldName {
						next.Tags[i] = newName
					}
				}
				next.Tags = domain.NormalizeTags(next.Tags)
				if err := a.saveItem(ctx, tx, &cur, &next); err != nil {
					return err
				}
			}
			if err := tx.InsertTag(newName); err != nil {
				return err
			}
			if err := tx.DeleteTag(oldName); err != nil {
				return err
			}
		}
		withNew, err := tx.ItemIDsWithTag(newName)
		out = domain.Tag{Name: newName, Count: len(withNew)}
		return err
	})
	return out, err
}

// DeleteTag removes a tag from every item, then the tag itself.
func (a *App) DeleteTag(ctx context.Context, name string) error {
	name = domain.NormalizeTag(name)
	return a.store.Write(ctx, func(tx store.Tx) error {
		if err := tagExists(tx, name); err != nil {
			return err
		}
		ids, err := tx.ItemIDsWithTag(name)
		if err != nil {
			return err
		}
		for _, id := range ids {
			cur, err := tx.GetItem(id)
			if err != nil {
				return err
			}
			next := cur.Clone()
			next.Tags = slices.DeleteFunc(next.Tags, func(t string) bool { return t == name })
			if err := a.saveItem(ctx, tx, &cur, &next); err != nil {
				return err
			}
		}
		return tx.DeleteTag(name)
	})
}

// tagExists returns a not-found error unless the tag exists.
func tagExists(tx store.Tx, name string) error {
	ok, err := tx.TagExists(name)
	if err == nil && !ok {
		err = errNotFound("tag")
	}
	return err
}

// Stats returns library statistics.
func (a *App) Stats(ctx context.Context) (domain.Stats, error) {
	var s domain.Stats
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var err error
		s, err = tx.Stats()
		return err
	})
	return s, err
}
