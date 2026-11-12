## Problem

Given a string $s$, find the length of the longest **substring** in which no character appears twice.

A substring is a contiguous run of characters; `pwke` is a subsequence of `pwwkew`, not a substring.

## Input

A single line containing $s$. It consists of printable ASCII characters without spaces.

## Output

Print one integer: the length of the longest substring without repeating characters.

## Constraints

- $1 \le |s| \le 10^5$

## Examples

```text
Input
abcabcbb

Output
3
```

One answer is `abc`.

```text
Input
bbbbb

Output
1
```

```text
Input
pwwkew

Output
3
```

The answer is `wke`.

## Notes

The classic trap is moving the left edge of the window *backwards*. In `abba`, when the second `a` arrives the window already starts after the first `b`; jumping to "one past the previous `a`" would re-admit a duplicate.
