// The problems of the seed library. Statements live as Markdown files in
// ./content, keyed by `key`.

import type { Difficulty, HarnessCode, ItemStatus, TestOrigin } from '../../api/types';
import { MERGE_K_LISTS_HARNESS, MERGE_K_LISTS_REFERENCE, MERGE_K_LISTS_STARTER } from './mergeKLists';

export interface SeedCase {
  name: string;
  stdin: string;
  out: string;
  sample?: boolean;
  origin?: TestOrigin;
  verified?: boolean;
  /**
   * What the reference solution really prints, when `out` is deliberately
   * wrong — so that "verify against the reference solution" has something
   * to find.
   */
  truth?: string;
}

export interface SeedProblem {
  /** Content file name (without `.md`), and the last digits of the item id. */
  key: string;
  n: number;
  title: string;
  summary: string;
  difficulty: Difficulty | null;
  tags: string[];
  status: ItemStatus;
  favorite?: boolean;
  /** Age in days at start-up. */
  created: number;
  updated: number;
  revision?: number;
  notes?: string;
  rawInput?: string;
  sourceUrl?: string;
  sourceNote?: string;
  /** `key` of the problem this one was derived from. */
  variantOf?: string;
  /** Languages that get starter code. */
  languages: string[];
  /**
   * Set for a "solution only" problem: the stub and the hidden runner per
   * language, in place of the stock starter code. Its `reference` and other
   * solutions are then the solution part only.
   */
  solutionOnly?: { starterCode: Record<string, string>; harness: Record<string, HarnessCode> };
  /** Source of the reference solution, in Python. Its name and the other saved solutions are in ./solutions. */
  reference?: string;
  cases: SeedCase[];
  /** Keys of the collections it belongs to. */
  collections: string[];
}

const COMMON = ['python', 'cpp', 'java', 'javascript', 'go'];

