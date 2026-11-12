## The problem with `hash(key) % N`

Suppose you have a cache cluster of $N$ servers and you want to decide which server holds a given key. The obvious scheme is

```python
def server_for(key, servers):
    return servers[hash(key) % len(servers)]
```

It is uniform, stateless and trivially fast. It is also a disaster the moment $N$ changes. Go from 4 servers to 5 and a key stays where it was only if `h % 4 == h % 5`, which holds for roughly one key in five. **About 80% of the keys move.** For a cache that means a near-total miss storm; for a storage system it means copying most of your data across the network because one machine was added.

What we want instead is a placement function where adding or removing a server relocates only the keys that *have* to move — about $K/N$ of them for $K$ keys — and leaves the rest alone. That property is what "consistent" means here, and it has nothing to do with the C in CAP or ACID.

## The ring

Consistent hashing, introduced by Karger et al. in 1997 for distributed web caching, replaces the modulo with geometry.

1. Take the output range of a hash function — say $[0, 2^{32})$ — and bend it into a circle.
2. Hash each **server** (by name or address) to a point on the circle.
3. Hash each **key** to a point on the same circle.
4. A key belongs to the first server found walking **clockwise** from the key's position.

Now consider what happens when a server joins. It lands at some point on the ring and takes over the arc between itself and its counter-clockwise neighbour. Keys on that arc move to the new server; **every other key stays put**. When a server leaves, its arc is absorbed by its clockwise neighbour, and again nothing else moves.

With $N$ servers placed at random, each owns $1/N$ of the ring on average, so a membership change moves an expected $K/N$ keys. That is optimal: a new server that is supposed to carry its fair share has to receive that many keys from somewhere.

### Lookup

The server positions are kept in a sorted array. Finding the owner of a key is a binary search for the first position $\ge$ the key's hash, wrapping around to index 0 at the end:

```go
type Ring struct {
	points []uint32          // sorted
	owner  map[uint32]string // point -> server
}

func (r *Ring) Lookup(key string) string {
	h := hash32(key)
	i := sort.Search(len(r.points), func(i int) bool { return r.points[i] >= h })
	if i == len(r.points) {
		i = 0 // wrap around
	}
	return r.owner[r.points[i]]
}
```

That is $O(\log N)$ per lookup with the ring in memory, which is negligible next to the network hop that follows.

## Why one point per server is not enough

"Each server owns $1/N$ on average" hides a lot of variance. With one random point per server the arcs are wildly uneven: the largest arc among $N$ servers is about $\ln N$ times the average. With 100 servers, expect some machine to be carrying four or five times its share while others idle.

There is a second problem. When a server dies, its *entire* load lands on a single neighbour — which may then fall over too, passing an even bigger load to the next one. Cascading failure is baked into the naive ring.

### Virtual nodes

The fix is to give every physical server many points on the ring, called **virtual nodes** (vnodes). Hash `"server-a#0"`, `"server-a#1"`, …, `"server-a#199"` and place all 200 points. A server's share is now the sum of 200 small arcs, and by the law of large numbers the sum concentrates around the mean:

| Points per server | Typical load spread (std. dev. / mean) |
| ---: | --- |
| 1 | ~100% |
| 10 | ~32% |
| 100 | ~10% |
| 1000 | ~3% |

The spread falls off as $1/\sqrt{v}$ for $v$ points per server, so going from 100 to 1000 vnodes buys you far less than going from 1 to 100 did. In practice people use somewhere between 100 and a few hundred.

Virtual nodes fix the failure mode as well. A dead server's 200 arcs are absorbed by 200 different successors, most of them distinct machines, so the extra load is spread over the whole cluster instead of being dumped on one unlucky neighbour.

They also give you a knob for **heterogeneous hardware**: a machine with twice the capacity gets twice as many points.

> The cost is memory and rebuild time: the ring has $N \cdot v$ entries instead of $N$. For 1 000 servers × 200 vnodes that is 200 000 sorted integers — a couple of megabytes. Nobody minds.

## Replication on the ring

