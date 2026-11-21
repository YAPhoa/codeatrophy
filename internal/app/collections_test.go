package app_test

import (
	"strings"
	"testing"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

func names(e *env, t *testing.T, parent *string) string {
	t.Helper()
	all := must(e.app.ListCollections(e.ctx))
	var out []string
	for _, c := range all.Items {
		if (c.ParentID == nil && parent == nil) || (c.ParentID != nil && parent != nil && *c.ParentID == *parent) {
			out = append(out, c.Name)
		}
	}
	return strings.Join(out, ",")
}

func TestCollectionTree(t *testing.T) {
	e := newEnv(t)
	mk := func(js string) domain.Collection {
		return must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, js)))
	}
	a := mk(`{"name":"A"}`)
	b := mk(`{"name":"B"}`)
	c := mk(`{"name":"C"}`)
	if names(e, t, nil) != "A,B,C" || c.Position != 2 {
		t.Fatalf("roots: %s", names(e, t, nil))
	}
	a1 := mk(`{"name":"A1","parentId":"` + a.ID + `"}`)
	a2 := mk(`{"name":"A2","parentId":"` + a.ID + `"}`)
	_, err := e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"X","parentId":"nope"}`))
	wantCode(t, err, app.CodeValidation)
	_, err = e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"  "}`))
	wantCode(t, err, app.CodeValidation)

	update := func(id, js string) (domain.Collection, error) {
		return e.app.UpdateCollection(e.ctx, id, decodeInto[domain.CollectionInput](t, js))
	}
	// Reorder among siblings.
	must(update(c.ID, `{"position":0}`))
	if names(e, t, nil) != "C,A,B" {
		t.Errorf("after reorder: %s", names(e, t, nil))
	}
	// Moving under itself or a descendant is a conflict.
	_, err = update(a.ID, `{"parentId":"`+a1.ID+`"}`)
	wantCode(t, err, app.CodeConflict)
	_, err = update(a.ID, `{"parentId":"`+a.ID+`"}`)
	wantCode(t, err, app.CodeConflict)
	// Move B under A at index 1.
	moved := must(update(b.ID, `{"parentId":"`+a.ID+`","position":1}`))
	if moved.Position != 1 || names(e, t, &a.ID) != "A1,B,A2" || names(e, t, nil) != "C,A" {
		t.Errorf("after move: roots %s, A: %s", names(e, t, nil), names(e, t, &a.ID))
	}
	// Back to the top level, appended.
	must(update(b.ID, `{"parentId":null}`))
	if names(e, t, nil) != "C,A,B" || names(e, t, &a.ID) != "A1,A2" {
		t.Errorf("after move back: %s / %s", names(e, t, nil), names(e, t, &a.ID))
	}
	// Deleting A moves its children up into its place; items are kept.
	it := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R","collectionIds":["`+a.ID+`","`+a2.ID+`"]}`)))
	if err := e.app.DeleteCollection(e.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if names(e, t, nil) != "C,A1,A2,B" {
		t.Errorf("after delete: %s", names(e, t, nil))
	}
	got := must(e.app.GetItem(e.ctx, it.ID))
	if len(got.CollectionIDs) != 1 || got.CollectionIDs[0] != a2.ID {
		t.Errorf("membership after delete: %v", got.CollectionIDs)
	}
	wantCode(t, e.app.DeleteCollection(e.ctx, a.ID), app.CodeNotFound)
	if cnt := must(e.app.GetCollection(e.ctx, a2.ID)).ItemCount; cnt != 1 {
		t.Errorf("itemCount = %d", cnt)
	}
}

