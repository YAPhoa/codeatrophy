package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"codeatrophy/internal/bundle"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// ExportInput is the body of POST /export.
type ExportInput struct {
	Scope              string           `json:"scope"`
	CollectionID       string           `json:"collectionId"`
	ItemIDs            []string         `json:"itemIds"`
	Name               string           `json:"name"`
	Description        string           `json:"description"`
	Author             string           `json:"author"`
	IncludeSolutions   domain.Opt[bool] `json:"includeSolutions"`
	IncludeHiddenTests domain.Opt[bool] `json:"includeHiddenTests"`
}

// ExportResult is a finished bundle archive.
type ExportResult struct {
	Filename string
	Data     []byte
	Items    int
}

// Export builds a bundle archive. Bundles carry content only: personal
// state, submissions, raw AI input, settings and style presets are never
// included.
func (a *App) Export(ctx context.Context, in ExportInput) (ExportResult, error) {
	scope := in.Scope
	if scope == "" {
		scope = "all"
	}
	fe := domain.FieldErrors{}
	switch scope {
	case "all":
	case "collection":
		if in.CollectionID == "" {
			fe.Add("collectionId", "is required for scope collection")
		}
	case "items":
		if len(in.ItemIDs) == 0 {
			fe.Add("itemIds", "is required for scope items")
		}
	default:
		fe.Add("scope", "must be all, collection or items")
	}
	if utf8.RuneCountInString(in.Name) > domain.MaxBundleNameChars {
		fe.Add("name", fmt.Sprintf("must be at most %d characters", domain.MaxBundleNameChars))
	}
	if utf8.RuneCountInString(in.Description) > domain.MaxBundleDescriptionChars {
		fe.Add("description", fmt.Sprintf("must be at most %d characters", domain.MaxBundleDescriptionChars))
	}
	if utf8.RuneCountInString(in.Author) > domain.MaxBundleNameChars {
		fe.Add("author", fmt.Sprintf("must be at most %d characters", domain.MaxBundleNameChars))
	}
	if err := errValidation(fe); err != nil {
		return ExportResult{}, err
	}
	includeSolutions := !in.IncludeSolutions.Set || in.IncludeSolutions.Val
	includeHidden := !in.IncludeHiddenTests.Set || in.IncludeHiddenTests.Val
	b := &bundle.Bundle{Meta: bundle.Meta{
		Name: strings.TrimSpace(in.Name), Description: in.Description, Author: in.Author,
		FormatVersion: bundle.FormatVersion, CreatedAt: a.clock(),
		GeneratorName: "codeatrophy", GeneratorVersion: a.version,
		Includes: &bundle.Includes{Solutions: includeSolutions, HiddenTests: includeHidden},
	}}
	err := a.store.Read(ctx, func(tx store.Tx) error {
		var itemIDs []string
		switch scope {
		case "all":
			ids, err := tx.AllItemIDs()
			if err != nil {
				return err
			}
			itemIDs = ids
			all, err := tx.ListCollections()
			if err != nil {
				return err
			}
			for _, c := range all {
				members, err := tx.CollectionItemIDs(c.ID)
				if err != nil {
					return err
				}
				b.Collections = append(b.Collections, bundle.Collection{ID: c.ID, Name: c.Name, Description: c.Description,
					ParentID: c.ParentID, Position: c.Position, ItemIDs: members})
			}
			if b.Meta.Name == "" {
				b.Meta.Name = "Codeatrophy library"
			}
		case "collection":
			all, err := tx.ListCollections()
			if err != nil {
				return err
			}
			root := slices.IndexFunc(all, func(c domain.Collection) bool { return c.ID == in.CollectionID })
			if root < 0 {
				return errField("collectionId", "collection does not exist")
			}
			if b.Meta.Name == "" {
				b.Meta.Name = all[root].Name
			}
			seen := map[string]bool{}
			queue := []domain.Collection{all[root]}
			for len(queue) > 0 {
				c := queue[0]
				queue = queue[1:]
				members, err := tx.CollectionItemIDs(c.ID)
				if err != nil {
					return err
				}
				parent := c.ParentID
				if c.ID == in.CollectionID {
					parent = nil
				}
				b.Collections = append(b.Collections, bundle.Collection{ID: c.ID, Name: c.Name, Description: c.Description,
					ParentID: parent, Position: c.Position, ItemIDs: members})
				for _, id := range members {
					if !seen[id] {
						seen[id] = true
						itemIDs = append(itemIDs, id)
					}
				}
				queue = append(queue, siblings(all, &c.ID, "")...)
			}
		case "items":
			ids := dedupe(in.ItemIDs)
			existing, err := tx.ExistingItemIDs(ids)
			if err != nil {
				return err
			}
			for _, id := range ids {
				if !existing[id] {
					return errField("itemIds", fmt.Sprintf("item %s does not exist", id))
				}
			}
			itemIDs = ids
			if b.Meta.Name == "" {
				b.Meta.Name = "Codeatrophy library"
			}
		}
		for _, id := range itemIDs {
			it, err := tx.GetItem(id)
			if err != nil {
				return err
			}
			var cases []domain.TestCase
			var sols []domain.ItemSolution
			if it.Type == domain.TypeProblem {
				if cases, err = tx.ListTestCases(id); err != nil {
					return err
				}
				if sols, err = tx.ListSolutions(id); err != nil {
					return err
				}
			}
			b.Items = append(b.Items, bundle.FromDomain(it, cases, sols, includeSolutions, includeHidden))
		}
		return nil
	})
	if err != nil {
		return ExportResult{}, err
	}
	if b.Collections == nil {
		b.Collections = []bundle.Collection{}
	}
	var buf bytes.Buffer
	if err := bundle.Write(&buf, b); err != nil {
		return ExportResult{}, err
	}
	return ExportResult{Filename: bundle.Slug(b.Meta.Name) + ".codeatrophy.zip", Data: buf.Bytes(), Items: len(b.Items)}, nil
}

