## Why not a binary tree?

A balanced binary search tree finds a key among $n$ in about $\log_2 n$ comparisons. For a billion keys that is 30 steps — perfectly good in memory, where following a pointer costs a few nanoseconds (or ~100 ns on a cache miss).

Put the same tree on disk and each step is a **page read**. On a spinning disk that is a ~10 ms seek, so one lookup takes a third of a second. On an SSD it is closer to 100 µs per read, and you are still paying for 30 of them in sequence. The comparisons are free; the I/O is everything.

The unit of I/O is not a byte or a node, it is a **page** — typically 4 KiB to 16 KiB — and reading one byte from a page costs the same as reading all of it. So the question becomes: *how do we organise keys so that a lookup touches as few pages as possible?* The answer is to make each node exactly one page and pack it with as many keys as will fit. That is a B-tree (Bayer and McCreight, 1970).

## The shape of the tree

A B-tree node holds many sorted keys and one more child pointer than it has keys. In a node with keys $k_1 < k_2 < \dots < k_m$, child $i$ covers everything between $k_i$ and $k_{i+1}$.

If a page holds a few hundred keys, the **fanout** is a few hundred and the tree is extremely shallow:

$$
\text{height} \approx \log_{f} n
$$

| Fanout $f$ | Keys reachable with 3 levels | with 4 levels |
| ---: | ---: | ---: |
| 100 | $10^6$ | $10^8$ |
| 300 | $2.7 \cdot 10^7$ | $8.1 \cdot 10^9$ |
| 500 | $1.25 \cdot 10^8$ | $6.25 \cdot 10^{10}$ |

Four page reads reach any row among billions. And since the root and the level below it are almost always cached in memory, a point lookup usually costs **one or two** actual disk reads.

The structure maintains three invariants:

1. Every node except the root is at least half full.
2. All leaves are at the same depth.
3. Keys within a node are sorted.

The second one is the striking property: the tree is *perfectly* height-balanced at all times, with no rotations and no colour bits. It achieves this by growing at the root rather than at the leaves.

## B+ trees: what databases actually use

Nearly every database "B-tree" is really a **B+ tree**, a variant with two changes:

- **Values live only in the leaves.** Internal nodes hold separator keys and child pointers, nothing else. Without values taking up room, internal nodes fit more keys, which means higher fanout and a shallower tree.
- **Leaves are linked** to their siblings, forming a sorted list of all the data.

The sibling links make range scans cheap. To run

```sql
SELECT * FROM orders
WHERE created_at BETWEEN '2026-01-01' AND '2026-01-31';
```

the engine descends once to the first qualifying leaf and then walks sideways along the leaf chain until it passes the upper bound. No returning to the parent, no re-descending.

## Lookup

Descend from the root. At each node, binary-search the separators to choose a child:

```python
def search(node, key):
    while not node.is_leaf:
        i = bisect_right(node.keys, key)   # first separator > key
        node = read_page(node.children[i])
    i = bisect_left(node.keys, key)
    if i < len(node.keys) and node.keys[i] == key:
        return node.values[i]
    return None
```

The binary search inside a page is a few dozen nanoseconds over data that is already in the CPU cache. All of the cost is in `read_page`.

## Insertion and splits

To insert, find the leaf where the key belongs and put it in sorted position. If the leaf has room, that is the whole operation: one page modified.

If the leaf is full, it **splits**:

1. Allocate a new page.
2. Move the upper half of the entries into it.
3. Insert a separator key (the first key of the new page) into the parent, pointing at the new page.

The parent now has one more entry — and may itself be full, in which case it splits the same way and pushes a separator into *its* parent. In the worst case the split propagates all the way up, the root splits, and a new root with two children is created above it. **That is the only way a B-tree gets taller**, and it is why every leaf is always at the same depth: the whole tree is lifted at once.

Splits are rare. A leaf must absorb about half a page of inserts between splits, so the amortised cost of an insert is a little over one page write.

### The sequential-insert problem

A 50/50 split is right for random keys. For keys that arrive in increasing order — auto-increment ids, timestamps — it is wasteful: the left half is never touched again and stays half empty forever, so the index ends up at 50% fill.

