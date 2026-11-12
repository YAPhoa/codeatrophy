## Problem

Given a sequence of $n$ integers, find the length of its longest **strictly increasing subsequence**.

A subsequence keeps the original order but may skip elements.

## Input

- The first line contains an integer $n$.
- The second line contains $n$ space-separated integers.

## Output

Print the length of the longest strictly increasing subsequence.

## Constraints

- $1 \le n \le 10^5$
- $-10^9 \le a_i \le 10^9$

## Examples

```text
Input
8
10 9 2 5 3 7 101 18

Output
4
```

One longest increasing subsequence is `2 3 7 18`.

```text
Input
7
7 7 7 7 7 7 7

Output
1
```

Equal elements do not count as increasing.

## Notes

The $O(n^2)$ table is fine up to a few thousand elements, but not for $n = 10^5$. Keep an array `tails` where `tails[k]` is the smallest possible last element of an increasing subsequence of length $k + 1$; it stays sorted, so each new element is placed with a binary search for $O(n \log n)$ overall.