// Import strategies for changed items.
const (
	StrategySkip      = "skip"
	StrategyOverwrite = "overwrite"
	StrategyDuplicate = "duplicate"
)

// PreviewBundle describes the bundle in an import preview.
type PreviewBundle struct {
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	Author        string     `json:"author"`
	FormatVersion int        `json:"formatVersion"`
	CreatedAt     *time.Time `json:"createdAt"`
}

// PreviewItem is one item in an import preview.
type PreviewItem struct {
	ID            string          `json:"id"`
	Title         string          `json:"title"`
	Type          domain.ItemType `json:"type"`
	State         string          `json:"state"`
	TestCaseCount int             `json:"testCaseCount"`
	Changes       []string        `json:"changes"`
}

// PreviewCollection is one collection in an import preview.
type PreviewCollection struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	State     string `json:"state"`
	ItemCount int    `json:"itemCount"`
}

// PreviewCounts counts items by state.
type PreviewCounts struct {
	New       int `json:"new"`
	Changed   int `json:"changed"`
	Unchanged int `json:"unchanged"`
}

// ImportPreview reports what an import would do.
type ImportPreview struct {
	Bundle      PreviewBundle       `json:"bundle"`
	Items       []PreviewItem       `json:"items"`
	Collections []PreviewCollection `json:"collections"`
	Counts      PreviewCounts       `json:"counts"`
	Warnings    []string            `json:"warnings"`
}

// ImportResult reports what an import did.
type ImportResult struct {
	Created            int      `json:"created"`
	Updated            int      `json:"updated"`
	Skipped            int      `json:"skipped"`
	Duplicated         int      `json:"duplicated"`
	Unchanged          int      `json:"unchanged"`
	CollectionsCreated int      `json:"collectionsCreated"`
	Warnings           []string `json:"warnings"`
}

