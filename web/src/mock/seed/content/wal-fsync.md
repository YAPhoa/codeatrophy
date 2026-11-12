## The rule

**Write-ahead logging**: before a change to a data page reaches disk, the log record describing that change must already be on disk.

That one ordering constraint buys atomicity and durability:

- A transaction is committed when its commit record is durable in the log — not when its pages are written. Pages can be flushed later, in any order, in the background.
- After a crash, replay the log from the last checkpoint. Changes from committed transactions are redone; changes from transactions with no commit record are undone (or were never applied).

The log is append-only, so committing costs one sequential write instead of a random write per modified page.

## `write()` is not durable

`write()` copies bytes into the kernel's page cache and returns. The data reaches the device seconds later, or never, if power is lost first. Durability needs an explicit flush:

```c
ssize_t n = write(fd, record, len);
if (n != len) { /* handle a short write */ }
if (fdatasync(fd) != 0) {
    /* The log may be damaged. Do NOT retry and carry on. */
    abort();
}
```

- `fsync` flushes data and metadata; `fdatasync` skips metadata that is not needed to read the data back (such as mtime), saving a seek.
- After creating or renaming a file, **fsync the directory too**, or the file's name may not survive.
- On macOS `fsync` does not flush the drive's write cache; `fcntl(fd, F_FULLFSYNC)` does.

### The fsync error problem

On Linux, if writeback fails, `fsync` reports the error **once** and marks the pages clean. A second `fsync` returns success, although the data never reached the disk. PostgreSQL retried on failure for twenty years before this was noticed in 2018 ("fsyncgate"); it now panics and recovers from the log instead.

## Group commit

An fsync costs anything from ~50 µs on a good NVMe drive to ~10 ms on a spinning disk. One fsync per transaction caps throughput at the fsync rate.

**Group commit** batches them: while one flush is in flight, later transactions append their records and wait; the next flush covers them all. Throughput then scales with concurrency, at the price of a little latency.

## Durability knobs

| Setting | Effect |
| --- | --- |
| PostgreSQL `synchronous_commit = off` | Commit returns before the flush; a crash loses up to ~3 × `wal_writer_delay` of commits, but never corrupts |
| MySQL `innodb_flush_log_at_trx_commit = 2` | Write at commit, fsync once per second |
| SQLite `PRAGMA synchronous = NORMAL` (WAL mode) | fsync at checkpoints only; a power cut may roll back recent commits |
| Redis `appendfsync everysec` | fsync the AOF once per second |

All of these trade the last moments of acknowledged work for speed. Know which one you are running.
