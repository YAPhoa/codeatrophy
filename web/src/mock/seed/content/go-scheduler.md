## G, M, P

The Go runtime multiplexes goroutines onto OS threads with three kinds of object:

- **G** — a goroutine: a stack (starting at 2 KiB), an instruction pointer and some state.
- **M** — a machine: an OS thread.
- **P** — a processor: a scheduling context, holding a local run queue of runnable Gs. There are exactly `GOMAXPROCS` of them.

An M must hold a P to run Go code. That is the whole trick: the number of Ps bounds parallelism, while the number of Ms can grow when threads block in system calls.

```text
   P0            P1            P2
 [g g g]       [g g]          [ ]        <- local run queues (max 256 each)
    |             |             |
    M0            M3            M5       <- threads currently running Go code

 global run queue: [g g g g]             M1, M2, M4: blocked in syscalls or parked
```

## Where a goroutine goes

`go f()` creates a G and puts it on the **current P's local queue** — no lock needed, since only this P pushes to it. If the local queue is full, half of it is moved to the global queue.

When a P needs something to run, it looks, in order:

1. Every 61st tick, the global queue — so it cannot starve.
2. Its own local queue.
3. The global queue.
4. The network poller, for goroutines whose I/O became ready.
5. **Work stealing**: pick another P at random and take half of its queue.

Work stealing is what keeps all cores busy without a central lock: idle Ps pull work, busy Ps never push.

## Blocking

What happens when a goroutine blocks depends on *how*.

- **Channel operations, mutexes, `time.Sleep`** — handled entirely in user space. The G is parked on a wait queue and the M immediately picks another G. No thread blocks.
- **Network I/O** — the file descriptor is non-blocking and registered with the netpoller (`epoll`, `kqueue`, IOCP). The G parks; a later scheduler pass finds it ready and makes it runnable.
- **Blocking system calls** (file I/O, cgo) — the M really does block in the kernel. The runtime detaches the P from it (the *handoff*) and gives the P to another M, creating one if necessary, so the other goroutines keep running. When the call returns, the M tries to get a P back; if none is free, its G goes to the global queue and the M parks.

This is why a Go program with `GOMAXPROCS=8` can have hundreds of threads: each one stuck in a syscall has given up its P.

## Preemption

Before Go 1.14 preemption was **cooperative**: the compiler inserted a check at function prologues, so a goroutine could only be descheduled when it called a function. A tight loop with no calls could hog a P forever and — worse — stall the garbage collector, which needs every goroutine to reach a safe point.

```go
// Before 1.14 this could hang the whole program with GOMAXPROCS=1.
go func() {
	for {
	}
}()
```

Since 1.14 preemption is **asynchronous**. A background thread, `sysmon`, notices a G that has been running for more than 10 ms and sends its M a signal (`SIGURG`); the signal handler arranges for the goroutine to yield at the next safe instruction.

`sysmon` runs without a P and also retakes Ps from Ms stuck in long syscalls, and kicks the netpoller if nobody has polled recently.

## Practical consequences

- Goroutines are cheap, not free. A million parked goroutines is a couple of gigabytes of stacks.
- In containers, `GOMAXPROCS` defaulted to the *host's* core count for a long time, not the CPU quota. A pod limited to 2 CPUs on a 64-core node ran 64 Ps and was throttled hard. Go 1.25 made the runtime aware of cgroup limits; on older versions use `automaxprocs`.
- `runtime.Gosched()` is almost never the answer.
- To see what the scheduler is doing: `GODEBUG=schedtrace=1000` prints a line per second, and `go tool trace` shows every scheduling event.