export const SEED_PROBLEMS: SeedProblem[] = [
  {
    key: 'two-sum',
    n: 1,
    title: 'Two Sum',
    summary: 'Find the two positions in an array whose values add up to a target.',
    difficulty: 'easy',
    tags: ['array', 'hash-map'],
    status: 'done',
    favorite: true,
    created: 118,
    updated: 96,
    revision: 4,
    rawInput: 'two sum — array + target, return the two indices, exactly one answer. O(n) with a hash map',
    notes:
      'Solved with a dict from value to index. First attempt used the nested loop and timed out on the big case — the single pass is the whole trick.',
    languages: COMMON,
    reference: String.raw`import sys


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    nums = [int(x) for x in data[1:1 + n]]
    target = int(data[1 + n])
    seen = {}
    for i, x in enumerate(nums):
        j = seen.get(target - x)
        if j is not None:
            print(j, i)
            return
        seen[x] = i


main()
`,
    cases: [
      { name: 'Example 1', stdin: '4\n2 7 11 15\n9\n', out: '0 1\n', sample: true, verified: true },
      { name: 'Example 2', stdin: '3\n3 2 4\n6\n', out: '1 2\n', sample: true, verified: true },
      { name: 'Two equal values', stdin: '2\n3 3\n6\n', out: '0 1\n', verified: true },
      { name: 'All negative', stdin: '5\n-1 -2 -3 -4 -5\n-8\n', out: '2 4\n', origin: 'ai', verified: true },
      { name: 'Pair at the end', stdin: '6\n1 5 9 14 20 31\n51\n', out: '4 5\n', origin: 'ai', verified: true },
      { name: 'Zeros', stdin: '4\n0 4 3 0\n0\n', out: '0 3\n', origin: 'ai', verified: true },
    ],
    collections: ['arrays', 'interview'],
  },
  {
    key: 'two-sum-sorted',
    n: 2,
    title: 'Two Sum in a Sorted Ledger',
    summary: 'The array is sorted: find the pair with two pointers and constant extra memory.',
    difficulty: 'easy',
    tags: ['array', 'two-pointers'],
    status: 'done',
    created: 95,
    updated: 95,
    variantOf: 'two-sum',
    languages: COMMON,
    reference: String.raw`import sys


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    nums = [int(x) for x in data[1:1 + n]]
    target = int(data[1 + n])
    lo, hi = 0, n - 1
    while lo < hi:
        s = nums[lo] + nums[hi]
        if s == target:
            print(lo + 1, hi + 1)
            return
        if s < target:
            lo += 1
        else:
            hi -= 1


main()
`,
    cases: [
      { name: 'Example 1', stdin: '4\n2 7 11 15\n9\n', out: '1 2\n', sample: true, origin: 'ai', verified: true },
      { name: 'Example 2', stdin: '3\n2 3 4\n6\n', out: '1 3\n', sample: true, origin: 'ai', verified: true },
      { name: 'Negative and zero', stdin: '2\n-1 0\n-1\n', out: '1 2\n', origin: 'ai', verified: true },
      { name: 'Duplicates at the end', stdin: '5\n1 2 3 4 4\n8\n', out: '4 5\n', origin: 'ai', verified: true },
    ],
    collections: ['arrays'],
  },
  {
    key: 'count-pairs',
    n: 3,
    title: 'Count Pairs With a Given Sum',
    summary: 'Count every pair of positions that adds up to the target; duplicates make the answer large.',
    difficulty: 'medium',
    tags: ['array', 'hash-map'],
    status: 'todo',
    created: 61,
    updated: 61,
    variantOf: 'two-sum',
    languages: COMMON,
    reference: String.raw`import sys
from collections import Counter


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    nums = [int(x) for x in data[1:1 + n]]
    target = int(data[1 + n])
    seen = Counter()
    pairs = 0
    for x in nums:
        pairs += seen[target - x]
        seen[x] += 1
    print(pairs)


main()
`,
    cases: [
      { name: 'Example 1', stdin: '4\n1 1 1 1\n2\n', out: '6\n', sample: true, origin: 'ai', verified: true },
      { name: 'Example 2', stdin: '5\n1 5 7 -1 5\n6\n', out: '3\n', sample: true, origin: 'ai', verified: true },
      { name: 'No pair', stdin: '3\n1 2 3\n7\n', out: '0\n', origin: 'ai', verified: true },
      { name: 'All equal', stdin: '6\n3 3 3 3 3 3\n6\n', out: '15\n', origin: 'ai', verified: true },
      { name: 'Single element', stdin: '1\n5\n10\n', out: '0\n', origin: 'ai', verified: false },
    ],
    collections: ['arrays', 'weekly'],
  },
  {
    key: 'valid-parentheses',
    n: 4,
    title: 'Valid Parentheses',
    summary: 'Decide whether a string of brackets is balanced and properly nested.',
    difficulty: 'easy',
    tags: ['stack', 'string'],
    status: 'done',
    created: 110,
    updated: 108,
    revision: 2,
    languages: COMMON,
    reference: String.raw`import sys


def main() -> None:
    s = sys.stdin.readline().strip()
    pairs = {")": "(", "]": "[", "}": "{"}
    stack = []
    for ch in s:
        if ch in pairs:
            if not stack or stack.pop() != pairs[ch]:
                print("false")
                return
        else:
            stack.append(ch)
    print("true" if not stack else "false")


main()
`,
    cases: [
      { name: 'Example 1', stdin: '()[]{}\n', out: 'true\n', sample: true, verified: true },
      { name: 'Example 2', stdin: '([)]\n', out: 'false\n', sample: true, verified: true },
      { name: 'Example 3', stdin: '{[]}\n', out: 'true\n', sample: true, verified: true },
      { name: 'Simple pair', stdin: '()\n', out: 'true\n', verified: true },
      { name: 'Mismatched kind', stdin: '(]\n', out: 'false\n', verified: true },
      { name: 'Unclosed', stdin: '((\n', out: 'false\n', verified: true },
      { name: 'Closer first', stdin: ']\n', out: 'false\n', verified: true },
    ],
    collections: ['interview'],
  },
  {
    key: 'longest-substring',
    n: 5,
    title: 'Longest Substring Without Repeating Characters',
    summary: 'Length of the longest run of characters with no repeats, in one pass with a sliding window.',
    difficulty: 'medium',
    tags: ['sliding-window', 'string', 'hash-map'],
    status: 'in_progress',
    favorite: true,
    created: 34,
    updated: 3,
    revision: 3,
    notes: 'Keep failing `abba`. The left edge must never move backwards: `left = max(left, last[ch] + 1)`.',
    languages: COMMON,
    reference: String.raw`import sys


def main() -> None:
    s = sys.stdin.readline().strip()
    last = {}
    left = 0
    best = 0
    for i, ch in enumerate(s):
        if ch in last and last[ch] >= left:
            left = last[ch] + 1
        last[ch] = i
        best = max(best, i - left + 1)
    print(best)


main()
`,
    cases: [
      { name: 'Example 1', stdin: 'abcabcbb\n', out: '3\n', sample: true, verified: true },
      { name: 'Example 2', stdin: 'bbbbb\n', out: '1\n', sample: true, verified: true },
      { name: 'Example 3', stdin: 'pwwkew\n', out: '3\n', sample: true, verified: true },
      { name: 'Repeat behind the window', stdin: 'abba\n', out: '2\n', verified: true },
      { name: 'Window restarts mid-way', stdin: 'dvdf\n', out: '3\n', origin: 'ai', verified: true },
      { name: 'Single character', stdin: 'a\n', out: '1\n', origin: 'ai', verified: true },
      { name: 'Repeat at both ends', stdin: 'tmmzuxt\n', out: '5\n', origin: 'ai', verified: true },
    ],
    collections: ['arrays', 'weekly'],
  },
  {
    key: 'merge-intervals',
    n: 6,
    title: 'Merge Intervals',
    summary: 'Merge all overlapping or touching intervals and print the disjoint result.',
    difficulty: 'medium',
    tags: ['sorting', 'array'],
    status: 'todo',
    created: 20,
    updated: 12,
    revision: 2,
    sourceNote: 'Phone screen, second question',
    languages: COMMON,
    reference: String.raw`import sys


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    intervals = sorted((int(data[1 + 2 * i]), int(data[2 + 2 * i])) for i in range(n))
    merged = []
    for lo, hi in intervals:
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    print(len(merged))
    for lo, hi in merged:
        print(lo, hi)


main()
`,
    cases: [
      {
        name: 'Example 1',
        stdin: '4\n1 3\n2 6\n8 10\n15 18\n',
        out: '3\n1 6\n8 10\n15 18\n',
        sample: true,
        verified: true,
      },
      { name: 'Touching intervals', stdin: '2\n1 4\n4 5\n', out: '1\n1 5\n', sample: true, verified: true },
      { name: 'Single interval', stdin: '1\n5 7\n', out: '1\n5 7\n', verified: true },
      {
        // Typed in by hand and wrong: the real answer keeps the right end at 9.
        name: 'Unsorted, one swallows the rest',
        stdin: '5\n6 8\n1 9\n2 4\n4 7\n10 12\n',
        out: '2\n1 8\n10 12\n',
        truth: '2\n1 9\n10 12\n',
        verified: false,
      },
      { name: 'Nothing overlaps', stdin: '3\n1 2\n3 4\n5 6\n', out: '3\n1 2\n3 4\n5 6\n', verified: false },
    ],
    collections: ['arrays', 'weekly'],
  },
  {
    key: 'first-occurrence',
    n: 7,
    title: 'First Occurrence in a Sorted Array',
    summary: 'Answer many "where does x first appear?" queries on a sorted array with a boundary binary search.',
    difficulty: 'easy',
    tags: ['binary-search', 'array'],
    status: 'done',
    created: 102,
    updated: 88,
    languages: COMMON,
    reference: String.raw`import sys
from bisect import bisect_left


def main() -> None:
    data = sys.stdin.read().split()
    n, q = int(data[0]), int(data[1])
    nums = [int(x) for x in data[2:2 + n]]
    out = []
    for x in map(int, data[2 + n:2 + n + q]):
        i = bisect_left(nums, x)
        out.append(str(i) if i < n and nums[i] == x else "-1")
    print("\n".join(out))


main()
`,
    cases: [
      { name: 'Example 1', stdin: '6 3\n1 2 2 2 5 9\n2\n5\n7\n', out: '1\n4\n-1\n', sample: true, verified: true },
      { name: 'Single element', stdin: '1 2\n4\n4\n3\n', out: '0\n-1\n', verified: true },
      { name: 'All equal', stdin: '5 4\n1 1 1 1 1\n1\n0\n2\n1\n', out: '0\n-1\n-1\n0\n', verified: true },
      { name: 'Ends and middle', stdin: '7 3\n-5 -3 0 0 2 8 8\n8\n-5\n0\n', out: '5\n0\n2\n', origin: 'ai', verified: true },
    ],
    collections: ['interview'],
  },
  {
    key: 'coin-change',
    n: 8,
    title: 'Coin Change',
    summary: 'Fewest coins that make an exact amount, with unlimited coins of each denomination.',
    difficulty: 'medium',
    tags: ['dp'],
    status: 'in_progress',
    created: 47,
    updated: 9,
    languages: COMMON,
    reference: String.raw`import sys


def main() -> None:
    data = sys.stdin.read().split()
    n, amount = int(data[0]), int(data[1])
    coins = [int(x) for x in data[2:2 + n]]
    inf = float("inf")
    best = [0] + [inf] * amount
    for a in range(1, amount + 1):
        for c in coins:
            if c <= a and best[a - c] + 1 < best[a]:
                best[a] = best[a - c] + 1
    print(best[amount] if best[amount] != inf else -1)


main()
`,
    cases: [
      { name: 'Example 1', stdin: '3 11\n1 2 5\n', out: '3\n', sample: true, verified: true },
      { name: 'Example 2', stdin: '1 3\n2\n', out: '-1\n', sample: true, verified: true },
      { name: 'Zero amount', stdin: '1 0\n1\n', out: '0\n', verified: true },
      { name: 'Greedy fails', stdin: '3 6\n1 3 4\n', out: '2\n', verified: true },
      { name: 'Parity makes it impossible', stdin: '2 7\n2 4\n', out: '-1\n', origin: 'ai', verified: true },
      { name: 'Coins of a real currency', stdin: '4 63\n1 5 10 25\n', out: '6\n', origin: 'ai', verified: true },
    ],
    collections: ['dp', 'interview'],
  },
  {
    key: 'lis',
    n: 9,
    title: 'Longest Increasing Subsequence',
    summary: 'Length of the longest strictly increasing subsequence, fast enough for a hundred thousand elements.',
    difficulty: 'medium',
    tags: ['dp', 'binary-search'],
    status: 'todo',
    favorite: true,
    created: 41,
    updated: 41,
    sourceUrl: 'https://cp-algorithms.com/sequences/longest_increasing_subsequence.html',
    languages: COMMON,
    reference: String.raw`import sys
from bisect import bisect_left


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    tails = []
    for x in map(int, data[1:1 + n]):
        i = bisect_left(tails, x)
        if i == len(tails):
            tails.append(x)
        else:
            tails[i] = x
    print(len(tails))


main()
`,
    cases: [
      { name: 'Example 1', stdin: '8\n10 9 2 5 3 7 101 18\n', out: '4\n', sample: true, verified: true },
      { name: 'Example 2', stdin: '7\n7 7 7 7 7 7 7\n', out: '1\n', sample: true, verified: true },
      { name: 'Zig-zag', stdin: '6\n0 1 0 3 2 3\n', out: '4\n', verified: true },
      { name: 'Single element', stdin: '1\n42\n', out: '1\n', origin: 'ai', verified: true },
      { name: 'Already increasing', stdin: '5\n1 2 3 4 5\n', out: '5\n', origin: 'ai', verified: true },
      { name: 'Strictly decreasing', stdin: '5\n5 4 3 2 1\n', out: '1\n', origin: 'ai', verified: true },
    ],
    collections: ['dp'],
  },
  {
    key: 'edit-distance',
    n: 10,
    title: 'Edit Distance',
    summary: 'Minimum number of insertions, deletions and replacements that turn one word into another.',
    difficulty: 'hard',
    tags: ['dp', 'string'],
    status: 'todo',
    created: 27,
    updated: 27,
    languages: ['python', 'cpp', 'java'],
    reference: String.raw`import sys


def main() -> None:
    a, b = sys.stdin.read().split()[:2]
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    print(prev[-1])


main()
`,
    cases: [
      { name: 'Example 1', stdin: 'horse\nros\n', out: '3\n', sample: true, verified: true },
      { name: 'Example 2', stdin: 'intention\nexecution\n', out: '5\n', sample: true, verified: true },
      { name: 'Identical words', stdin: 'abc\nabc\n', out: '0\n', verified: true },
      { name: 'Classic', stdin: 'kitten\nsitting\n', out: '3\n', verified: true },
      { name: 'One replacement', stdin: 'a\nb\n', out: '1\n', origin: 'ai', verified: false },
      { name: 'Insertions in the middle', stdin: 'sunday\nsaturday\n', out: '3\n', origin: 'ai', verified: false },
    ],
    collections: ['dp'],
  },
  {
    key: 'islands',
    n: 11,
    title: 'Number of Islands',
    summary: 'Count the connected groups of land cells in a grid.',
    difficulty: 'medium',
    tags: ['graph', 'bfs'],
    status: 'done',
    created: 76,
    updated: 70,
    languages: COMMON,
    reference: String.raw`import sys
from collections import deque


def main() -> None:
    data = sys.stdin.read().split()
    r, c = int(data[0]), int(data[1])
    grid = [list(row) for row in data[2:2 + r]]
    islands = 0
    for i in range(r):
        for j in range(c):
            if grid[i][j] != "1":
                continue
            islands += 1
            grid[i][j] = "0"
            queue = deque([(i, j)])
            while queue:
                y, x = queue.popleft()
                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= ny < r and 0 <= nx < c and grid[ny][nx] == "1":
                        grid[ny][nx] = "0"
                        queue.append((ny, nx))
    print(islands)


main()
`,
    cases: [
      { name: 'Example 1', stdin: '4 5\n11000\n11000\n00100\n00011\n', out: '3\n', sample: true, verified: true },
      { name: 'Example 2', stdin: '3 3\n101\n010\n101\n', out: '5\n', sample: true, verified: true },
      { name: 'One big island', stdin: '4 5\n11110\n11010\n11000\n00000\n', out: '1\n', verified: true },
      { name: 'Only water', stdin: '1 1\n0\n', out: '0\n', verified: true },
      { name: 'All land', stdin: '2 4\n1111\n1111\n', out: '1\n', origin: 'ai', verified: true },
    ],
    collections: ['graphs', 'interview'],
  },
  {
    key: 'network-delay',
    n: 12,
    title: 'Network Delay Time',
    summary: 'Time for a signal to reach every node of a weighted directed graph — single-source shortest paths.',
    difficulty: 'medium',
    tags: ['graph', 'heap'],
    status: 'in_progress',
    created: 16,
    updated: 5,
    languages: COMMON,
    reference: String.raw`import heapq
import sys


def main() -> None:
    data = sys.stdin.read().split()
    n, m, k = int(data[0]), int(data[1]), int(data[2])
    graph = [[] for _ in range(n + 1)]
    for i in range(m):
        u, v, w = (int(x) for x in data[3 + 3 * i:6 + 3 * i])
        graph[u].append((v, w))
    dist = [None] * (n + 1)
    heap = [(0, k)]
    while heap:
        d, u = heapq.heappop(heap)
        if dist[u] is not None:
            continue
        dist[u] = d
        for v, w in graph[u]:
            if dist[v] is None:
                heapq.heappush(heap, (d + w, v))
    reached = dist[1:]
    print(-1 if any(d is None for d in reached) else max(reached))


main()
`,
    cases: [
      { name: 'Example 1', stdin: '4 3 2\n2 1 1\n2 3 1\n3 4 1\n', out: '2\n', sample: true, verified: true },
      { name: 'Example 2', stdin: '2 1 2\n1 2 1\n', out: '-1\n', sample: true, verified: true },
      { name: 'Single link', stdin: '2 1 1\n1 2 1\n', out: '1\n', verified: true },
      {
        name: 'Shorter path through more hops',
        stdin: '5 6 1\n1 2 2\n1 3 5\n2 3 1\n3 4 2\n2 4 7\n4 5 1\n',
        out: '6\n',
        origin: 'ai',
        verified: true,
      },
      { name: 'Single node', stdin: '1 0 1\n', out: '0\n', origin: 'ai', verified: true },
    ],
    collections: ['graphs', 'weekly'],
  },
  {
    key: 'lru-cache',
    n: 13,
    title: 'LRU Cache',
    summary: 'Simulate a fixed-capacity cache that evicts the least recently used key.',
    difficulty: 'medium',
    tags: ['design', 'hash-map'],
    status: 'todo',
    created: 8,
    updated: 2,
    revision: 2,
    rawInput:
      'LRU cache: get(key) and put(key, value) both O(1), capacity fixed, evict least recently used. they wanted the doubly linked list + hashmap version, not OrderedDict',
    languages: COMMON,
    reference: String.raw`import sys
from collections import OrderedDict


def main() -> None:
    lines = sys.stdin.read().splitlines()
    capacity, q = (int(x) for x in lines[0].split())
    cache = OrderedDict()
    out = []
    for line in lines[1:1 + q]:
        parts = line.split()
        if parts[0] == "get":
            key = int(parts[1])
            if key in cache:
                cache.move_to_end(key)
                out.append(str(cache[key]))
            else:
                out.append("-1")
        else:
            key, value = int(parts[1]), int(parts[2])
            cache[key] = value
            cache.move_to_end(key)
            if len(cache) > capacity:
                cache.popitem(last=False)
    print("\n".join(out))


main()
`,
    cases: [
      {
        name: 'Example 1',
        stdin: '2 9\nput 1 1\nput 2 2\nget 1\nput 3 3\nget 2\nput 4 4\nget 1\nget 3\nget 4\n',
        out: '1\n-1\n-1\n3\n4\n',
        sample: true,
        origin: 'ai',
        verified: true,
      },
      {
        name: 'Capacity one',
        stdin: '1 5\nput 1 10\nget 1\nput 2 20\nget 1\nget 2\n',
        out: '10\n-1\n20\n',
        origin: 'ai',
        verified: true,
      },
      {
        name: 'Overwrite refreshes recency',
        stdin: '2 6\nput 1 1\nput 2 2\nput 1 5\nput 3 3\nget 1\nget 2\n',
        out: '5\n-1\n',
        origin: 'ai',
        verified: true,
      },
      { name: 'Miss before any put', stdin: '3 4\nget 7\nput 7 70\nget 7\nget 8\n', out: '-1\n70\n-1\n', origin: 'ai', verified: true },
    ],
    collections: ['interview'],
  },
  // The one "solution only" problem: the solver writes a method, and a hidden runner does the input and output.
  {
    key: 'merge-k-lists',
    n: 25,
    title: 'Merge k Sorted Lists',
    summary: 'Merge k sorted linked lists into one sorted list.',
    difficulty: 'hard',
    tags: ['heap', 'linked-list'],
    status: 'todo',
    created: 4,
    updated: 4,
    sourceNote: 'Onsite, second round',
    languages: [],
    solutionOnly: { starterCode: MERGE_K_LISTS_STARTER, harness: MERGE_K_LISTS_HARNESS },
    reference: MERGE_K_LISTS_REFERENCE,
    cases: [
      { name: 'Example 1', stdin: '[[1,4,5],[1,3,4],[2,6]]\n', out: '[1,1,2,3,4,4,5,6]\n', sample: true, verified: true },
      { name: 'Example 2', stdin: '[]\n', out: '[]\n', sample: true, verified: true },
      { name: 'Example 3', stdin: '[[]]\n', out: '[]\n', sample: true, verified: true },
      { name: 'A single list', stdin: '[[1,2,3]]\n', out: '[1,2,3]\n', verified: true },
      { name: 'Empty lists among the others', stdin: '[[],[2],[],[1,3]]\n', out: '[1,2,3]\n', origin: 'ai', verified: true },
      { name: 'Negative values', stdin: '[[-5,-1,0],[-3,2],[-4]]\n', out: '[-5,-4,-3,-1,0,2]\n', origin: 'ai', verified: true },
      { name: 'Equal values across lists', stdin: '[[1,1],[1,1],[1]]\n', out: '[1,1,1,1,1]\n', origin: 'ai', verified: true },
    ],
    collections: ['interview'],
  },
  // The next three are rough fragments, the way many entries start out.
  {
    key: 'kth-largest-stream',
    n: 14,
    title: 'k-th largest in a stream',
    summary: '',
    difficulty: null,
    tags: ['heap'],
    status: 'todo',
    created: 6,
    updated: 6,
    languages: [],
    cases: [],
    collections: [],
  },
  {
    key: 'trapping-rain-water',
    n: 15,
    title: 'Trapping rain water (from memory)',
    summary: '',
    difficulty: null,
    tags: ['array', 'two-pointers'],
    status: 'todo',
    created: 13,
    updated: 13,
    languages: [],
    cases: [],
    collections: ['weekly'],
  },
  {
    key: 'rate-limiter',
    n: 16,
    title: 'Sliding-window rate limiter',
    summary: 'Allow at most K requests per user in any window of W seconds.',
    difficulty: null,
    tags: ['design', 'sliding-window'],
    status: 'todo',
    created: 1,
    updated: 1,
    sourceNote: 'Phone screen',
    languages: [],
    cases: [],
    collections: [],
  },
];