func (a *App) readBundle(data []byte) (*bundle.Bundle, []string, error) {
	b, warnings, err := bundle.Read(data, bundle.DefaultLimits(a.limits.MaxImportBytes, a.limits.MaxSourceBytes))
	switch {
	case err == nil:
	case bundle.IsLimitError(err):
		return nil, nil, &Error{Code: CodeTooLarge, Message: err.Error()}
	case bundle.IsFormatError(err):
		return nil, nil, &Error{Code: CodeValidation, Message: err.Error(), Fields: map[string]any{"file": err.Error()}}
	default:
		return nil, nil, err
	}
	// Validate every item as the API would; invalid items are skipped.
	kept := b.Items[:0]
	for _, it := range b.Items {
		d := a.toDomain(it, it.ID, a.clock())
		if fe := domain.ValidateItem(&d, a.limits); len(fe) > 0 {
			warnings = append(warnings, fmt.Sprintf("%s: %s; item skipped", it.Dir, fe.First()))
			continue
		}
		kept = append(kept, it)
	}
	b.Items = kept
	valid := map[string]bool{}
	for _, it := range b.Items {
		valid[it.ID] = true
	}
	for i := range b.Collections {
		b.Collections[i].ItemIDs = slices.DeleteFunc(b.Collections[i].ItemIDs, func(id string) bool { return !valid[id] })
	}
	if warnings == nil {
		warnings = []string{}
	}
	return b, warnings, nil
}

// toDomain converts a bundle item into a library item with default personal
// state.
func (a *App) toDomain(it bundle.Item, id string, now time.Time) domain.Item {
	d := domain.Item{ItemSummary: domain.ItemSummary{
		ID: id, Type: it.Type, Title: it.Title, Summary: it.Summary, Difficulty: it.Difficulty,
		Tags: slices.Clone(it.Tags), Status: domain.StatusTodo, VariantOf: it.VariantOf, Revision: 1,
		CreatedAt: it.CreatedAt, UpdatedAt: now,
	}, Body: it.Body, Source: it.Source}
	if it.Type == domain.TypeProblem && it.Problem != nil {
		d.Problem = &domain.ProblemSpec{
			TimeLimitMs: it.Problem.TimeLimitMs, MemoryLimitKb: it.Problem.MemoryLimitKb, Compare: it.Problem.Compare,
			StarterCode: map[string]string{},
		}
		for k, v := range it.Problem.StarterCode {
			d.Problem.StarterCode[k] = v
		}
	}
	if d.CreatedAt.IsZero() {
		d.CreatedAt = now
	}
	domain.NormalizeItem(&d)
	return d
}

type itemPlan struct {
	item    bundle.Item
	state   string // new, unchanged, changed
	local   *domain.Item
	changes []string
}

