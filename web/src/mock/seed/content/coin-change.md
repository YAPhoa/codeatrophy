## Problem

You have an unlimited supply of coins in $n$ denominations. Find the **fewest** coins needed to pay exactly `amount`, or report that it cannot be done.

## Input

- The first line contains two integers $n$ and `amount`.
- The second line contains the $n$ distinct coin values $c_1, \dots, c_n$.

## Output

Print the minimum number of coins, or `-1` if the amount cannot be formed.

## Constraints

- $1 \le n \le 12$
- $1 \le c_i \le 10^4$
- $0 \le \text{amount} \le 10^4$

## Examples

```text
Input
3 11
1 2 5

Output
3
```

$11 = 5 + 5 + 1$.

```text
Input
1 3
2

Output
-1
```

## Notes

Greedy (always take the largest coin) fails: with coins `1 3 4` and amount `6`, greedy gives $4 + 1 + 1$ but $3 + 3$ is better. Let $f(a)$ be the answer for amount $a$:

$$
f(a) = 1 + \min_{c_i \le a} f(a - c_i), \qquad f(0) = 0
$$
