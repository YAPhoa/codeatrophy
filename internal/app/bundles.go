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

	"codeathropy/internal/bundle"
	"codeathropy/internal/domain"
	"codeathropy/internal/store"
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
		GeneratorName: "codeathropy", GeneratorVersion: a.version,
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
				b.Meta.Name = "Codeathropy library"
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
				b.Meta.Name = "Codeathropy library"
			}
		}
		for _, id := range itemIDs {
			it, err := tx.GetItem(id)
			if err != nil {
				return err
			}
			var cases []domain.TestCase
			if it.Type == domain.TypeProblem {
				if cases, err = tx.ListTestCases(id); err != nil {
					return err
				}
			}
			b.Items = append(b.Items, bundle.FromDomain(it, cases, includeSolutions, includeHidden))
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
	return ExportResult{Filename: bundle.Slug(b.Meta.Name) + ".codeathropy.zip", Data: buf.Bytes(), Items: len(b.Items)}, nil
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
			StarterCode: map[string]string{}, ReferenceSolution: it.Problem.ReferenceSolution,
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
func (a *App) plan(tx store.Tx, b *bundle.Bundle) ([]itemPlan, map[string]bool, error) {
	plans := make([]itemPlan, 0, len(b.Items))
	for _, it := range b.Items {
		local, err := tx.GetItem(it.ID)
		if errors.Is(err, store.ErrNotFound) {
			plans = append(plans, itemPlan{item: it, state: "new", changes: []string{}})
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		var cases []domain.TestCase
		if local.Type == domain.TypeProblem {
			if cases, err = tx.ListTestCases(it.ID); err != nil {
				return nil, nil, err
			}
		}
		// Compare over the same fields the bundle carries.
		mine := bundle.FromDomain(local, cases, it.HasSolution(), !it.SamplesOnly())
		state, changes := "changed", bundle.Changes(&mine, &it)
		if bundle.ContentHash(&mine) == bundle.ContentHash(&it) {
			state, changes = "unchanged", []string{}
		} else if mine.Type != it.Type && len(changes) == 0 {
			changes = []string{"type"}
		}
		l := local
		plans = append(plans, itemPlan{item: it, state: state, local: &l, changes: changes})
	}
	existing := map[string]bool{}
	for _, c := range b.Collections {
		_, err := tx.GetCollection(c.ID)
		if err == nil {
			existing[c.ID] = true
		} else if !errors.Is(err, store.ErrNotFound) {
			return nil, nil, err
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
		plans, existing, err := a.plan(tx, b)
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
		plans, existing, err := a.plan(tx, b)
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
			if variant != nil {
				d.VariantOf = variant
				linkVariants = append(linkVariants, d)
			}
			return nil
		}
		for _, p := range plans {
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
		// Variant links are kept when the target exists in the library.
		for _, d := range linkVariants {
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
		created := map[string]bool{}
		order := collectionOrder(b.Collections)
		for _, c := range order {
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
				Position: len(siblings(all, parent, "")), CreatedAt: now, UpdatedAt: now}
			if err := tx.InsertCollection(&nc); err != nil {
				return err
			}
			all = append(all, nc)
			created[c.ID] = true
			res.CollectionsCreated++
			if err := tx.AddCollectionItems(c.ID, members); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return ImportResult{}, err
	}
	return res, nil
}

// collectionOrder sorts bundle collections so that parents come before
// children, and siblings follow their bundle positions.
func collectionOrder(cs []bundle.Collection) []bundle.Collection {
	inBundle := map[string]bool{}
	for _, c := range cs {
		inBundle[c.ID] = true
	}
	var out []bundle.Collection
	var visit func(parent *string)
	visit = func(parent *string) {
		var level []bundle.Collection
		for _, c := range cs {
			p := c.ParentID
			if p != nil && !inBundle[*p] {
				p = nil
			}
			if samePtr(p, parent) {
				level = append(level, c)
			}
		}
		slices.SortStableFunc(level, func(x, y bundle.Collection) int { return x.Position - y.Position })
		for _, c := range level {
			out = append(out, c)
			id := c.ID
			visit(&id)
		}
	}
	visit(nil)
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
// personal state and submissions, and keeping the local reference solution
// and hidden test cases when the bundle does not carry them.
func (a *App) overwrite(tx store.Tx, p itemPlan, now time.Time, links *[]domain.Item) error {
	local := *p.local
	next := a.toDomain(p.item, local.ID, now)
	next.Status, next.Favorite, next.Notes, next.RawInput = local.Status, local.Favorite, local.Notes, local.RawInput
	next.CreatedAt = local.CreatedAt
	next.Revision = local.Revision + 1
	if next.Problem != nil && !p.item.HasSolution() && local.Problem != nil {
		next.Problem.ReferenceSolution = local.Problem.ReferenceSolution
	}
	variant := next.VariantOf
	next.VariantOf = nil
	if err := tx.UpdateItem(&next); err != nil {
		return err
	}
	var keepHidden []domain.TestCase
	if next.Type == domain.TypeProblem && p.item.SamplesOnly() {
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
