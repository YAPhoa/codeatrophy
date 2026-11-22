package storetest

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

func workingCopies(t *testing.T, db store.Store, itemID string) []domain.WorkingCopy {
	t.Helper()
	return Read(t, db, func(tx store.Tx) ([]domain.WorkingCopy, error) { return tx.ListWorkingCopies("", itemID) })
}

func putWorkingCopy(db store.Store, w domain.WorkingCopy) error {
	return db.Write(context.Background(), func(tx store.Tx) error { return tx.PutWorkingCopy(&w) })
}

// workingCopyRows counts every row of working_copies, whatever its item,
// when the store can say.
func workingCopyRows(t *testing.T, db store.Store) (int64, bool) {
	t.Helper()
	b, ok := db.(store.Bulk)
	if !ok {
		return 0, false
	}
	tb, _ := store.TableByName("working_copies")
	var n int64
	if err := b.Export(context.Background(), func(d store.Dump) error {
		var err error
		n, err = d.Count(tb)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return n, true
}

// A problem keeps one working copy per language, listed by when it was
// last written (also within one second), replaced whole by each write and
// written only for a problem that exists; it leaves the item alone and
// goes with it.
func testWorkingCopies(t *testing.T, db store.Store) {
	p, r := Item("p", "P", domain.TypeProblem), Item("r", "R", domain.TypeReading)
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertItem(&p); err != nil {
			return err
		}
		return tx.InsertItem(&r)
	})
	if ws := workingCopies(t, db, "p"); ws == nil || len(ws) != 0 {
		t.Fatalf("a new problem has working copies %#v", ws)
	}
	at := now.Add(time.Hour)
	text := "def f():\n\treturn 1\x00 é"
	for _, w := range []domain.WorkingCopy{
		{ItemID: "p", Language: "python", Source: "first", UpdatedAt: now},
		{ItemID: "p", Language: "cpp", Source: "", UpdatedAt: at},
		{ItemID: "p", Language: "python", Source: text, UpdatedAt: at},
	} {
		if err := putWorkingCopy(db, w); err != nil {
			t.Fatal(err)
		}
	}
	got := workingCopies(t, db, "p")
	want := []domain.WorkingCopy{{ItemID: "p", Language: "python", Source: text, UpdatedAt: at},
		{ItemID: "p", Language: "cpp", Source: "", UpdatedAt: at}}
	if !slices.Equal(got, want) {
		t.Errorf("working copies\n  %+v\nwant\n  %+v", got, want)
	}
	// Writing cpp again within the same second puts it first.
	if err := putWorkingCopy(db, domain.WorkingCopy{ItemID: "p", Language: "cpp", Source: "int main(){}", UpdatedAt: at}); err != nil {
		t.Fatal(err)
	}
	if got := workingCopies(t, db, "p"); len(got) != 2 || got[0].Language != "cpp" || got[0].Source != "int main(){}" ||
		got[1].Language != "python" {
		t.Errorf("after writing cpp again: %+v", got)
	}

	for _, w := range []domain.WorkingCopy{
		{ItemID: "r", Language: "python", Source: "x", UpdatedAt: now},
		{ItemID: "missing", Language: "python", Source: "x", UpdatedAt: now},
	} {
		if err := putWorkingCopy(db, w); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("a working copy of %s: %v, want ErrNotFound", w.ItemID, err)
		}
	}
	if ws := workingCopies(t, db, "r"); len(ws) != 0 {
		t.Errorf("a reading has working copies %+v", ws)
	}

	// The item is not changed.
	if it := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("p") }); it.Revision != p.Revision ||
		!it.UpdatedAt.Equal(p.UpdatedAt) {
		t.Errorf("writing working copies changed the item: revision %d, updated %v", it.Revision, it.UpdatedAt)
	}

	Write(t, db, func(tx store.Tx) error {
		if ok, err := tx.DeleteWorkingCopy("", "p", "python"); err != nil || !ok {
			return fmt.Errorf("deleting python: %v %v", ok, err)
		}
		if ok, err := tx.DeleteWorkingCopy("", "p", "python"); err != nil || ok {
			return fmt.Errorf("deleting python again: %v %v", ok, err)
		}
		if ok, err := tx.DeleteWorkingCopy("", "missing", "python"); err != nil || ok {
			return fmt.Errorf("deleting one of a missing item: %v %v", ok, err)
		}
		return nil
	})
	if got := workingCopies(t, db, "p"); len(got) != 1 || got[0].Language != "cpp" {
		t.Errorf("after deleting python: %+v", got)
	}

	// Deleting the item deletes its working copies; creating it again
	// brings none back.
	Write(t, db, func(tx store.Tx) error { _, err := tx.DeleteItem("p", now); return err })
	if n, ok := workingCopyRows(t, db); ok && n != 0 {
		t.Errorf("%d working copies remain after deleting their item", n)
	}
	Write(t, db, func(tx store.Tx) error { return tx.InsertItem(&p) })
	if ws := workingCopies(t, db, "p"); len(ws) != 0 {
		t.Errorf("the item created again has working copies %+v", ws)
	}
}

