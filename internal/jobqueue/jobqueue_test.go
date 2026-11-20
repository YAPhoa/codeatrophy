package jobqueue_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"codeatrophy/internal/jobqueue"
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// At most Workers jobs run at once, and jobs start in the order pushed.
func TestLocalLimitsWorkersAndKeepsOrder(t *testing.T) {
	q := jobqueue.NewLocal(2)
	release := make(chan struct{})
	var mu sync.Mutex
	var started []string
	var now, peak atomic.Int32
	q.Start(context.Background(), func(ctx context.Context, id string) {
		mu.Lock()
		started = append(started, id)
		mu.Unlock()
		n := now.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		<-release
		now.Add(-1)
	})
	defer q.Stop()
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		q.Push(id)
	}
	waitFor(t, "two runs", func() bool { return now.Load() == 2 })
	time.Sleep(20 * time.Millisecond)
	if n := now.Load(); n != 2 {
		t.Fatalf("%d running with two workers", n)
	}
	close(release)
	waitFor(t, "every run", func() bool { mu.Lock(); defer mu.Unlock(); return len(started) == 5 })
	mu.Lock()
	defer mu.Unlock()
	if peak.Load() != 2 {
		t.Errorf("peak %d", peak.Load())
	}
	// The first two may start in either order; the rest follow theirs.
	if started[2] != "c" || started[3] != "d" || started[4] != "e" {
		t.Errorf("order %v", started)
	}
}

// Cancel ends a running job's context and drops a waiting one; a job that
// is waiting or running is not added twice.
func TestLocalCancel(t *testing.T) {
	q := jobqueue.NewLocal(1)
	var mu sync.Mutex
	ran := map[string]int{}
	cancelled := make(chan string, 4)
	block := make(chan struct{})
	q.Start(context.Background(), func(ctx context.Context, id string) {
		mu.Lock()
		ran[id]++
		mu.Unlock()
		if id == "long" {
			<-ctx.Done()
			cancelled <- id
			return
		}
		<-block
	})
	defer q.Stop()
	q.Push("long")
	waitFor(t, "the long job", func() bool { return q.Running() == 1 })
	q.Push("waiting")
	q.Push("waiting")
	q.Push("long")
	q.Push("other")
	q.Cancel("waiting")
	q.Cancel("unknown")
	q.Cancel("long")
	select {
	case id := <-cancelled:
		if id != "long" {
			t.Fatal(id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the running job was not cancelled")
	}
	waitFor(t, "the other job", func() bool { mu.Lock(); defer mu.Unlock(); return ran["other"] == 1 })
	close(block)
	waitFor(t, "an idle queue", func() bool { return q.Running() == 0 })
	mu.Lock()
	defer mu.Unlock()
	if ran["waiting"] != 0 || ran["long"] != 1 {
		t.Errorf("runs: %v", ran)
	}
}

// Stop cancels running jobs, waits for them, and drops waiting ones; a
// push after Stop is ignored.
func TestLocalStop(t *testing.T) {
	q := jobqueue.NewLocal(1)
	var done atomic.Bool
	var runs atomic.Int32
	q.Start(context.Background(), func(ctx context.Context, id string) {
		runs.Add(1)
		<-ctx.Done()
		time.Sleep(10 * time.Millisecond)
		done.Store(true)
	})
	q.Push("a")
	q.Push("b")
	waitFor(t, "the first run", func() bool { return runs.Load() == 1 })
	q.Stop()
	if !done.Load() {
		t.Error("Stop returned before the run did")
	}
	q.Push("c")
	q.Stop()
	if n := runs.Load(); n != 1 {
		t.Errorf("%d runs", n)
	}
}

// The parent context ends every run.
func TestLocalParentContext(t *testing.T) {
	q := jobqueue.NewLocal(3)
	ctx, cancel := context.WithCancel(context.Background())
	var ended atomic.Int32
	q.Start(ctx, func(ctx context.Context, id string) {
		<-ctx.Done()
		ended.Add(1)
	})
	defer q.Stop()
	for _, id := range []string{"a", "b", "c"} {
		q.Push(id)
	}
	waitFor(t, "three runs", func() bool { return q.Running() == 3 })
	cancel()
	waitFor(t, "every run to end", func() bool { return ended.Load() == 3 })
}