Engines detect this pattern and split unevenly, leaving the old page nearly full and starting the new one almost empty. PostgreSQL does it for the rightmost leaf; InnoDB tracks the last insert position per page to guess the direction.

The opposite case is the painful one. **Random keys such as UUIDv4 scatter inserts across every leaf in the index.** Each insert dirties a different page, the working set is the whole index rather than its right edge, and once the index outgrows memory every insert becomes a random read followed by a random write. This is the practical argument for time-ordered identifiers (UUIDv7, ULID, Snowflake ids) as primary keys.

## Deletion

Symmetric in theory: remove the entry, and if the node drops below half full, either borrow an entry from a sibling or **merge** with it and remove a separator from the parent, possibly cascading upward.

In practice most engines are lazy about it. Merging pages under concurrent access is intricate, and a table that shrank will probably grow again. PostgreSQL only reclaims a page when it becomes *completely* empty; InnoDB merges below a configurable threshold (`MERGE_THRESHOLD`, default 50%). This is one reason indexes bloat over time and why `REINDEX` and `OPTIMIZE TABLE` exist.

## What is inside a page

A page is not just an array of keys. With variable-length keys and values, the usual layout is a **slotted page**:

```text
+--------+---------------------+..............+------------------------+
| header | slot array  ----->  |  free space  |  <-----  cell contents |
+--------+---------------------+..............+------------------------+
```

- The header records the page type, the number of cells, free-space pointers and the right-sibling link.
- The slot array holds 2-byte offsets to the cells, **kept in key order**.
- The cells themselves are appended from the end of the page, in arrival order.

Inserting in the middle of the key order means shifting a few 2-byte slots, not moving the records. Deleting marks the slot dead and leaves a hole, which is compacted when the page needs the space.

Two more tricks raise the fanout further:

- **Prefix compression** — keys in one page tend to share a prefix; store it once.
- **Suffix truncation** — a separator in an internal node does not have to be a real key, it only has to *separate*. Between `"consistency"` and `"consistent hashing"` the separator `"consistent"` is enough.

## Concurrency and crash safety

A split touches at least three pages: the old leaf, the new leaf and the parent. Two problems follow.

**Concurrent readers.** A reader descending through the parent might arrive at the old leaf just after half its keys moved away. The Lehman–Yao **B-link tree** solves this by giving every node a right-sibling pointer and a *high key*: a reader that finds its key is greater than the node's high key simply follows the link to the right. Writers then never have to hold locks on more than one level at a time. PostgreSQL's nbtree is an implementation of exactly this.

**Crashes.** If the machine dies after writing the new leaf but before updating the parent, the tree is corrupt. Engines prevent this in one of two ways:

- a **write-ahead log** — describe the whole split in the log first, fsync, then modify pages at leisure; replay the log after a crash (PostgreSQL, InnoDB, SQLite in WAL mode);
- **copy-on-write** — never overwrite a page; write new versions of the changed pages up to a new root, then atomically switch the root pointer (LMDB, BoltDB, btrfs).

## B-trees versus LSM trees

The other dominant on-disk structure is the log-structured merge tree (RocksDB, Cassandra, LevelDB).

| | B-tree | LSM tree |
| --- | --- | --- |
| Writes | In place; random I/O | Appended; sequential I/O |
| Point reads | One path from the root | May check several levels (Bloom filters help) |
| Range scans | Walk the leaf chain | Merge across levels |
| Space | Pages 50–90% full | Compact, but transient duplicates |
| Background work | Little | Continuous compaction |

Roughly: B-trees favour reads and predictable latency, LSM trees favour write throughput and compression. Most relational databases chose B-trees and have had fifty years to tune them.

## Things to remember

- [x] One node = one page; fanout in the hundreds; height 3–4 for almost any table.
- [x] B+ tree: values in leaves only, leaves linked for range scans.
- [x] The tree grows from the root, so all leaves stay at the same depth.
- [x] Random primary keys hurt because they destroy insert locality.
- [ ] Read the Lehman–Yao paper properly — the high-key argument deserves a second pass.
- [ ] Measure index size for UUIDv4 vs UUIDv7 keys on a real table.