// Concurrent writes of one working copy (two tabs, two devices) each
// succeed, and leave exactly one row holding the whole of the write that
// committed last.
func testWorkingCopyConcurrentPuts(t *testing.T, db store.Store) {
	p := Item("p", "P", domain.TypeProblem)
	Write(t, db, func(tx store.Tx) error { return tx.InsertItem(&p) })
	const n = 40
	sources := make([]string, n)
	for i := range n {
		// Large enough that a torn write would show.
		sources[i] = strings.Repeat(string(rune('a'+i%26)), 20000) + fmt.Sprint(i)
	}
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		order []int
		errs  = make(chan error, n)
	)
	for i := range n {
		wg.Go(func() {
			errs <- db.Write(context.Background(), func(tx store.Tx) error {
				if err := tx.PutWorkingCopy(&domain.WorkingCopy{ItemID: "p", Language: "python", Source: sources[i],
					UpdatedAt: now}); err != nil {
					return err
				}
				// Writers are serialised, so the order the writes reach
				// this point is the order they commit in.
				mu.Lock()
				order = append(order, i)
				mu.Unlock()
				return nil
			})
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("a concurrent write failed: %v", err)
		}
	}
	ws := workingCopies(t, db, "p")
	if len(ws) != 1 {
		t.Fatalf("%d working copies after concurrent writes of one", len(ws))
	}
	if n, ok := workingCopyRows(t, db); ok && n != 1 {
		t.Errorf("%d rows after concurrent writes of one working copy", n)
	}
	if len(order) != n {
		t.Fatalf("%d writes recorded", len(order))
	}
	if last := order[len(order)-1]; ws[0].Source != sources[last] {
		i := slices.Index(sources, ws[0].Source)
		t.Errorf("the working copy holds write %d (of %d bytes), want the last one, %d", i, len(ws[0].Source), last)
	}
}

// Writes of working copies racing with the deletion of their item each
// either succeed or find no item, and leave no row behind.
func testWorkingCopyPutsRaceDeletion(t *testing.T, db store.Store) {
	p := Item("p", "P", domain.TypeProblem)
	Write(t, db, func(tx store.Tx) error { return tx.InsertItem(&p) })
	const writers, before, limit = 8, 3, 500
	var (
		wg        sync.WaitGroup
		mu        sync.Mutex
		ok        int
		notFound  int
		failures  []error
		deleteNow = make(chan struct{})
		once      sync.Once
	)
	for w := range writers {
		wg.Go(func() {
			lang := []string{"python", "cpp", "go", "java"}[w%4]
			for i := range limit {
				err := putWorkingCopy(db, domain.WorkingCopy{ItemID: "p", Language: lang, Source: fmt.Sprint(w, ":", i),
					UpdatedAt: now})
				mu.Lock()
				switch {
				case err == nil:
					ok++
					if ok >= writers*before {
						once.Do(func() { close(deleteNow) })
					}
				case errors.Is(err, store.ErrNotFound):
					notFound++
				default:
					failures = append(failures, err)
				}
				mu.Unlock()
				if err != nil {
					return
				}
			}
		})
	}
	var (
		deleted bool
		delErr  error
		done    = make(chan struct{})
	)
	go func() {
		defer close(done)
		<-deleteNow
		delErr = db.Write(context.Background(), func(tx store.Tx) error {
			var err error
			deleted, err = tx.DeleteItem("p", now)
			return err
		})
	}()
	wg.Wait()
	once.Do(func() { close(deleteNow) }) // should the writers have stopped early
	<-done
	if delErr != nil {
		t.Errorf("deleting the item: %v", delErr)
	}
	for _, err := range failures {
		t.Errorf("a write failed: %v", err)
	}
	if !deleted || notFound != writers {
		t.Errorf("deleted %v; %d writes succeeded, %d found no item, want %d", deleted, ok, notFound, writers)
	}
	if ws := workingCopies(t, db, "p"); len(ws) != 0 {
		t.Errorf("the deleted item has working copies %+v", ws)
	}
	if n, ok := workingCopyRows(t, db); ok && n != 0 {
		t.Errorf("%d working copies remain after deleting their item", n)
	}
}
