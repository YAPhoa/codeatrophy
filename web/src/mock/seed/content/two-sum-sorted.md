## Problem

A ledger lists $n$ transaction amounts in **non-decreasing order**. Find the two entries that add up to exactly `target`.

Exactly one pair exists. Your solution should use only $O(1)$ extra memory — the sorted order is the whole point.

## Input

- The first line contains an integer $n$.
- The second line contains $n$ space-separated integers in non-decreasing order.
- The third line contains the integer `target`.

## Output

Print the **1-based** positions $i < j$ of the two entries, separated by a space.

## Constraints

- $2 \le n \le 2 \cdot 10^5$
- $-10^9 \le a_i, \text{target} \le 10^9$
- The array is sorted in non-decreasing order.

## Examples

```text
Input
4
2 7 11 15
9

Output
1 2
```

```text
Input
3
2 3 4
6

Output
1 3
```

## Hint

Start with one pointer at each end. What does it tell you when the sum of the two ends is too small? Too large?
