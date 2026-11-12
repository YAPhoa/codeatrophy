## The question

Appending to a dynamic array is "$O(1)$" — except when the array is full and every element has to be copied to a bigger one, which is $O(n)$. Both statements are true. Amortised analysis is the tool for saying something more useful than "worst case $O(n)$ per append": it bounds the **total cost of a sequence** of operations, and divides.

It is *not* average-case analysis. There is no probability involved and no assumption about the input. The bound holds for every sequence, including the worst one.

## The doubling array

Start with capacity 1 and double whenever the array is full. Let $c_i$ be the cost of the $i$-th append, counting one unit per element written:

$$
c_i = \begin{cases} i & \text{if } i - 1 \text{ is a power of two (copy } i - 1 \text{ elements, then write one)} \\ 1 & \text{otherwise} \end{cases}
$$

### Aggregate method

Add everything up. Over $n$ appends, the writes cost $n$ and the copies cost $1 + 2 + 4 + \dots$ up to the largest power of two below $n$:

$$
\sum_{i=1}^{n} c_i \;\le\; n + \sum_{j=0}^{\lfloor \log_2 n \rfloor} 2^j \;<\; n + 2n \;=\; 3n
$$

Total cost under $3n$, so the amortised cost per append is under 3 — constant.

### Accounting method

Charge every append **3 coins**, whatever it really costs:

- 1 coin pays for writing the element now;
- 1 coin is saved on the element, to pay for moving it at the next resize;
- 1 coin is saved on behalf of an element in the *first half* of the array, which spent its own coin at the previous resize.

When the array of capacity $m$ fills up, the $m/2$ elements added since the last resize have deposited $2 \cdot m/2 = m$ coins — exactly enough to move all $m$ elements. The bank balance never goes negative, so 3 coins per operation is a valid amortised bound.

### Potential method

Define a potential function on the state of the data structure and let the amortised cost be the actual cost plus the change in potential:

$$
\hat{c}_i = c_i + \Phi(D_i) - \Phi(D_{i-1})
$$

If $\Phi$ starts at zero and never goes negative, the sum of amortised costs bounds the sum of actual costs. For the array take

$$
\Phi = 2 \cdot \text{size} - \text{capacity}
$$

- An ordinary append: actual cost 1, size grows by 1, so $\Delta\Phi = 2$ and $\hat{c} = 3$.
- An append that doubles capacity from $m$ to $2m$: actual cost $m + 1$; $\Phi$ goes from $2m - m = m$ to $2(m + 1) - 2m = 2$, so $\Delta\Phi = 2 - m$ and $\hat{c} = m + 1 + 2 - m = 3$.

The same answer three ways. The potential method is the one that scales to hard cases (splay trees, Fibonacci heaps, union–find).

## Why the growth factor matters

Growing by a constant *amount* instead of a constant *factor* breaks the argument. Adding 10 slots at a time makes resizes happen every 10 appends, each copying everything:

| Growth policy | Total cost of $n$ appends | Amortised per append |
| --- | --- | --- |
| $+1$ each time | $\Theta(n^2)$ | $\Theta(n)$ |
| $+k$ (constant) | $\Theta(n^2 / k)$ | $\Theta(n)$ |
| $\times 2$ | $< 3n$ | $O(1)$ |
| $\times 1.5$ | $< 4n$ | $O(1)$ |

Any factor greater than 1 works. Smaller factors waste less memory and copy more often; 1.5 also lets a later allocation reuse the freed blocks of earlier ones, which is why some standard libraries prefer it to 2.

## Shrinking without thrashing

If the array halves its capacity as soon as it is half empty, a sequence that alternates append and pop right at the boundary pays $O(n)$ every time. The fix is hysteresis: **shrink at one quarter full, not one half**. After any resize the array is half full, so $\Omega(n)$ cheap operations must happen before the next expensive one.

## More examples

1. **Stack with multipop.** `multipop(k)` costs up to $k$, but each element is pushed once and popped at most once, so any $n$ operations cost $O(n)$ total.
2. **Binary counter.** Incrementing flips up to $\log n$ bits, yet bit $j$ flips only every $2^j$ increments; $n$ increments flip fewer than $2n$ bits.
3. **Queue from two stacks.** Each element is pushed twice and popped twice at most.
4. **Union–find** with path compression and union by rank: $O(\alpha(n))$ amortised, where $\alpha$ is the inverse Ackermann function — at most 4 for any input that fits in the universe.

## The caveat

An amortised bound says nothing about any single operation. If one slow append means a dropped frame or a missed deadline, a structure with $O(1)$ *worst-case* operations (or incremental resizing, as Go's maps and Redis's dictionaries do) is the right tool, even though its amortised cost is no better.
