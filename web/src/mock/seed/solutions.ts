// The saved solutions of the seed problems. The reference solution's source
// lives with the problem (`reference` in ./problems); this file names it and
// adds the other approaches a user would have kept next to it.
//
// Every source has to build on the judge's toolchains: Python 3.8, GCC 9,
// Go 1.13, OpenJDK 13 and Node.js 12.

export interface SeedSolution {
  name: string;
  language: string;
  source: string;
  /** Markdown. */
  notes: string;
}

export interface SeedSolutionSet {
  /** Name and notes of the reference solution. */
  reference: { name: string; notes: string };
  /** The other saved solutions, oldest first. */
  others?: SeedSolution[];
}

/** By problem `key`. A problem with a reference solution and no entry here gets a plainly named one. */
export const SEED_SOLUTIONS: Record<string, SeedSolutionSet> = {
  'two-sum': {
    reference: {
      name: 'Hash map, one pass',
      notes:
        '**O(n)** time, **O(n)** space.\n\nLook the complement up *before* storing the current value, so an element is never paired with itself.',
    },
    others: [
      {
        name: 'Brute force',
        language: 'python',
        notes: '**O(n²)** time, **O(1)** space. Fine for the examples, times out on the large hidden case.',
        source: String.raw`import sys


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    nums = [int(x) for x in data[1:1 + n]]
    target = int(data[1 + n])
    for i in range(n):
        for j in range(i + 1, n):
            if nums[i] + nums[j] == target:
                print(i, j)
                return


main()

# MOCK:TLE (read by the pretend judge of the API mock: the last case times out)
`,
      },
      {
        name: 'Hash map, one pass (C++)',
        language: 'cpp',
        notes: 'Same idea as the Python one. `unordered_map` keyed by value; `long long` because the sums can overflow `int`.',
        source: String.raw`#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    cin >> n;
    vector<long long> nums(n);
    for (auto &x : nums) cin >> x;
    long long target;
    cin >> target;

    unordered_map<long long, int> seen;
    for (int i = 0; i < n; i++) {
        auto it = seen.find(target - nums[i]);
        if (it != seen.end()) {
            cout << it->second << " " << i << "\n";
            return 0;
        }
        seen[nums[i]] = i;
    }
    return 0;
}
`,
      },
    ],
  },
  'two-sum-sorted': {
    reference: {
      name: 'Two pointers',
      notes: '**O(n)** time, **O(1)** space. Move the left pointer when the sum is too small, the right one when it is too large.',
    },
    others: [
      {
        name: 'Binary search per element',
        language: 'go',
        notes: '**O(n log n)** time, **O(1)** space. Slower than two pointers, but the first thing that comes to mind for sorted input.',
        source: String.raw`package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

func main() {
	reader := bufio.NewReader(os.Stdin)
	var n int
	fmt.Fscan(reader, &n)
	nums := make([]int, n)
	for i := range nums {
		fmt.Fscan(reader, &nums[i])
	}
	var target int
	fmt.Fscan(reader, &target)

	for i, x := range nums {
		rest := nums[i+1:]
		j := sort.SearchInts(rest, target-x)
		if j < len(rest) && rest[j] == target-x {
			fmt.Println(i+1, i+j+2)
			return
		}
	}
}
`,
      },
    ],
  },
  'count-pairs': {
    reference: {
      name: 'Count earlier values',
      notes: '**O(n)** time, **O(n)** space. Each element pairs with every earlier occurrence of its complement.',
    },
    others: [
      {
        name: 'Brute force, all pairs',
        language: 'java',
        notes: '**O(n²)** time. Only useful for checking the fast one on small inputs — the count needs a `long`.',
        source: String.raw`import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.StringTokenizer;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        StringBuilder text = new StringBuilder();
        for (String line = in.readLine(); line != null; line = in.readLine()) {
            text.append(line).append(' ');
        }
        StringTokenizer tokens = new StringTokenizer(text.toString());
        int n = Integer.parseInt(tokens.nextToken());
        long[] nums = new long[n];
        for (int i = 0; i < n; i++) {
            nums[i] = Long.parseLong(tokens.nextToken());
        }
        long target = Long.parseLong(tokens.nextToken());

        long pairs = 0;
        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                if (nums[i] + nums[j] == target) {
                    pairs++;
                }
            }
        }
        System.out.println(pairs);
    }
}
`,
      },
    ],
  },
  'valid-parentheses': {
    reference: { name: 'Stack of open brackets', notes: '**O(n)** time, **O(n)** space.' },
  },
  'longest-substring': {
    reference: {
      name: 'Sliding window, last seen positions',
      notes:
        '**O(n)** time, **O(k)** space for an alphabet of `k` characters.\n\nThe left edge jumps straight past the previous occurrence, and never moves backwards.',
    },
    others: [
      {
        name: 'Sliding window with a set',
        language: 'javascript',
        notes: 'Shrinks the window one character at a time. Still **O(n)** overall: each character enters and leaves the set once.',
        source: String.raw`const s = require('fs').readFileSync(0, 'utf8').split('\n')[0].trim();

const seen = new Set();
let left = 0;
let best = 0;
for (let right = 0; right < s.length; right++) {
  while (seen.has(s[right])) {
    seen.delete(s[left]);
    left++;
  }
  seen.add(s[right]);
  best = Math.max(best, right - left + 1);
}
console.log(best);
`,
      },
    ],
  },
  'merge-intervals': {
    reference: { name: 'Sort by start, then sweep', notes: '**O(n log n)** time for the sort; the sweep is linear.' },
  },
  'first-occurrence': {
    reference: { name: 'Leftmost binary search', notes: '**O(log n)** per query.' },
  },
  'coin-change': {
    reference: {
      name: 'Bottom-up table',
      notes: '**O(amount × coins)** time, **O(amount)** space. `best[a]` is the fewest coins that make `a`.',
    },
    others: [
      {
        name: 'Memoised recursion',
        language: 'python',
        notes: 'Top-down version of the same recurrence. Easier to write, but needs the recursion limit raised for large amounts.',
        source: String.raw`import sys
from functools import lru_cache


def main() -> None:
    data = sys.stdin.read().split()
    n, amount = int(data[0]), int(data[1])
    coins = [int(x) for x in data[2:2 + n]]
    sys.setrecursionlimit(amount + 1000)
    inf = float("inf")

    @lru_cache(maxsize=None)
    def fewest(a: int) -> float:
        if a == 0:
            return 0
        return min((fewest(a - c) + 1 for c in coins if c <= a), default=inf)

    answer = fewest(amount)
    print(answer if answer != inf else -1)


main()
`,
      },
      {
        name: 'Breadth-first search over amounts',
        language: 'cpp',
        notes:
          'Treat every amount as a node and every coin as an edge: the answer is the shortest path from `0` to `amount`.\n\nSame bound as the table, **O(amount × coins)**.',
        source: String.raw`#include <bits/stdc++.h>
using namespace std;

int main() {
    int n, amount;
    cin >> n >> amount;
    vector<int> coins(n);
    for (auto &c : coins) cin >> c;

    vector<int> dist(amount + 1, -1);
    queue<int> q;
    dist[0] = 0;
    q.push(0);
    while (!q.empty()) {
        int a = q.front();
        q.pop();
        for (int c : coins) {
            long long next = (long long)a + c;
            if (next <= amount && dist[next] == -1) {
                dist[next] = dist[a] + 1;
                q.push((int)next);
            }
        }
    }
    cout << dist[amount] << "\n";
    return 0;
}
`,
      },
    ],
  },
  lis: {
    reference: {
      name: 'Patience sorting with binary search',
      notes: '**O(n log n)** time. `tails[i]` is the smallest value that can end an increasing subsequence of length `i + 1`.',
    },
    others: [
      {
        name: 'Quadratic DP',
        language: 'python',
        notes: '**O(n²)** time: `best[i]` is the longest increasing subsequence ending at `i`. Too slow for the full constraints.',
        source: String.raw`import sys


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    nums = [int(x) for x in data[1:1 + n]]
    best = [1] * n
    for i in range(n):
        for j in range(i):
            if nums[j] < nums[i] and best[j] + 1 > best[i]:
                best[i] = best[j] + 1
    print(max(best, default=0))


main()
`,
      },
    ],
  },
  'edit-distance': {
    reference: { name: 'Two-row DP', notes: '**O(|a| × |b|)** time, **O(|b|)** space: only the previous row is kept.' },
  },
  islands: {
    reference: { name: 'Breadth-first flood fill', notes: '**O(rows × columns)**. Cells are sunk as they are queued, so none is visited twice.' },
  },
  'network-delay': {
    reference: { name: 'Dijkstra with a binary heap', notes: '**O((n + m) log m)** time.' },
  },
  'lru-cache': {
    reference: { name: 'OrderedDict', notes: '**O(1)** per operation: `move_to_end` on every access, `popitem(last=False)` to evict.' },
  },
};
