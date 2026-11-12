## Problem

You are given an array of $n$ integers and a target value. Find the two **different positions** whose values add up to the target.

It is guaranteed that exactly one such pair exists.

## Input

- The first line contains an integer $n$.
- The second line contains $n$ space-separated integers $a_0, a_1, \dots, a_{n-1}$.
- The third line contains the integer `target`.

## Output

Print the two indices $i < j$ (0-based) with $a_i + a_j = \text{target}$, separated by a space.

## Constraints

- $2 \le n \le 10^5$
- $-10^9 \le a_i, \text{target} \le 10^9$
- Exactly one valid pair exists.

## Examples

```text
Input
4
2 7 11 15
9

Output
0 1
```

$a_0 + a_1 = 2 + 7 = 9$.

```text
Input
3
3 2 4
6

Output
1 2
```

The same element may not be used twice, so `0 0` is not an answer here.

## Follow-up

The quadratic scan over all pairs is too slow for $n = 10^5$. Can you do it in a single pass?
