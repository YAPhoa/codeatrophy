package storetest

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Personal data belongs to an account: an item's status, favorite, notes
// and last verdict are read, filtered and written for the account in the
// context, and the other personal records for the account they carry.
// Deleting an account removes its data, and the first account takes over
// what was kept for none.
func testPersonalData(t *testing.T, db store.Store) {
	ctx := context.Background()
	as := func(account string) context.Context { return store.WithAccount(ctx, account) }
	write := func(account string, fn func(store.Tx) error) {
		t.Helper()
		if err := db.Write(as(account), fn); err != nil {
			t.Fatal(err)
		}
	}
	read := func(account string, fn func(store.Tx) error) {
		t.Helper()
		if err := db.Read(as(account), fn); err != nil {
			t.Fatal(err)
		}
	}
	Write(t, db, func(tx store.Tx) error {
		for _, id := range []string{"u1", "u2"} {
			u := store.User{ID: id, Email: id + "@example.com", PasswordHash: "h", CreatedAt: now, UpdatedAt: now}
			if err := tx.InsertUser(&u); err != nil {
				return err
			}
		}
		for _, it := range []domain.Item{Item("p", "P", domain.TypeProblem), Item("q", "Q", domain.TypeProblem)} {
			if err := tx.InsertItem(&it); err != nil {
				return err
			}
		}
		return nil
	})
	write("u1", func(tx store.Tx) error {
		it, err := tx.GetItem("p")
		if err != nil {
			return err
		}
		it.Status, it.Favorite, it.Notes = domain.StatusDone, true, "mine"
		it.Title = "P2" // content is shared
		return tx.UpdateItem(&it)
	})
	state := func(account string) string {
		var out string
		read(account, func(tx store.Tx) error {
			it, err := tx.GetItem("p")
			if err != nil {
				return err
			}
			fav := true
			list, n, err := tx.ListItems(store.ItemFilter{Favorite: &fav})
			if err != nil {
				return err
			}
			done, _, err := tx.ListItems(store.ItemFilter{Statuses: []domain.ItemStatus{domain.StatusDone}})
			if err != nil {
				return err
			}
			by, err := tx.CountItemsBy(store.ItemFilter{}, store.GroupStatus)
			if err != nil {
				return err
			}
			st, err := tx.Stats()
			if err != nil {
				return err
			}
			out = fmt.Sprintf("%s %s %v %q favorites=%d/%d done=%d by=%v stats=%d/%v", it.Title, it.Status, it.Favorite,
				it.Notes, len(list), n, len(done), by, st.Items.Favorites, st.Items.ByStatus)
			return nil
		})
		return out
	}
	if got, want := state("u1"), `P2 done true "mine" favorites=1/1 done=1 by=map[done:1 todo:1] stats=1/map[done:1 in_progress:0 todo:1]`; got != want {
		t.Errorf("u1: %s\nwant %s", got, want)
	}
	if got, want := state("u2"), `P2 todo false "" favorites=0/0 done=0 by=map[todo:2] stats=0/map[done:0 in_progress:0 todo:2]`; got != want {
		t.Errorf("u2: %s\nwant %s", got, want)
	}
	// Back to the default, the account keeps no row.
	write("u1", func(tx store.Tx) error {
		it, err := tx.GetItem("p")
		if err != nil {
			return err
		}
		it.Status, it.Favorite, it.Notes = domain.StatusTodo, false, ""
		return tx.UpdateItem(&it)
	})
	if n := countRows(t, db, "item_states"); n != 0 {
		t.Errorf("%d item_states rows for default states", n)
	}

	// Working copies, submissions and their verdicts.
	v := domain.VerdictAccepted
	for _, account := range []string{"u1", "u2"} {
		write(account, func(tx store.Tx) error {
			if err := tx.PutWorkingCopy(&domain.WorkingCopy{UserID: account, ItemID: "p", Language: "python",
				Source: account, UpdatedAt: now}); err != nil {
				return err
			}
			s := domain.Submission{ID: "s-" + account, UserID: account, ItemID: "p", Mode: domain.ModeSubmit,
				Language: "python", Source: account, Status: domain.SubmissionCompleted, CreatedAt: now}
			if account == "u1" {
				s.Verdict = &v
			}
			return tx.InsertSubmission(&s)
		})
	}
	read("u2", func(tx store.Tx) error {
		ws, err := tx.ListWorkingCopies("u2", "p")
		if err != nil || len(ws) != 1 || ws[0].Source != "u2" || ws[0].UserID != "u2" {
			t.Errorf("u2's working copies: %+v %v", ws, err)
		}
		subs, n, err := tx.ListSubmissions("u2", "p", "", 0, 0)
		if err != nil || n != 1 || subs[0].ID != "s-u2" {
			t.Errorf("u2's submissions: %+v %d %v", subs, n, err)
		}
		if s, err := tx.GetSubmission("s-u1"); err != nil || s.UserID != "u1" {
			t.Errorf("another account's submission by id: %+v %v", s, err)
		}
		it, err := tx.GetItem("p")
		if err != nil || it.LastVerdict != nil {
			t.Errorf("u2's last verdict: %v %v", it.LastVerdict, err)
		}
		return nil
	})
	read("u1", func(tx store.Tx) error {
		it, err := tx.GetItem("p")
		if err != nil || it.LastVerdict == nil || *it.LastVerdict != v {
			t.Errorf("u1's last verdict: %v %v", it.LastVerdict, err)
		}
		return nil
	})
	if ok, err := deleteWorkingCopy(db, "u2", "p", "python"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	read("u1", func(tx store.Tx) error {
		if ws, _ := tx.ListWorkingCopies("u1", "p"); len(ws) != 1 {
			t.Errorf("u2's delete removed u1's working copy: %+v", ws)
		}
		return nil
	})

	// Collections: each account sees its own, and an item's memberships,
	// the collection filters and the stats count its own collections only.
	for _, account := range []string{"u1", "u2"} {
		write(account, func(tx store.Tx) error {
			c := domain.Collection{ID: "c-" + account, Name: account, CreatedAt: now, UpdatedAt: now}
			if err := tx.InsertCollection(&c); err != nil {
				return err
			}
			item := "p"
			if account == "u2" {
				item = "q"
			}
			return tx.SetItemCollections(item, []string{c.ID})
		})
	}
	collections := func(account string) string {
		var out string
		read(account, func(tx store.Tx) error {
			cs, err := tx.ListCollections()
			if err != nil {
				return err
			}
			p, err := tx.GetItem("p")
			if err != nil {
				return err
			}
			_, inOwn, err := tx.ListItems(store.ItemFilter{CollectionID: "c-" + account})
			if err != nil {
				return err
			}
			_, inOther, err := tx.ListItems(store.ItemFilter{CollectionID: "c-u1", Recursive: true})
			if err != nil {
				return err
			}
			_, uncollected, err := tx.ListItems(store.ItemFilter{Uncollected: true})
			if err != nil {
				return err
			}
			st, err := tx.Stats()
			if err != nil {
				return err
			}
			_, getErr := tx.GetCollection("c-u1")
			taken, err := tx.CollectionIDTaken("c-u1")
			if err != nil {
				return err
			}
			names := []string{}
			for _, c := range cs {
				names = append(names, c.Name)
			}
			out = fmt.Sprintf("%v p=%v own=%d c-u1=%d uncollected=%d stats=%d/%d get=%v taken=%v", names, p.CollectionIDs,
				inOwn, inOther, uncollected, st.Collections, st.Items.Uncollected, getErr, taken)
			return nil
		})
		return out
	}
	if got, want := collections("u1"), `[u1] p=[c-u1] own=1 c-u1=1 uncollected=1 stats=1/1 get=<nil> taken=true`; got != want {
		t.Errorf("u1's collections: %s\nwant %s", got, want)
	}
	if got, want := collections("u2"), `[u2] p=[] own=1 c-u1=0 uncollected=1 stats=1/1 get=not found taken=true`; got != want {
		t.Errorf("u2's collections: %s\nwant %s", got, want)
	}
	if err := db.Write(as("u2"), func(tx store.Tx) error { return tx.DeleteCollection("c-u1") }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("u2 deleting u1's collection: %v", err)
	}

	// Deleting an account removes its personal data, and only its.
	write("u1", func(tx store.Tx) error {
		it, err := tx.GetItem("q")
		if err != nil {
			return err
		}
		it.Favorite = true
		if err := tx.UpdateItem(&it); err != nil {
			return err
		}
		return tx.SetSetting(store.PreferencesKey("u1"), "{}")
	})
	Write(t, db, func(tx store.Tx) error {
		ok, err := tx.DeleteUser("u1")
		if err == nil && !ok {
			err = fmt.Errorf("u1 not deleted")
		}
		return err
	})
	for _, table := range store.PersonalTables {
		if n := countWhere(t, db, table, "u1"); n != 0 {
			t.Errorf("%s keeps %d rows of a deleted account", table, n)
		}
	}
	if n := countWhere(t, db, "submissions", "u2"); n != 1 {
		t.Errorf("u2 has %d submissions after u1 was deleted", n)
	}
	if _, ok, _ := getSetting(db, store.PreferencesKey("u1")); ok {
		t.Error("a deleted account's preferences are kept")
	}

	// The first account takes over what was kept for none.
	write(store.Unowned, func(tx store.Tx) error {
		it, err := tx.GetItem("q")
		if err != nil {
			return err
		}
		it.Status = domain.StatusInProgress
		if err := tx.UpdateItem(&it); err != nil {
			return err
		}
		return tx.SetSetting(store.PreferencesKey(store.Unowned), `{"a":1}`)
	})
	Write(t, db, func(tx store.Tx) error { return tx.ClaimUnowned("u3") })
	read("u3", func(tx store.Tx) error {
		if it, err := tx.GetItem("q"); err != nil || it.Status != domain.StatusInProgress {
			t.Errorf("claimed state: %s %v", it.Status, err)
		}
		return nil
	})
	if v, ok, _ := getSetting(db, store.PreferencesKey("u3")); !ok || v != `{"a":1}` {
		t.Errorf("claimed preferences: %q %v", v, ok)
	}
	if n := countWhere(t, db, "item_states", store.Unowned); n != 0 {
		t.Errorf("%d unowned item_states rows after the claim", n)
	}
}

func countRows(t *testing.T, db store.Store, table string) int {
	t.Helper()
	var n int
	if err := db.(store.Bulk).Export(context.Background(), func(d store.Dump) (err error) {
		tb, _ := store.TableByName(table)
		c, err := d.Count(tb)
		n = int(c)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return n
}

// countWhere counts a personal table's rows of an account.
func countWhere(t *testing.T, db store.Store, table, account string) int {
	t.Helper()
	tb, _ := store.TableByName(table)
	col := -1
	for i, c := range tb.Columns {
		if c == "user_id" {
			col = i
		}
	}
	n := 0
	if err := db.(store.Bulk).Export(context.Background(), func(d store.Dump) error {
		return d.Rows(tb, func(vals []any) error {
			if vals[col] == account {
				n++
			}
			return nil
		})
	}); err != nil {
		t.Fatal(err)
	}
	return n
}

func getSetting(db store.Store, key string) (v string, ok bool, err error) {
	err = db.Read(context.Background(), func(tx store.Tx) error {
		v, ok, err = tx.GetSetting(key)
		return err
	})
	return v, ok, err
}

func deleteWorkingCopy(db store.Store, account, itemID, language string) (ok bool, err error) {
	err = db.Write(store.WithAccount(context.Background(), account), func(tx store.Tx) error {
		ok, err = tx.DeleteWorkingCopy(account, itemID, language)
		return err
	})
	return ok, err
}
