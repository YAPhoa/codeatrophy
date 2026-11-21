package app_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
)

func (e *env) reading(t *testing.T, title string) domain.Item {
	t.Helper()
	return must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"`+title+`"}`)))
}

// linkSummary shows links as "title" for an available item and
// "title!" for an unavailable one ("?" when it has no title).
func linkSummary(links []domain.LinkedItem) string {
	var out []string
	for _, l := range links {
		title := "?"
		if l.Title != nil {
			title = *l.Title
		}
		if !l.Available {
			title += "!"
		}
		out = append(out, title)
	}
	return strings.Join(out, ",")
}

func (e *env) links(t *testing.T, id string) string {
	t.Helper()
	return linkSummary(must(e.app.ItemLinks(e.ctx, id)).Links)
}

// bundleItem decodes the item.json of an item in a bundle archive.
func bundleItem(t *testing.T, data []byte, id string) map[string]any {
	t.Helper()
	for name, b := range zipFiles(t, data) {
		if !strings.HasSuffix(name, "/item.json") {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		if m["id"] == id {
			return m
		}
	}
	t.Fatalf("no item %s in the bundle", id)
	return nil
}

// hashes lists the content hashes in a bundle's bundle.json.
func hashes(t *testing.T, data []byte) string {
	t.Helper()
	var meta struct {
		Items []struct {
			ID          string `json:"id"`
			ContentHash string `json:"contentHash"`
		} `json:"items"`
	}
	if err := json.Unmarshal(zipFiles(t, data)["bundle.json"], &meta); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprint(meta.Items)
}

func zipFiles(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = b
	}
	return out
}

// Linking goes both ways, is not a content change, and linking a pair
// again changes nothing.
func TestLinkItems(t *testing.T) {
	clock := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	e := newEnv(t, func(o *app.Options) { o.Now = func() time.Time { return clock } })
	p := e.problem(t, `,"difficulty":"easy"`)
	r := e.reading(t, "Hash maps")
	clock = clock.Add(time.Minute)
	got := must(e.app.LinkItem(e.ctx, p.ID, r.ID))
	if len(got.Links) != 1 {
		t.Fatalf("links: %+v", got)
	}
	l := got.Links[0]
	if l.ID != r.ID || !l.Available || *l.Title != "Hash maps" || *l.Type != domain.TypeReading ||
		*l.Status != domain.StatusTodo || l.Difficulty != nil || !l.LinkedAt.Equal(clock) {
		t.Errorf("linked item: %+v", l)
	}
	if back := must(e.app.ItemLinks(e.ctx, r.ID)).Links; len(back) != 1 || back[0].ID != p.ID || *back[0].Difficulty != domain.DifficultyEasy {
		t.Errorf("the other side: %+v", back)
	}
	clock = clock.Add(time.Minute)
	must(e.app.LinkItem(e.ctx, r.ID, p.ID))
	if l := must(e.app.ItemLinks(e.ctx, p.ID)).Links; len(l) != 1 || !l[0].LinkedAt.Equal(clock.Add(-time.Minute)) {
		t.Errorf("linking again: %+v", l)
	}
	for _, it := range []domain.Item{p, r} {
		after := must(e.app.GetItem(e.ctx, it.ID))
		if after.Revision != it.Revision || !after.UpdatedAt.Equal(it.UpdatedAt) || after.LinkCount != 1 {
			t.Errorf("%s after linking: revision %d -> %d, updatedAt %v -> %v, %d links", it.Title, it.Revision,
				after.Revision, it.UpdatedAt, after.UpdatedAt, after.LinkCount)
		}
	}
	if s := must(e.app.ListItems(e.ctx, app.ItemQuery{})).Items; s[0].LinkCount != 1 || s[1].LinkCount != 1 {
		t.Errorf("link counts in the list: %d %d", s[0].LinkCount, s[1].LinkCount)
	}

	// Errors.
	ae := wantCode(t, must2(e.app.LinkItem(e.ctx, p.ID, "nope")), app.CodeValidation)
	if ae.Fields["itemId"] != "item nope does not exist" {
		t.Errorf("a missing item: %v", ae.Fields)
	}
	ae = wantCode(t, must2(e.app.LinkItem(e.ctx, p.ID, p.ID)), app.CodeValidation)
	if ae.Fields["itemId"] == nil {
		t.Errorf("itself: %v", ae.Fields)
	}
	wantCode(t, must2(e.app.LinkItem(e.ctx, p.ID, "")), app.CodeValidation)
	wantCode(t, must2(e.app.LinkItem(e.ctx, "nope", p.ID)), app.CodeNotFound)
	wantCode(t, must2(e.app.ItemLinks(e.ctx, "nope")), app.CodeNotFound)

	// Several at once: all or nothing, with an error per bad id.
	a, b := e.reading(t, "A"), e.reading(t, "B")
	ae = wantCode(t, must2(e.app.LinkItems(e.ctx, p.ID, []string{a.ID, "nope", b.ID, p.ID})), app.CodeValidation)
	if ae.Fields["otherIds.1"] != "item nope does not exist" || ae.Fields["otherIds.3"] == nil || len(ae.Fields) != 2 {
		t.Errorf("per-id errors: %v", ae.Fields)
	}
	if got := e.links(t, p.ID); got != "Hash maps" {
		t.Errorf("after a failed call: %q", got)
	}
	wantCode(t, must2(e.app.LinkItems(e.ctx, p.ID, nil)), app.CodeValidation)
	if got := linkSummary(must(e.app.LinkItems(e.ctx, p.ID, []string{b.ID, r.ID, a.ID, b.ID})).Links); got != "Hash maps,B,A" {
		t.Errorf("links in link order: %q", got)
	}

	// Unlinking, from either side, twice.
	must(e.app.UnlinkItems(e.ctx, p.ID, []string{a.ID, "never-linked"}))
	if err := e.app.UnlinkItem(e.ctx, b.ID, p.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.app.UnlinkItem(e.ctx, b.ID, p.ID); err != nil {
		t.Errorf("unlinking again: %v", err)
	}
	if got := e.links(t, p.ID); got != "Hash maps" {
		t.Errorf("after unlinking: %q", got)
	}
	wantCode(t, e.app.UnlinkItem(e.ctx, "nope", p.ID), app.CodeNotFound)
	wantCode(t, must2(e.app.UnlinkItems(e.ctx, p.ID, []string{""})), app.CodeValidation)
	if after := must(e.app.GetItem(e.ctx, p.ID)); after.Revision != p.Revision || !after.UpdatedAt.Equal(p.UpdatedAt) {
		t.Errorf("after unlinking: revision %d, updatedAt %v", after.Revision, after.UpdatedAt)
	}
}

// A deleted item's links stay, listed as unavailable with its title, after
// the available ones; they can be removed, and they count towards the
// limit. A deleted item cannot be linked anew.
func TestLinksToDeletedItems(t *testing.T) {
	e := newEnv(t)
	p := e.problem(t, "")
	r, gone := e.reading(t, "Kept"), e.reading(t, "Gone")
	must(e.app.LinkItems(e.ctx, p.ID, []string{gone.ID, r.ID}))
	if err := e.app.DeleteItem(e.ctx, gone.ID); err != nil {
		t.Fatal(err)
	}
	links := must(e.app.ItemLinks(e.ctx, p.ID)).Links
	if got := linkSummary(links); got != "Kept,Gone!" {
		t.Errorf("links after deleting one: %q", got)
	}
	if d := links[1]; d.ID != gone.ID || *d.Type != domain.TypeReading || d.Status != nil || d.LinkedAt == nil {
		t.Errorf("unavailable link: %+v", d)
	}
	if n := must(e.app.GetItem(e.ctx, p.ID)).LinkCount; n != 2 {
		t.Errorf("link count: %d", n)
	}
	wantCode(t, must2(e.app.LinkItem(e.ctx, r.ID, gone.ID)), app.CodeValidation)
	if err := e.app.UnlinkItem(e.ctx, p.ID, gone.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.links(t, p.ID); got != "Kept" {
		t.Errorf("after removing the unavailable link: %q", got)
	}
}

// An item has at most domain.MaxLinksPerItem links, on either side of a
// new link.
func TestLinkLimit(t *testing.T) {
	e := newEnv(t)
	hub, other := e.reading(t, "Hub"), e.reading(t, "Other")
	var ids []string
	for i := range domain.MaxLinksPerItem {
		ids = append(ids, e.reading(t, fmt.Sprint("R", i)).ID)
	}
	must(e.app.LinkItems(e.ctx, hub.ID, ids[:domain.MaxLinksPerItem-1]))
	ae := wantCode(t, must2(e.app.LinkItems(e.ctx, hub.ID, []string{ids[domain.MaxLinksPerItem-1], other.ID})), app.CodeValidation)
	if ae.Fields["otherIds"] == nil {
		t.Errorf("over the limit: %v", ae.Fields)
	}
	// Already linked ids do not count again.
	must(e.app.LinkItems(e.ctx, hub.ID, []string{ids[0], ids[domain.MaxLinksPerItem-1]}))
	ae = wantCode(t, must2(e.app.LinkItem(e.ctx, other.ID, hub.ID)), app.CodeValidation)
	if !strings.Contains(fmt.Sprint(ae.Fields["itemId"]), "already has 50 links") {
		t.Errorf("the other side over the limit: %v", ae.Fields)
	}
	// A link to a deleted item counts.
	if err := e.app.DeleteItem(e.ctx, ids[0]); err != nil {
		t.Fatal(err)
	}
	wantCode(t, must2(e.app.LinkItem(e.ctx, hub.ID, other.ID)), app.CodeValidation)
	if err := e.app.UnlinkItem(e.ctx, hub.ID, ids[0]); err != nil {
		t.Fatal(err)
	}
	must(e.app.LinkItem(e.ctx, hub.ID, other.ID))
}

// Links are exported with each item, sorted, including links to items
// outside the bundle; an import adds them (a link to an item it does not
// have stays unavailable until that item is imported) and never removes
// local ones. They are not content: linking does not make a re-import
// "changed".
func TestBundleLinks(t *testing.T) {
	src := newEnv(t)
	p := src.problem(t, "")
	r, out, gone := src.reading(t, "In the bundle"), src.reading(t, "Not in the bundle"), src.reading(t, "Deleted")
	must(src.app.LinkItems(src.ctx, p.ID, []string{r.ID, out.ID, gone.ID}))
	if err := src.app.DeleteItem(src.ctx, gone.ID); err != nil {
		t.Fatal(err)
	}
	data := src.export(t, `{"scope":"items","itemIds":["`+p.ID+`","`+r.ID+`"]}`)
	want := []string{r.ID, out.ID, gone.ID}
	slices.Sort(want)
	if got := bundleItem(t, data, p.ID)["related"]; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("exported related ids: %v, want %v", got, want)
	}

	dst := newEnv(t)
	local := dst.reading(t, "Local")
	must(dst.app.Import(dst.ctx, data, ""))
	if got := dst.links(t, p.ID); got != "In the bundle,?!,?!" {
		t.Errorf("links after the import: %q", got)
	}
	if got := dst.links(t, r.ID); got != "A plus B" {
		t.Errorf("links of the other bundle item: %q", got)
	}
	// A local link is kept by a re-import, which finds the items unchanged.
	must(dst.app.LinkItem(dst.ctx, p.ID, local.ID))
	pre := must(dst.app.PreviewImport(dst.ctx, data))
	if pre.Counts.Unchanged != 2 {
		t.Errorf("re-import after linking: %+v", pre.Counts)
	}
	must(dst.app.Import(dst.ctx, data, "overwrite"))
	if got := dst.links(t, p.ID); got != "In the bundle,Local,?!,?!" {
		t.Errorf("links after a re-import: %q", got)
	}
	// Importing the item outside the first bundle brings its link to life.
	must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"items","itemIds":["`+out.ID+`"]}`), ""))
	// (The links an import adds are made in the order of the bundle's
	// sorted ids.)
	links := strings.Split(dst.links(t, p.ID), ",")
	if len(links) != 4 || links[2] != "Local" || links[3] != "?!" || !slices.Contains(links, "Not in the bundle") {
		t.Errorf("links after importing the missing item: %q", links)
	}

	// Linking in the source changes no hash: the bundle is unchanged.
	if err := src.app.UnlinkItem(src.ctx, p.ID, r.ID); err != nil {
		t.Fatal(err)
	}
	again := src.export(t, `{"scope":"items","itemIds":["`+p.ID+`","`+r.ID+`"]}`)
	if pre := must(dst.app.PreviewImport(dst.ctx, again)); pre.Counts.Unchanged != 2 {
		t.Errorf("a bundle that differs only in links: %+v", pre.Counts)
	}
	if hashes(t, data) != hashes(t, again) {
		t.Error("the content hashes depend on links")
	}
}

