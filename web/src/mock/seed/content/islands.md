## Problem

A map is a grid of $r$ rows and $c$ columns. Each cell is land (`1`) or water (`0`). An **island** is a maximal group of land cells connected horizontally or vertically — diagonals do not connect.

Count the islands.

## Input

- The first line contains two integers $r$ and $c$.
- Each of the next $r$ lines contains a string of $c$ characters, each `0` or `1`.

## Output

Print the number of islands.

## Constraints

- $1 \le r, c \le 1000$

## Examples

```text
Input
4 5
11000
11000
00100
00011

Output
3
```

```text
Input
3 3
101
010
101

Output
5
```

Diagonal neighbours are separate islands.

## Notes

A recursive flood fill overflows the stack on a $1000 \times 1000$ grid that is all land. Use an explicit queue or stack.