func TestCollectionMembership(t *testing.T) {
	e := newEnv(t)
	col := must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"Plan"}`)))
	var ids []string
	for _, title := range []string{"one", "two", "three"} {
		ids = append(ids, must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"`+title+`"}`))).ID)
	}
	got := must(e.app.SetCollectionItems(e.ctx, col.ID, []string{ids[2], ids[0]}))
	if strings.Join(got.ItemIDs, ",") != ids[2]+","+ids[0] {
		t.Errorf("set: %v", got.ItemIDs)
	}
	got = must(e.app.AddCollectionItems(e.ctx, col.ID, []string{ids[0], ids[1]}))
	if strings.Join(got.ItemIDs, ",") != ids[2]+","+ids[0]+","+ids[1] {
		t.Errorf("append keeps existing members in place: %v", got.ItemIDs)
	}
	_, err := e.app.SetCollectionItems(e.ctx, col.ID, []string{ids[0], ids[0]})
	wantCode(t, err, app.CodeValidation)
	// The list is required: nil never clears the collection.
	_, err = e.app.SetCollectionItems(e.ctx, col.ID, nil)
	wantField(t, err, "itemIds")
	_, err = e.app.AddCollectionItems(e.ctx, col.ID, nil)
	wantField(t, err, "itemIds")
	if got := must(e.app.CollectionItemIDs(e.ctx, col.ID)); len(got.ItemIDs) != 3 {
		t.Errorf("nil changed the membership: %v", got.ItemIDs)
	}
	if got := must(e.app.AddCollectionItems(e.ctx, col.ID, []string{})); len(got.ItemIDs) != 3 {
		t.Errorf("adding none: %v", got.ItemIDs)
	}
	_, err = e.app.AddCollectionItems(e.ctx, col.ID, []string{"missing"})
	wantCode(t, err, app.CodeValidation)
	if err := e.app.RemoveCollectionItem(e.ctx, col.ID, ids[2]); err != nil {
		t.Fatal(err)
	}
	page := must(e.app.ListItems(e.ctx, app.ItemQuery{CollectionID: col.ID, Sort: "position"}))
	if page.Total != 2 || page.Items[0].ID != ids[0] || page.Items[1].ID != ids[1] {
		t.Errorf("position listing: %+v", page.Items)
	}
	uncollected := must(e.app.ListItems(e.ctx, app.ItemQuery{Uncollected: true}))
	if uncollected.Total != 1 || uncollected.Items[0].ID != ids[2] {
		t.Errorf("uncollected: %+v", uncollected.Items)
	}
	// PATCH collectionIds replaces memberships.
	it := must(e.app.UpdateItem(e.ctx, ids[1], input(t, `{"collectionIds":[]}`)))
	if len(it.CollectionIDs) != 0 || it.Revision != 1 {
		t.Errorf("collectionIds patch: %+v", it.ItemSummary)
	}
}

func TestUpdateCollectionFields(t *testing.T) {
	e := newEnv(t)
	c := must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"Plan","description":"d"}`)))
	update := func(js string) (domain.Collection, error) {
		return e.app.UpdateCollection(e.ctx, c.ID, decodeInto[domain.CollectionInput](t, js))
	}
	if got := must(update(`{"name":"  Study plan  "}`)); got.Name != "Study plan" || got.Description != "d" || got.ParentID != nil {
		t.Errorf("rename: %+v", got)
	}
	if got := must(update(`{"description":null}`)); got.Description != "" || got.Name != "Study plan" {
		t.Errorf("description cleared: %+v", got)
	}
	for _, bad := range []struct{ js, field string }{
		{`{"position":-1}`, "position"},
		{`{"position":null}`, "position"},
		{`{"parentId":"nope"}`, "parentId"},
		{`{"name":null}`, "name"},
		{`{"name":"  "}`, "name"},
	} {
		_, err := update(bad.js)
		wantField(t, err, bad.field)
	}
	if got := must(e.app.GetCollection(e.ctx, c.ID)); got.Name != "Study plan" || got.ParentID != nil || got.Position != 0 {
		t.Errorf("a rejected update was written: %+v", got)
	}
	_, err := e.app.UpdateCollection(e.ctx, "nope", decodeInto[domain.CollectionInput](t, `{"name":"x"}`))
	wantCode(t, err, app.CodeNotFound)
}

// Removing from a collection in bulk leaves the items' other collections
// alone and counts every existing item, member or not.
func TestBulkRemoveFromCollection(t *testing.T) {
	e := newEnv(t)
	col := func(name string) domain.Collection {
		return must(e.app.CreateCollection(e.ctx, decodeInto[domain.CollectionInput](t, `{"name":"`+name+`"}`)))
	}
	one, two := col("One"), col("Two")
	var ids []string
	for _, title := range []string{"a", "b", "c"} {
		ids = append(ids, must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"`+title+`"}`))).ID)
	}
	must(e.app.AddCollectionItems(e.ctx, one.ID, ids[:2]))
	must(e.app.AddCollectionItems(e.ctx, two.ID, ids[:2]))
	members := func(c domain.Collection) string {
		var out []string
		for _, it := range must(e.app.ListItems(e.ctx, app.ItemQuery{CollectionID: c.ID, Sort: "position"})).Items {
			out = append(out, it.Title)
		}
		return strings.Join(out, ",")
	}
	r := must(e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t,
		`{"ids":["`+ids[0]+`","`+ids[2]+`","unknown"],"action":"removeFromCollection","collectionId":"`+one.ID+`"}`)))
	if r.Affected != 2 {
		t.Errorf("affected %d", r.Affected)
	}
	if got := members(one); got != "b" {
		t.Errorf("left in the collection: %s", got)
	}
	if got := members(two); got != "a,b" {
		t.Errorf("the other collection: %s", got)
	}
	if got := must(e.app.GetItem(e.ctx, ids[0])); len(got.CollectionIDs) != 1 || got.CollectionIDs[0] != two.ID {
		t.Errorf("memberships of a: %v", got.CollectionIDs)
	}
	_, err := e.app.BulkItems(e.ctx, decodeInto[app.BulkInput](t,
		`{"ids":["`+ids[1]+`"],"action":"removeFromCollection","collectionId":"nope"}`))
	wantCode(t, err, app.CodeNotFound)
}
