## Problem

Given two words $a$ and $b$, compute the minimum number of single-character operations needed to turn $a$ into $b$. The allowed operations are:

- **insert** a character,
- **delete** a character,
- **replace** a character with another.

## Input

Two lines: the word $a$, then the word $b$. Both consist of lower-case letters.

## Output

Print the edit distance between $a$ and $b$.

## Constraints

- $1 \le |a|, |b| \le 2000$

## Examples

```text
Input
horse
ros

Output
3
```

`horse` → `rorse` (replace `h`) → `rose` (delete `r`) → `ros` (delete `e`).

```text
Input
intention
execution

Output
5
```

## Notes

With $d(i, j)$ the distance between the first $i$ characters of $a$ and the first $j$ of $b$:

$$
d(i, j) = \begin{cases}
\max(i, j) & \text{if } \min(i, j) = 0 \\
d(i-1, j-1) & \text{if } a_i = b_j \\
1 + \min\bigl(d(i-1, j),\ d(i, j-1),\ d(i-1, j-1)\bigr) & \text{otherwise}
\end{cases}
$$

Only the previous row is needed, so memory can be $O(\min(|a|, |b|))$.