// plan compares the bundle with the library by id.
func (a *App) plan(ctx context.Context, tx store.Tx, b *bundle.Bundle) ([]itemPlan, map[string]bool, error) {
	inBundle := make(map[string]bool, len(b.Items))
	var targets []string
	for _, it := range b.Items {
		inBundle[it.ID] = true
		if it.VariantOf != nil {
			targets = append(targets, *it.VariantOf)
		}
	}
	// A variantOf link to an item in neither the bundle nor the library is
	// dropped on import; drop it before comparing too, so that re-importing
	// the same bundle is "unchanged".
	exists, err := tx.ExistingItemIDs(targets)
	if err != nil {
		return nil, nil, err
	}
	for i := range b.Items {
		if v := b.Items[i].VariantOf; v != nil && !inBundle[*v] && !exists[*v] {
			b.Items[i].VariantOf = nil
		}
	}
	plans := make([]itemPlan, 0, len(b.Items))
	for _, it := range b.Items {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		local, err := tx.GetItem(it.ID)
		if errors.Is(err, store.ErrNotFound) {
			plans = append(plans, itemPlan{item: it, state: "new", changes: []string{}})
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		var cases []domain.TestCase
		var sols []domain.ItemSolution
		if local.Type == domain.TypeProblem {
			if cases, err = tx.ListTestCases(it.ID); err != nil {
				return nil, nil, err
			}
			if sols, err = tx.ListSolutions(it.ID); err != nil {
				return nil, nil, err
			}
		}
		// Compare over the same fields the bundle carries.
		mine := bundle.FromDomain(local, cases, sols, it.HasSolutions(), it.HasHiddenTests())
		state, changes := "changed", bundle.Changes(&mine, &it)
		if bundle.ContentHash(&mine) == bundle.ContentHash(&it) {
			state, changes = "unchanged", []string{}
		}
		l := local
		plans = append(plans, itemPlan{item: it, state: state, local: &l, changes: changes})
	}
	all, err := tx.ListCollections()
	if err != nil {
		return nil, nil, err
	}
	have := make(map[string]bool, len(all))
	for _, c := range all {
		have[c.ID] = true
	}
	existing := map[string]bool{}
	for _, c := range b.Collections {
		if have[c.ID] {
			existing[c.ID] = true
		}
	}
	return plans, existing, nil
}

// PreviewImport reports what importing the bundle would do. Nothing is
// written.
func (a *App) PreviewImport(ctx context.Context, data []byte) (ImportPreview, error) {
	b, warnings, err := a.readBundle(data)
	if err != nil {
		return ImportPreview{}, err
	}
	out := ImportPreview{
		Bundle: PreviewBundle{Name: b.Meta.Name, Description: b.Meta.Description, Author: b.Meta.Author,
			FormatVersion: b.Meta.FormatVersion},
		Items: []PreviewItem{}, Collections: []PreviewCollection{}, Warnings: warnings,
	}
	if !b.Meta.CreatedAt.IsZero() {
		t := b.Meta.CreatedAt.Truncate(time.Second)
		out.Bundle.CreatedAt = &t
	}
	err = a.store.Read(ctx, func(tx store.Tx) error {
		plans, existing, err := a.plan(ctx, tx, b)
		if err != nil {
			return err
		}
		for _, p := range plans {
			out.Items = append(out.Items, PreviewItem{ID: p.item.ID, Title: p.item.Title, Type: p.item.Type,
				State: p.state, TestCaseCount: len(p.item.TestCases), Changes: p.changes})
			switch p.state {
			case "new":
				out.Counts.New++
			case "changed":
				out.Counts.Changed++
			default:
				out.Counts.Unchanged++
			}
		}
		for _, c := range b.Collections {
			state := "new"
			if existing[c.ID] {
				state = "existing"
			}
			out.Collections = append(out.Collections, PreviewCollection{ID: c.ID, Name: c.Name, State: state, ItemCount: len(c.ItemIDs)})
		}
		return nil
	})
	return out, err
}

// Import applies a bundle in one transaction.
func (a *App) Import(ctx context.Context, data []byte, strategy string) (ImportResult, error) {
	if strategy == "" {
		strategy = StrategySkip
	}
	if strategy != StrategySkip && strategy != StrategyOverwrite && strategy != StrategyDuplicate {
		return ImportResult{}, errField("strategy", "must be skip, overwrite or duplicate")
	}
	b, warnings, err := a.readBundle(data)
	if err != nil {
		return ImportResult{}, err
	}
	res := ImportResult{Warnings: warnings}
	err = a.store.Write(ctx, func(tx store.Tx) error {
		plans, existing, err := a.plan(ctx, tx, b)
		if err != nil {
			return err
		}
		now := a.clock()
		finalID := map[string]string{} // bundle id -> library id
		var linkVariants []domain.Item // items whose variantOf is set after all inserts
		insert := func(it bundle.Item, id string) error {
			d := a.toDomain(it, id, now)
			variant := d.VariantOf
			d.VariantOf = nil
			if err := tx.InsertItem(&d); err != nil {
				return err
			}
			if err := a.insertBundleCases(tx, id, it.TestCases, 0, now); err != nil {
				return err
			}
			if err := a.insertBundleSolutions(tx, id, it.Solutions, now); err != nil {
				return err
			}
			if variant != nil {
				d.VariantOf = variant
				linkVariants = append(linkVariants, d)
			}
			return nil
		}
		for _, p := range plans {
			if err := ctx.Err(); err != nil {
				return err
			}
			id := p.item.ID
			finalID[id] = id
			switch p.state {
			case "new":
				if err := insert(p.item, id); err != nil {
					return err
				}
				res.Created++
			case "unchanged":
				res.Unchanged++
			case "changed":
				switch {
				case strategy == StrategySkip:
					res.Skipped++
				case strategy == StrategyDuplicate || p.local.Type != p.item.Type:
					if strategy == StrategyOverwrite {
						res.Warnings = append(res.Warnings, fmt.Sprintf("%s: the local item has a different type; imported as a copy", p.item.Dir))
					}
					nid := newID()
					finalID[id] = nid
					if err := insert(p.item, nid); err != nil {
						return err
					}
					res.Duplicated++
				default:
					if err := a.overwrite(tx, p, now, &linkVariants); err != nil {
						return err
					}
					res.Updated++
				}
			}
		}
		// Variant links are kept when the target exists in the library. A
		// link to an item duplicated by this import points at the copy.
		for _, d := range linkVariants {
			if target, ok := finalID[*d.VariantOf]; ok {
				d.VariantOf = &target
			}
			ok, err := tx.ExistingItemIDs([]string{*d.VariantOf})
			if err != nil {
				return err
			}
			if !ok[*d.VariantOf] || *d.VariantOf == d.ID {
				continue // the link is dropped (it was stored as null)
			}
			cur, err := tx.GetItem(d.ID)
			if err != nil {
				return err
			}
			cur.VariantOf = d.VariantOf
			if err := tx.UpdateItem(&cur); err != nil {
				return err
			}
		}
		// Collections, parents first.
		all, err := tx.ListCollections()
		if err != nil {
			return err
		}
		childCount := map[string]int{} // parent id ("" for the top level) -> children
		for _, c := range all {
			childCount[parentKey(c.ParentID)]++
		}
		created := map[string]bool{}
		for _, c := range collectionOrder(b.Collections) {
			if err := ctx.Err(); err != nil {
				return err
			}
			members := make([]string, 0, len(c.ItemIDs))
			for _, iid := range c.ItemIDs {
				members = append(members, finalID[iid])
			}
			if existing[c.ID] {
				if err := tx.AddCollectionItems(c.ID, members); err != nil {
					return err
				}
				continue
			}
			parent := c.ParentID
			if parent != nil && !existing[*parent] && !created[*parent] {
				parent = nil
			}
			nc := domain.Collection{ID: c.ID, Name: c.Name, Description: c.Description, ParentID: parent,
				Position: childCount[parentKey(parent)], CreatedAt: now, UpdatedAt: now}
			if err := tx.InsertCollection(&nc); err != nil {
				return err
			}
			childCount[parentKey(parent)]++
			created[c.ID] = true
			res.CollectionsCreated++
			if len(members) > 0 {
				if err := tx.AddCollectionItems(c.ID, members); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return ImportResult{}, err
	}
	return res, nil
}

func parentKey(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// collectionOrder sorts bundle collections so that parents come before
// children, and siblings follow their bundle positions. It runs in
// O(n log n); parent cycles were already broken by the reader.
func collectionOrder(cs []bundle.Collection) []bundle.Collection {
	inBundle := make(map[string]bool, len(cs))
	for _, c := range cs {
		inBundle[c.ID] = true
	}
	children := map[string][]int{}
	for i, c := range cs {
		p := ""
		if c.ParentID != nil && inBundle[*c.ParentID] {
			p = *c.ParentID
		}
		children[p] = append(children[p], i)
	}
	for _, idx := range children {
		slices.SortStableFunc(idx, func(x, y int) int { return cs[x].Position - cs[y].Position })
	}
	// A depth-first walk emitting each node before its children.
	out := make([]bundle.Collection, 0, len(cs))
	var walk []int
	for k := len(children[""]) - 1; k >= 0; k-- {
		walk = append(walk, children[""][k])
	}
	for len(walk) > 0 {
		i := walk[len(walk)-1]
		walk = walk[:len(walk)-1]
		out = append(out, cs[i])
		kids := children[cs[i].ID]
		for k := len(kids) - 1; k >= 0; k-- {
			walk = append(walk, kids[k])
		}
	}
	return out
}

func (a *App) insertBundleCases(tx store.Tx, itemID string, cases []bundle.TestCase, start int, now time.Time) error {
	for i, c := range cases {
		tc := domain.TestCase{ID: newID(), ItemID: itemID, Position: start + i, Name: c.Name, Stdin: c.Stdin,
			ExpectedStdout: c.ExpectedStdout, IsSample: c.IsSample, Origin: c.Origin, Verified: c.Verified,
			CreatedAt: now, UpdatedAt: now}
		if !tc.Origin.Valid() {
			tc.Origin = domain.OriginImport
		}
		if err := tx.InsertTestCase(&tc); err != nil {
			return err
		}
	}
	return nil
}

// overwrite replaces a local item's content with the bundle's, keeping
// personal state and submissions, and keeping the local solutions and hidden
// test cases when the bundle does not carry them.
func (a *App) overwrite(tx store.Tx, p itemPlan, now time.Time, links *[]domain.Item) error {
	local := *p.local
	next := a.toDomain(p.item, local.ID, now)
	next.Status, next.Favorite, next.Notes, next.RawInput = local.Status, local.Favorite, local.Notes, local.RawInput
	next.CreatedAt = local.CreatedAt
	next.Revision = local.Revision
	if overwriteChangesContent(p) {
		next.Revision++
	}
	variant := next.VariantOf
	next.VariantOf = nil
	if err := tx.UpdateItem(&next); err != nil {
		return err
	}
	var keepHidden []domain.TestCase
	if next.Type == domain.TypeProblem && !p.item.HasHiddenTests() {
		cur, err := tx.ListTestCases(local.ID)
		if err != nil {
			return err
		}
		for _, c := range cur {
			if !c.IsSample {
				keepHidden = append(keepHidden, c)
			}
		}
	}
	if p.item.HasSolutions() || next.Type != domain.TypeProblem {
		if err := tx.DeleteSolutions(local.ID); err != nil {
			return err
		}
		if err := a.insertBundleSolutions(tx, local.ID, p.item.Solutions, now); err != nil {
			return err
		}
	}
	if err := tx.DeleteTestCases(local.ID); err != nil {
		return err
	}
	if next.Type == domain.TypeProblem {
		if err := a.insertBundleCases(tx, local.ID, p.item.TestCases, 0, now); err != nil {
			return err
		}
		for i, c := range keepHidden {
			c.Position = len(p.item.TestCases) + i
			if err := tx.InsertTestCase(&c); err != nil {
				return err
			}
		}
	}
	next.VariantOf = variant
	if variant != nil {
		*links = append(*links, next)
	}
	return nil
}

func (a *App) insertBundleSolutions(tx store.Tx, itemID string, sols []bundle.Solution, now time.Time) error {
	for _, s := range sols {
		sol := domain.ItemSolution{ID: newID(), ItemID: itemID, Name: s.Name, Language: s.Language, Source: s.Source,
			Notes: s.Notes, IsReference: s.IsReference, CreatedAt: now, UpdatedAt: now}
		if err := tx.InsertSolution(&sol); err != nil {
			return err
		}
	}
	return nil
}

// overwriteChangesContent reports whether overwriting with the bundle item
// changes the local item's own content (and so its revision): any changed
// field other than test cases and solutions, or a different reference
// solution when the bundle carries solutions.
func overwriteChangesContent(p itemPlan) bool {
	for _, c := range p.changes {
		if c != "testCases" && c != "solutions" {
			return true
		}
	}
	if !p.item.HasSolutions() {
		return false
	}
	var bundleRef *domain.Solution
	for _, s := range p.item.Solutions {
		if s.IsReference {
			bundleRef = &domain.Solution{Language: s.Language, Source: s.Source}
		}
	}
	return !domain.RefEqual(refOf(p.local), bundleRef)
}
