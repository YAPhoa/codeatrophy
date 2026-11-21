// Package dbcopy copies the complete contents of one store into another,
// of the same backend or another one: every table of the logical schema,
// with ids, timestamps, revisions and insertion order unchanged.
package dbcopy

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"codeatrophy/internal/store"
)

// ErrNotEmpty is returned when the destination already holds library data
// and replacing it was not asked for.
var ErrNotEmpty = errors.New("the destination already holds library data")

// Options configure Copy.
type Options struct {
	// Replace allows a destination that holds library data; its contents
	// are deleted first.
	Replace bool
}

// Copy replaces the contents of dst with those of src, in one transaction
// on dst that commits only when every table has the same number of rows on
// both sides. Both must be at the same schema version. The destination's
// own built-in style presets do not survive: afterwards it has exactly the
// source's presets. API keys are copied as stored, encrypted with the
// instance's secret key, which is not part of the database.
//
// It returns the number of rows copied per table.
func Copy(ctx context.Context, src, dst store.Bulk, opts Options) ([]store.TableCount, error) {
	sv, err := src.SchemaVersion(ctx)
	if err != nil {
		return nil, fmt.Errorf("source: %w", err)
	}
	dv, err := dst.SchemaVersion(ctx)
	if err != nil {
		return nil, fmt.Errorf("destination: %w", err)
	}
	if sv != dv {
		return nil, fmt.Errorf("the source is at schema version %d and the destination at %d; "+
			"open both with this server first so that both are migrated", sv, dv)
	}
	var counts []store.TableCount
	err = src.Export(ctx, func(d store.Dump) error {
		counts = counts[:0]
		for _, t := range store.Tables {
			n, err := d.Count(t)
			if err != nil {
				return fmt.Errorf("source: %s: %w", t.Name, err)
			}
			counts = append(counts, store.TableCount{Table: t.Name, Rows: n})
		}
		return dst.Import(ctx, func(l store.Load) error {
			if !opts.Replace {
				empty, err := IsEmpty(l)
				if err != nil {
					return fmt.Errorf("destination: %w", err)
				}
				if !empty {
					return ErrNotEmpty
				}
			}
			if err := l.Clear(); err != nil {
				return fmt.Errorf("destination: clear: %w", err)
			}
			for _, t := range store.Tables {
				if err := d.Rows(t, func(row []any) error { return l.Insert(t, row) }); err != nil {
					return fmt.Errorf("copy %s: %w", t.Name, err)
				}
			}
			if err := l.Finish(); err != nil {
				return fmt.Errorf("destination: %w", err)
			}
			for _, c := range counts {
				t, _ := store.TableByName(c.Table)
				n, err := l.Count(t)
				if err != nil {
					return fmt.Errorf("destination: %s: %w", t.Name, err)
				}
				if n != c.Rows {
					return fmt.Errorf("%s: %d rows in the source but %d in the destination", t.Name, c.Rows, n)
				}
			}
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	return counts, nil
}

// IsEmpty reports whether a database holds no library data. That is the
// case when every table is empty, except that style presets may remain as
// long as each one is a built-in preset as the migrations seed it, never
// edited (same name, instructions and default flag, and not updated since
// it was created). Anything else, a setting included, counts as data.
func IsEmpty(d store.Dump) (bool, error) {
	for _, t := range store.Tables {
		if t.Name == "style_presets" {
			continue
		}
		n, err := d.Count(t)
		if err != nil {
			return false, err
		}
		if n > 0 {
			return false, nil
		}
	}
	t, _ := store.TableByName("style_presets")
	col := map[string]int{}
	for i, c := range t.Columns {
		col[c] = i
	}
	empty := true
	err := d.Rows(t, func(row []any) error {
		if !isBuiltin(row, col) {
			empty = false
		}
		return nil
	})
	return empty, err
}

func isBuiltin(row []any, col map[string]int) bool {
	name, _ := row[col["name"]].(string)
	instructions, _ := row[col["instructions"]].(string)
	isDefault, _ := row[col["is_default"]].(int64)
	created, _ := row[col["created_at"]].(int64)
	updated, _ := row[col["updated_at"]].(int64)
	if created != updated {
		return false
	}
	for _, b := range store.BuiltinStylePresets {
		if b.Name == name && b.Instructions == instructions && b.IsDefault == (isDefault != 0) {
			return true
		}
	}
	return false
}

// Empty reports whether the store holds no library data (see IsEmpty).
func Empty(ctx context.Context, b store.Bulk) (bool, error) {
	var empty bool
	err := b.Export(ctx, func(d store.Dump) error {
		var err error
		empty, err = IsEmpty(d)
		return err
	})
	return empty, err
}

// Summary describes row counts in words, such as "12 items, 1 setting".
// Empty tables are left out.
func Summary(counts []store.TableCount) string {
	names := map[string][2]string{
		"settings":           {"setting", "settings"},
		"ai_providers":       {"AI provider", "AI providers"},
		"ai_usage":           {"day of AI usage", "days of AI usage"},
		"ai_log":             {"AI log entry", "AI log entries"},
		"ai_log_texts":       {"AI log text", "AI log texts"},
		"ai_log_bodies":      {"AI log body", "AI log bodies"},
		"ai_jobs":            {"AI job", "AI jobs"},
		"drafts":             {"draft", "drafts"},
		"style_presets":      {"style preset", "style presets"},
		"items":              {"item", "items"},
		"item_links":         {"item link", "item links"},
		"deleted_items":      {"deleted item", "deleted items"},
		"tags":               {"tag", "tags"},
		"item_tags":          {"tag assignment", "tag assignments"},
		"collections":        {"collection", "collections"},
		"collection_items":   {"collection entry", "collection entries"},
		"test_cases":         {"test case", "test cases"},
		"solutions":          {"solution", "solutions"},
		"submissions":        {"submission", "submissions"},
		"submission_results": {"submission result", "submission results"},
	}
	var parts []string
	for _, c := range counts {
		if c.Rows == 0 {
			continue
		}
		n, ok := names[c.Table]
		if !ok {
			n = [2]string{c.Table, c.Table}
		}
		word := n[1]
		if c.Rows == 1 {
			word = n[0]
		}
		parts = append(parts, fmt.Sprintf("%d %s", c.Rows, word))
	}
	if len(parts) == 0 {
		return "nothing"
	}
	return strings.Join(parts, ", ")
}
