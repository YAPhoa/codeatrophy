## Problem

A string consists only of the characters `(`, `)`, `[`, `]`, `{` and `}`. Decide whether it is **balanced**:

1. every opening bracket is closed by a bracket of the same kind, and
2. brackets are closed in the correct order.

## Input

A single line containing the string $s$.

## Output

Print `true` if $s$ is balanced and `false` otherwise.

## Constraints

- $1 \le |s| \le 10^5$
- $s$ contains only bracket characters.

## Examples

```text
Input
()[]{}

Output
true
```

```text
Input
([)]

Output
false
```

The `(` is still open when `]` tries to close the `[` — wrong order.

```text
Input
{[]}

Output
true
```
