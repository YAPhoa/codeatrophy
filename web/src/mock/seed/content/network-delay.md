## Problem

A network has $n$ nodes numbered from 1 and $m$ **directed** links. A signal sent over link $u \to v$ takes $w$ time units. A signal is sent from node $k$ and is forwarded instantly by every node that receives it.

How long does it take until **every** node has received the signal? If some node can never be reached, print `-1`.

## Input

- The first line contains three integers $n$, $m$ and $k$.
- Each of the next $m$ lines contains three integers $u$, $v$ and $w$.

## Output

Print the time at which the last node receives the signal, or `-1`.

## Constraints

- $1 \le k \le n \le 10^5$
- $0 \le m \le 2 \cdot 10^5$
- $1 \le w \le 10^4$

## Examples

```text
Input
4 3 2
2 1 1
2 3 1
3 4 1

Output
2
```

Node 4 is the last to hear the signal, via $2 \to 3 \to 4$.

```text
Input
2 1 2
1 2 1

Output
-1
```

The only link points the wrong way.
