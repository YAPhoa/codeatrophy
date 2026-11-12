## Problem

You are given $n$ closed intervals $[l_i, r_i]$. Merge all intervals that overlap or touch, and output the resulting set of pairwise disjoint intervals.

Two intervals **touch** when one ends exactly where the other begins: $[1, 4]$ and $[4, 5]$ merge into $[1, 5]$.

## Input

- The first line contains an integer $n$.
- Each of the next $n$ lines contains two integers $l_i$ and $r_i$.

The intervals are given in no particular order.

## Output

On the first line print $k$, the number of intervals after merging. Then print the $k$ intervals, one per line, sorted by their left end.

## Constraints

- $1 \le n \le 10^5$
- $0 \le l_i \le r_i \le 10^9$

## Examples

```text
Input
4
1 3
2 6
8 10
15 18

Output
3
1 6
8 10
15 18
```

```text
Input
2
1 4
4 5

Output
1
1 5
```
