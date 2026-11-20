// Package jobqueue schedules background jobs whose state is kept elsewhere.
//
// The application stores a job (in the database) before it pushes the job's
// id; the queue only decides when it runs and lets it be cancelled. That
// split keeps the interface small enough for other implementations, such as
// one shared by several servers, to be added without touching callers.
package jobqueue

import (
	"context"
	"slices"
	"sync"
)

// Run executes one job. Its context ends when the job is cancelled or the
// queue stops.
type Run func(ctx context.Context, id string)

// Queue runs pushed jobs with a bounded number of workers.
type Queue interface {
	// Start runs pushed jobs with run, each with a context derived from
	// ctx, until Stop.
	Start(ctx context.Context, run Run)
	// Push adds a job. It never blocks. A job that is already waiting or
	// running is not added again. Callers check the job's stored state when
	// its run starts, since it may have been cancelled meanwhile.
	Push(id string)
	// Cancel drops the job if it is waiting, and ends the context of its
	// run if it is running. Unknown ids are ignored.
	Cancel(id string)
	// Stop cancels the running jobs, waits for their runs to return, and
	// drops the waiting ones.
	Stop()
}

// Local is the in-process queue: a first-in, first-out list and a fixed
// pool of worker goroutines. It guarantees that at most Workers jobs run at
// once and that jobs start in the order they were pushed. Nothing it holds
// survives the process: a caller that wants waiting jobs to run after a
// restart pushes them again at start. Cancel reaches only runs of this
// process.
type Local struct {
	workers int

	mu      sync.Mutex
	cond    *sync.Cond
	waiting []string
	running map[string]context.CancelFunc
	started bool
	stopped bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewLocal returns an in-process queue with that many workers (at least 1).
func NewLocal(workers int) *Local {
	q := &Local{workers: max(workers, 1), running: map[string]context.CancelFunc{}}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// Start implements Queue.
func (q *Local) Start(ctx context.Context, run Run) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.started || q.stopped {
		return
	}
	q.started = true
	ctx, q.cancel = context.WithCancel(ctx)
	for range q.workers {
		q.wg.Add(1)
		go q.work(ctx, run)
	}
}

func (q *Local) work(ctx context.Context, run Run) {
	defer q.wg.Done()
	for {
		q.mu.Lock()
		for len(q.waiting) == 0 && !q.stopped {
			q.cond.Wait()
		}
		if q.stopped {
			q.mu.Unlock()
			return
		}
		id := q.waiting[0]
		q.waiting = q.waiting[1:]
		jctx, cancel := context.WithCancel(ctx)
		q.running[id] = cancel
		q.mu.Unlock()

		run(jctx, id)
		cancel()

		q.mu.Lock()
		delete(q.running, id)
		q.mu.Unlock()
	}
}

// Push implements Queue.
func (q *Local) Push(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.stopped || q.running[id] != nil || slices.Contains(q.waiting, id) {
		return
	}
	q.waiting = append(q.waiting, id)
	q.cond.Signal()
}

// Cancel implements Queue.
func (q *Local) Cancel(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	kept := q.waiting[:0]
	for _, w := range q.waiting {
		if w != id {
			kept = append(kept, w)
		}
	}
	q.waiting = kept
	if cancel, ok := q.running[id]; ok {
		cancel()
	}
}

// Stop implements Queue.
func (q *Local) Stop() {
	q.mu.Lock()
	if q.stopped {
		q.mu.Unlock()
		return
	}
	q.stopped = true
	q.waiting = nil
	if q.cancel != nil {
		q.cancel()
	}
	q.cond.Broadcast()
	q.mu.Unlock()
	q.wg.Wait()
}

// Running reports how many jobs are running now.
func (q *Local) Running() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.running)
}
