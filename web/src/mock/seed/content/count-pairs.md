## Problem

Given an array of $n$ integers and a target, count the pairs of positions $(i, j)$ with $i < j$ and $a_i + a_j = \text{target}$.

Unlike *Two Sum*, there may be no such pair, or a great many: equal values at different positions form different pairs.

## Input

- The first line contains an integer $n$.
- The second line contains $n$ space-separated integers.
- The third line contains the integer `target`.

## Output

Print a single integer — the number of pairs.

## Constraints

- $1 \le n \le 2 \cdot 10^5$
- $-10^9 \le a_i, \text{target} \le 10^9$

The answer can be as large as $\binom{n}{2} \approx 2 \cdot 10^{10}$, so it does not fit in a 32-bit integer.

## Examples

```text
Input
4
1 1 1 1
2

Output
6
```

Every one of the $\binom{4}{2} = 6$ pairs sums to 2.

```text
Input
5
1 5 7 -1 5
6

Output
3
```

The pairs are $(1, 5)$ twice — once for each `5` — and $(7, -1)$.
