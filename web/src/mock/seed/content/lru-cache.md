## Problem

Simulate a **least-recently-used cache** with room for `capacity` keys. It supports two operations:

- `put k v` — store value `v` under key `k`. If the key is already present its value is replaced. If the cache is full, the least recently used key is evicted first.
- `get k` — print the value stored under `k`, or `-1` if it is absent.

Both operations count as a *use* of the key, and each should run in $O(1)$ time on average.

## Input

- The first line contains two integers `capacity` and $q$.
- Each of the next $q$ lines contains one operation in the format above.

## Output

For every `get`, print the result on its own line.

## Constraints

- $1 \le \text{capacity} \le 10^5$
- $1 \le q \le 2 \cdot 10^5$
- $0 \le k, v \le 10^9$

## Examples

```text
Input
2 9
put 1 1
put 2 2
get 1
put 3 3
get 2
put 4 4
get 1
get 3
get 4

Output
1
-1
-1
3
4
```

`put 3 3` evicts key 2 (key 1 was just read). `put 4 4` then evicts key 1.

## Notes

The textbook structure is a hash map from key to a node in a doubly linked list kept in recency order:

```cpp
struct Node {
    long long key, value;
    Node *prev, *next;
};
```
