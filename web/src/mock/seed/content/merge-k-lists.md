## Problem

You are given an array of `k` linked lists, each sorted in ascending order. Merge them into one sorted linked list and return its head.

## Examples

```text
Input: lists = [[1,4,5],[1,3,4],[2,6]]
Output: [1,1,2,3,4,4,5,6]
```

```text
Input: lists = []
Output: []
```

```text
Input: lists = [[]]
Output: []
```

## Constraints

- $0 \le k \le 10^4$
- Each list has at most $500$ nodes, and all lists together at most $10^4$.
- $-10^4 \le \text{val} \le 10^4$

## Follow-up

Merging the lists one after another takes $O(kN)$ time for $N$ nodes in total. Can you do it in $O(N \log k)$?
