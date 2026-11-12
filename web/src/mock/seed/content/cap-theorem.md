## The statement

A distributed data store can provide at most two of the following three guarantees at the same time:

- **Consistency** — every read sees the most recent write (formally: *linearizability*).
- **Availability** — every request to a non-failed node receives a non-error response.
- **Partition tolerance** — the system keeps working when messages between nodes are lost or delayed.

Brewer conjectured it in 2000; Gilbert and Lynch proved it in 2002.

## "Pick two" is misleading

Partitions are not optional. Networks drop packets, switches fail, a GC pause looks exactly like a dead peer. You do not get to choose CA unless the whole system is one machine. The real statement is:

> When a partition happens, you must choose between consistency and availability.

So the theorem is about behaviour **during a fault**, not about normal operation.

- **CP** — refuse (or block) requests that cannot be guaranteed correct. The minority side of a partition stops accepting writes. *etcd, ZooKeeper, Spanner, HBase.*
- **AP** — keep answering on both sides and reconcile later. Reads may be stale; concurrent writes conflict and need resolution. *Dynamo, Cassandra, Riak, DNS.*

## The proof in one paragraph

Take two nodes, $A$ and $B$, holding the same register, and cut the link between them. A client writes $v_1$ to $A$. Another client reads from $B$. If $B$ answers, it must answer with the old value (it cannot have heard about $v_1$) — not consistent. If $B$ refuses or waits, it is not available. There is no third option.

## What CAP does *not* say

1. It says nothing about **latency**. A system that answers correctly after 30 seconds is "available" by the formal definition.
2. The C is not the C in ACID. ACID consistency is about application invariants; CAP consistency is linearizability.
3. It is not a per-system label. Many stores let you choose **per request**: Cassandra's `QUORUM` vs `ONE`, DynamoDB's strongly consistent reads, MongoDB's read and write concerns.
4. "Availability" in the theorem is all-or-nothing; real systems talk in nines.

## PACELC

Abadi's extension captures the trade-off that matters when nothing is broken:

> If there is a **P**artition, choose **A** or **C**; **E**lse, choose **L**atency or **C**onsistency.

Synchronous replication to a quorum costs a round trip on every write. Systems that skip it are faster and risk staleness even on a perfectly healthy network.

| System | During a partition | Otherwise |
| --- | --- | --- |
| Dynamo, Cassandra (default) | A | L |
| Spanner, etcd | C | C |
| MongoDB (default) | A | C |
| PNUTS | C | L |

## Questions to ask about any datastore

- What does a client on the minority side of a partition observe — errors, timeouts or stale data?
- What happens to writes that were acknowledged just before a failover?
- Can I choose the consistency level per operation?
- How are conflicting writes resolved: last-write-wins, vector clocks, CRDTs — or silently dropped?
