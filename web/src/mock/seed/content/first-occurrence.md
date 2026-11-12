## Problem

You are given a sorted array of $n$ integers, possibly with duplicates, and $q$ queries. For each query value $x$, report the index of its **first occurrence** in the array, or `-1` if it does not occur.

## Input

- The first line contains two integers $n$ and $q$.
- The second line contains $n$ integers in non-decreasing order.
- Each of the next $q$ lines contains one query value $x$.

## Output

For each query print one line: the smallest 0-based index $i$ with $a_i = x$, or `-1`.

## Constraints

- $1 \le n, q \le 10^5$
- $-10^9 \le a_i, x \le 10^9$

## Examples

```text
Input
6 3
1 2 2 2 5 9
2
5
7

Output
1
4
-1
```

## Notes

Finding *an* occurrence and then walking left is $O(n)$ per query on an input like `1 1 1 … 1`. Write the search so that it converges on the boundary itself:

| Invariant | Meaning |
| --- | --- |
| everything left of `lo` | is `< x` |
| everything from `hi` on | is `>= x` |

When `lo == hi`, that position is the answer candidate.
