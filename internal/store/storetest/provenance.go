package storetest

import (
	"testing"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// An item keeps who created it, written on insert only, and who last
// changed it, written by every update; either may be unknown, and a record
// of a client and model the store is given comes back as it was.
func testItemProvenance(t *testing.T, db store.Store) {
	client, model := "claude-code é 🙂", "claude-opus-5-5"
	get := func(id string) domain.Item {
		t.Helper()
		return Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem(id) })
	}
	check := func(what, id, created, updated string) {
		t.Helper()
		it := get(id)
		if got := sourceText(it.CreatedBy); got != created {
			t.Errorf("%s: created by %q, want %q", what, got, created)
		}
		if got := sourceText(it.LastUpdatedBy); got != updated {
			t.Errorf("%s: last updated by %q, want %q", what, got, updated)
		}
	}

	known, unknown := Item("known", "Known", domain.TypeProblem), Item("unknown", "Unknown", domain.TypeReading)
	known.CreatedBy = &domain.ChangeSource{Via: domain.ViaMCP, Client: &client, Model: &model}
	known.LastUpdatedBy = &domain.ChangeSource{Via: domain.ViaMCP, Client: &client}
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&known); err != nil {
			return err
		}
		return tx.InsertItem(&unknown)
	})
	check("inserted", "known", "mcp claude-code é 🙂 claude-opus-5-5", "mcp claude-code é 🙂 -")
	check("inserted unknown", "unknown", "nobody", "nobody")

	// An update writes who last changed the item and never who created it.
	update := func(id string, created, updated *domain.ChangeSource) {
		t.Helper()
		Write(t, db, func(tx store.Tx) error {
			it, err := tx.GetItem(id)
			if err != nil {
				return err
			}
			it.CreatedBy, it.LastUpdatedBy = created, updated
			return tx.UpdateItem(&it)
		})
	}
	update("known", &domain.ChangeSource{Via: domain.ViaHTTP}, &domain.ChangeSource{Via: domain.ViaImport, Model: &model})
	check("updated", "known", "mcp claude-code é 🙂 claude-opus-5-5", "import - claude-opus-5-5")
	update("known", nil, nil)
	check("updated by nobody", "known", "mcp claude-code é 🙂 claude-opus-5-5", "nobody")
	update("unknown", &domain.ChangeSource{Via: domain.ViaHTTP}, &domain.ChangeSource{Via: domain.ViaHTTP})
	check("unknown, updated", "unknown", "nobody", "http - -")

	// Lists read items with their records.
	list := Read(t, db, func(tx store.Tx) ([]domain.ItemSummary, error) {
		l, _, err := tx.ListItems(store.ItemFilter{Sort: store.SortTitle})
		return l, err
	})
	if len(list) != 2 || list[0].ID != "known" {
		t.Errorf("list: %+v", list)
	}
}