// Under the duplicate strategy, a link to an item duplicated by the same
// import points at the copy.
func TestBundleLinksToDuplicates(t *testing.T) {
	src := newEnv(t)
	p := src.problem(t, "")
	r := src.reading(t, "Theory")
	must(src.app.LinkItem(src.ctx, p.ID, r.ID))
	dst := newEnv(t)
	must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"all"}`), ""))
	if err := dst.app.UnlinkItem(dst.ctx, p.ID, r.ID); err != nil {
		t.Fatal(err)
	}
	// Both change in the source, so both are duplicated.
	must(src.app.UpdateItem(src.ctx, p.ID, input(t, `{"title":"A plus B, again"}`)))
	must(src.app.UpdateItem(src.ctx, r.ID, input(t, `{"title":"Theory, again"}`)))
	res := must(dst.app.Import(dst.ctx, src.export(t, `{"scope":"all"}`), "duplicate"))
	if res.Duplicated != 2 {
		t.Fatalf("import: %+v", res)
	}
	if got := dst.links(t, p.ID); got != "" {
		t.Errorf("the original is not linked: %q", got)
	}
	copies := must(dst.app.ListItems(dst.ctx, app.ItemQuery{Q: "again"})).Items
	if len(copies) != 2 {
		t.Fatalf("copies: %+v", copies)
	}
	for _, c := range copies {
		want := "Theory, again"
		if c.Title == want {
			want = "A plus B, again"
		}
		if got := dst.links(t, c.ID); got != want {
			t.Errorf("links of the copy %q: %q, want %q", c.Title, got, want)
		}
	}
}