Storage systems want each key on $R$ machines, not one. The standard trick, used by Dynamo and its descendants, is to keep walking: the key is stored on the first $R$ **distinct physical servers** found clockwise from its position. This list is the key's *preference list*.

The word *distinct* matters. With virtual nodes, the next three points on the ring might all belong to the same machine, and three replicas on one box is not replication. Real systems go further and skip servers in the same rack or availability zone.

A nice consequence: when a server fails, the servers that take over its ranges are exactly the ones that already hold replicas of that data. Reads can continue without any transfer; the cluster only needs to re-replicate in the background to get back to $R$ copies.

## Where it shows up

- **Amazon Dynamo** and **Apache Cassandra** — partitioning and replica placement. Cassandra originally assigned one token per node (and operators had to rebalance by hand); vnodes arrived in 1.2.
- **Memcached clients** — the `ketama` algorithm is consistent hashing with ~160 points per server, done entirely client-side.
- **Load balancers** — HAProxy and Envoy both offer ring-hash policies so that requests for the same session or cache key keep hitting the same backend as the pool changes.
- **CDNs** — the original use case: mapping URLs to edge caches.

## Alternatives worth knowing

The ring is not the only way to get the minimal-disruption property.

**Rendezvous hashing** (highest random weight). For a key, compute `hash(key, server)` for *every* server and pick the maximum. Removing a server only affects keys for which it was the maximum; adding one only steals keys for which it is the new maximum. No ring, no vnodes, perfectly even load — but $O(N)$ per lookup, which is fine for tens of servers and painful for thousands.

**Jump consistent hash** (Lamping & Veach, 2014). A startlingly short function that maps a 64-bit key to a bucket in $[0, N)$ with no memory at all and near-perfect balance:

```cpp
int32_t JumpConsistentHash(uint64_t key, int32_t num_buckets) {
    int64_t b = -1, j = 0;
    while (j < num_buckets) {
        b = j;
        key = key * 2862933555777941757ULL + 1;
        j = (b + 1) * (double(1LL << 31) / double((key >> 33) + 1));
    }
    return b;
}
```

The catch: buckets are numbered, and you can only add or remove the *last* one. That suits sharded storage where shards are a logical layer above machines, and does not suit a cache pool where an arbitrary node can die.

**Maglev hashing** (Google, 2016). Builds a lookup table of size $M$ (a prime, e.g. 65 537) where each backend fills slots according to its own permutation. Lookup is a single array index. Balance is nearly perfect; disruption on membership change is small but not minimal. It was designed for load balancers that need constant-time lookups at packet rate.

**Bounded loads** (Mirrokni et al., 2016). A refinement of the ring: cap every server at $(1 + \varepsilon)$ times the average load, and when a key's server is full, continue clockwise to the next one with room. This is what you want when a few very hot keys would otherwise overload whichever server they hash to.

## Things that go wrong in practice

1. **Using a weak hash.** Language-default string hashes are often poor in the high bits, or randomised per process (Python's `hash()` is — two clients would disagree about the ring). Use a stable, well-mixed function such as xxHash, MurmurHash3 or the first bytes of MD5.
2. **Disagreeing on membership.** The ring is only consistent if every client sees the same set of servers. Two clients with different views route the same key to different places. Membership has to come from somewhere authoritative — a coordination service, or a gossip protocol that converges.
3. **Forgetting that hot keys exist.** Consistent hashing balances the *number of keys*, not the load. One celebrity key will melt one server no matter how even the arcs are. That needs a different tool: bounded loads, replicated reads, or a local cache in front.
4. **Rebalancing all at once.** Adding ten servers simultaneously moves ten arcs' worth of data at the same moment. Stagger the joins, or throttle the streaming.

## Summary

- Modulo placement remaps nearly everything when $N$ changes; consistent hashing remaps about $K/N$ keys.
- Servers and keys hash onto a ring; a key belongs to the next server clockwise.
- Virtual nodes even out the load (spread $\propto 1/\sqrt{v}$) and spread a failed server's load across the cluster.
- Replicas go on the next $R$ distinct physical servers.
- Rendezvous, jump and Maglev hashing trade lookup cost, memory and flexibility differently; pick by cluster size and how membership changes.
