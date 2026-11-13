// Fills a MockDb with a library that looks a few months old: problems in
// every state of completeness, long-form readings, nested collections and a
// submission history.

import type { Submission, SubmissionMode, SubmissionResult, Verdict } from '../../api/types';
import type { MockDb, StoredItem } from '../db';
import { DEFAULT_PROBLEM } from '../db';
import { finish } from '../handlers/submissions';
import { resourceUsage } from '../judge';
import { starterCode } from '../starter';
import type { SeedProblem } from './problems';
import { SEED_PROBLEMS } from './problems';
import { SEED_READINGS } from './readings';
import { SEED_SOLUTIONS } from './solutions';

const pad = (n: number) => String(n).padStart(12, '0');
const itemId = (n: number) => `11111111-1111-4111-8111-${pad(n)}`;
const collectionId = (n: number) => `22222222-2222-4222-8222-${pad(n)}`;
const testCaseId = (item: number, index: number) => `33333333-3333-4333-8333-${pad(item * 100 + index)}`;
const submissionId = (n: number) => `44444444-4444-4444-8444-${pad(n)}`;
const styleId = (n: number) => `55555555-5555-4555-8555-${pad(n)}`;
const solutionId = (item: number, index: number) => `66666666-6666-4666-8666-${pad(item * 100 + index)}`;

/** Fixed ids of seed records, for tests and scripts. */
export const seedIds = {
  items: {
    twoSum: itemId(1),
    twoSumSorted: itemId(2),
    countPairs: itemId(3),
    validParentheses: itemId(4),
    longestSubstring: itemId(5),
    mergeIntervals: itemId(6),
    firstOccurrence: itemId(7),
    coinChange: itemId(8),
    lis: itemId(9),
    editDistance: itemId(10),
    islands: itemId(11),
    networkDelay: itemId(12),
    lruCache: itemId(13),
    kthLargestStream: itemId(14),
    trappingRainWater: itemId(15),
    rateLimiter: itemId(16),
    /** The "solution only" problem, with a stub and a runner for Python and Java. */
    mergeKLists: itemId(25),
    consistentHashing: itemId(17),
    bTrees: itemId(18),
    capTheorem: itemId(19),
    goScheduler: itemId(20),
    amortisedAnalysis: itemId(21),
    walFsync: itemId(22),
    untrustedMarkdown: itemId(23),
    raftLeaderElection: itemId(24),
  },
  collections: {
    interviewPrep: collectionId(1),
    arraysAndHashing: collectionId(2),
    dynamicProgramming: collectionId(3),
    graphs: collectionId(4),
    systemsReading: collectionId(5),
    databases: collectionId(6),
    distributedSystems: collectionId(7),
    weeklyPractice: collectionId(8),
  },
  testCases: {
    /** Stored expected output is wrong; verification reports a mismatch. */
    mergeIntervalsWrongExpected: testCaseId(6, 4),
  },
  submissions: {
    twoSumAccepted: submissionId(2),
    longestSubstringWrongAnswer: submissionId(8),
    coinChangeWrongAnswer: submissionId(11),
    networkDelayRuntimeError: submissionId(13),
    lruCacheCompileError: submissionId(14),
  },
  styles: {
    leetcode: styleId(1),
    terse: styleId(2),
  },
  solutions: {
    /** The reference solution of Two Sum, in Python. */
    twoSumHashMap: solutionId(1, 1),
    twoSumBruteForce: solutionId(1, 2),
    twoSumCpp: solutionId(1, 3),
    coinChangeTable: solutionId(8, 1),
    coinChangeMemoised: solutionId(8, 2),
    coinChangeBfs: solutionId(8, 3),
  },
} as const;

const CONTENT = import.meta.glob<string>('./content/*.md', { query: '?raw', import: 'default', eager: true });

/** The Markdown body stored under ./content for a seed key. */
export function seedBody(key: string): string {
  const body = CONTENT[`./content/${key}.md`];
  if (body === undefined) throw new Error(`missing seed content: ${key}`);
  return body;
}

interface SeedCollection {
  key: string;
  n: number;
  name: string;
  description: string;
  parent: string | null;
}

const COLLECTIONS: SeedCollection[] = [
  { key: 'interview', n: 1, name: 'Interview prep', description: 'The core set to be fluent in before the next loop.', parent: null },
  { key: 'arrays', n: 2, name: 'Arrays & hashing', description: '', parent: 'interview' },
  { key: 'dp', n: 3, name: 'Dynamic programming', description: 'State, transition, order of evaluation.', parent: 'interview' },
  { key: 'graphs', n: 4, name: 'Graphs', description: '', parent: 'interview' },
  { key: 'systems', n: 5, name: 'Systems reading', description: 'Notes on how the things underneath work.', parent: null },
  { key: 'databases', n: 6, name: 'Databases', description: '', parent: 'systems' },
  { key: 'distributed', n: 7, name: 'Distributed systems', description: '', parent: 'systems' },
  { key: 'weekly', n: 8, name: 'Weekly practice', description: 'This week: three to solve, one to write up.', parent: null },
];

const DAY = 86_400_000;

interface SeedSubmission {
  n: number;
  item: string;
  mode: SubmissionMode;
  language: string;
  /** Age in days; fractions place several attempts on the same day. */
  age: number;
  source: string;
  /** Wrong outputs by test case name. */
  wrong?: Record<string, string>;
  /** Every case fails this way. */
  crash?: { verdict: Verdict; stderr: (caseName: string) => string };
  compileOutput?: string;
}

const SUBMISSIONS: SeedSubmission[] = [
  {
    n: 1,
    item: 'two-sum',
    mode: 'run',
    language: 'python',
    age: 96.1,
    source: String.raw`import sys

data = sys.stdin.read().split()
n = int(data[0])
nums = list(map(int, data[1:1 + n]))
target = int(data[1 + n])

seen = {}
for i, x in enumerate(nums):
    if target - x in seen:
        print(seen[target - x], i)
        break
    seen[x] = i
`,
  },
  {
    n: 2,
    item: 'two-sum',
    mode: 'submit',
    language: 'python',
    age: 96.09,
    source: String.raw`import sys

data = sys.stdin.read().split()
n = int(data[0])
nums = list(map(int, data[1:1 + n]))
target = int(data[1 + n])

seen = {}
for i, x in enumerate(nums):
    if target - x in seen:
        print(seen[target - x], i)
        break
    seen[x] = i
`,
  },
  {
    n: 3,
    item: 'two-sum',
    mode: 'submit',
    language: 'go',
    age: 40.3,
    source: String.raw`package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	var n int
	fmt.Fscan(in, &n)
	nums := make([]int, n)
	for i := range nums {
		fmt.Fscan(in, &nums[i])
	}
	var target int
	fmt.Fscan(in, &target)

	seen := make(map[int]int, n)
	for i, x := range nums {
		if j, ok := seen[target-x]; ok {
			fmt.Println(j, i)
			return
		}
		seen[x] = i
	}
}
`,
  },
  {
    n: 4,
    item: 'valid-parentheses',
    mode: 'submit',
    language: 'python',
    age: 108.2,
    wrong: { Unclosed: 'true\n' },
    source: String.raw`import sys

s = sys.stdin.readline().strip()
pairs = {")": "(", "]": "[", "}": "{"}
stack = []
ok = True
for ch in s:
    if ch in pairs:
        if not stack or stack.pop() != pairs[ch]:
            ok = False
            break
    else:
        stack.append(ch)
print("true" if ok else "false")
`,
  },
  {
    n: 5,
    item: 'valid-parentheses',
    mode: 'submit',
    language: 'python',
    age: 108.19,
    source: String.raw`import sys

s = sys.stdin.readline().strip()
pairs = {")": "(", "]": "[", "}": "{"}
stack = []
ok = True
for ch in s:
    if ch in pairs:
        if not stack or stack.pop() != pairs[ch]:
            ok = False
            break
    else:
        stack.append(ch)
print("true" if ok and not stack else "false")
`,
  },
  {
    n: 6,
    item: 'longest-substring',
    mode: 'run',
    language: 'python',
    age: 9.4,
    source: String.raw`import sys

s = sys.stdin.readline().strip()
last = {}
left = 0
best = 0
for i, ch in enumerate(s):
    if ch in last:
        left = last[ch] + 1
    last[ch] = i
    best = max(best, i - left + 1)
print(best)
`,
  },
  {
    n: 7,
    item: 'longest-substring',
    mode: 'submit',
    language: 'python',
    age: 9.39,
    wrong: { 'Repeat behind the window': '3\n', 'Repeat at both ends': '6\n' },
    source: String.raw`import sys

s = sys.stdin.readline().strip()
last = {}
left = 0
best = 0
for i, ch in enumerate(s):
    if ch in last:
        left = last[ch] + 1
    last[ch] = i
    best = max(best, i - left + 1)
print(best)
`,
  },
  {
    n: 8,
    item: 'longest-substring',
    mode: 'submit',
    language: 'cpp',
    age: 3.1,
    wrong: { 'Repeat behind the window': '3\n', 'Repeat at both ends': '6\n' },
    source: String.raw`#include <bits/stdc++.h>
using namespace std;

int main() {
    string s;
    cin >> s;
    vector<int> last(128, -1);
    int left = 0, best = 0;
    for (int i = 0; i < (int)s.size(); i++) {
        if (last[s[i]] != -1) left = last[s[i]] + 1;  // still wrong for "abba"?
        last[s[i]] = i;
        best = max(best, i - left + 1);
    }
    cout << best << "\n";
    return 0;
}
`,
  },
  {
    n: 9,
    item: 'islands',
    mode: 'submit',
    language: 'cpp',
    age: 70.2,
    source: String.raw`#include <bits/stdc++.h>
using namespace std;

int main() {
    int r, c;
    cin >> r >> c;
    vector<string> g(r);
    for (auto &row : g) cin >> row;

    int islands = 0;
    const int dy[] = {1, -1, 0, 0}, dx[] = {0, 0, 1, -1};
    for (int i = 0; i < r; i++) {
        for (int j = 0; j < c; j++) {
            if (g[i][j] != '1') continue;
            islands++;
            queue<pair<int, int>> q;
            q.push({i, j});
            g[i][j] = '0';
            while (!q.empty()) {
                auto [y, x] = q.front();
                q.pop();
                for (int d = 0; d < 4; d++) {
                    int ny = y + dy[d], nx = x + dx[d];
                    if (ny < 0 || nx < 0 || ny >= r || nx >= c || g[ny][nx] != '1') continue;
                    g[ny][nx] = '0';
                    q.push({ny, nx});
                }
            }
        }
    }
    cout << islands << "\n";
}
`,
  },
  {
    n: 10,
    item: 'first-occurrence',
    mode: 'submit',
    language: 'java',
    age: 88.5,
    source: String.raw`import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer st = new StringTokenizer(in.readLine());
        int n = Integer.parseInt(st.nextToken()), q = Integer.parseInt(st.nextToken());
        int[] a = new int[n];
        st = new StringTokenizer(in.readLine());
        for (int i = 0; i < n; i++) a[i] = Integer.parseInt(st.nextToken());

        StringBuilder out = new StringBuilder();
        while (q-- > 0) {
            int x = Integer.parseInt(in.readLine().trim());
            int lo = 0, hi = n;
            while (lo < hi) {
                int mid = (lo + hi) >>> 1;
                if (a[mid] < x) lo = mid + 1;
                else hi = mid;
            }
            out.append(lo < n && a[lo] == x ? lo : -1).append('\n');
        }
        System.out.print(out);
    }
}
`,
  },
  {
    n: 11,
    item: 'coin-change',
    mode: 'submit',
    language: 'python',
    age: 9.2,
    wrong: { 'Greedy fails': '3\n' },
    source: String.raw`import sys

data = sys.stdin.read().split()
n, amount = int(data[0]), int(data[1])
coins = sorted(map(int, data[2:2 + n]), reverse=True)

# Greedy: always take the biggest coin that fits.
count = 0
for c in coins:
    count += amount // c
    amount %= c
print(count if amount == 0 else -1)
`,
  },
  {
    n: 12,
    item: 'network-delay',
    mode: 'run',
    language: 'python',
    age: 5.3,
    source: String.raw`import heapq
import sys

data = sys.stdin.read().split()
n, m, k = map(int, data[:3])
graph = {}
for i in range(m):
    u, v, w = map(int, data[3 + 3 * i:6 + 3 * i])
    graph.setdefault(u, []).append((v, w))

dist = {}
heap = [(0, k)]
while heap:
    d, u = heapq.heappop(heap)
    if u in dist:
        continue
    dist[u] = d
    for v, w in graph.get(u, []):
        heapq.heappush(heap, (d + w, v))

print(max(dist.values()) if len(dist) == n else -1)
`,
  },
  {
    n: 13,
    item: 'network-delay',
    mode: 'submit',
    language: 'python',
    age: 5.28,
    crash: {
      verdict: 'runtime_error',
      // The node without outgoing links that each input reaches first.
      stderr: (caseName) =>
        [
          'Traceback (most recent call last):',
          '  File "/box/main.py", line 18, in <module>',
          '    for v, w in graph[u]:',
          '                ~~~~~^^^',
          `KeyError: ${{ 'Example 2': 2, 'Single link': 2, 'Shorter path through more hops': 5 }[caseName] ?? 1}`,
          '',
        ].join('\n'),
    },
    source: String.raw`import heapq
import sys

data = sys.stdin.read().split()
n, m, k = map(int, data[:3])
graph = {}
for i in range(m):
    u, v, w = map(int, data[3 + 3 * i:6 + 3 * i])
    graph.setdefault(u, []).append((v, w))

dist = {}
heap = [(0, k)]
while heap:
    d, u = heapq.heappop(heap)
    if u in dist:
        continue
    dist[u] = d
    for v, w in graph[u]:
        heapq.heappush(heap, (d + w, v))

print(max(dist.values()) if len(dist) == n else -1)
`,
  },
  {
    n: 14,
    item: 'lru-cache',
    mode: 'submit',
    language: 'cpp',
    age: 2.1,
    compileOutput: [
      "main.cpp: In function 'int main()':",
      "main.cpp:21:39: error: 'struct std::pair<long long int, long long int>' has no member named 'value'",
      '   21 |             cout << it->second->value << "\\n";',
      '      |                                 ^~~~~',
      "main.cpp:28:9: error: 'evict' was not declared in this scope",
      '   28 |         evict(order, index);',
      '      |         ^~~~~',
      '',
    ].join('\n'),
    source: String.raw`#include <bits/stdc++.h>
using namespace std;

int main() {
    int capacity, q;
    cin >> capacity >> q;
    list<pair<long long, long long>> order;  // most recent at the front
    unordered_map<long long, list<pair<long long, long long>>::iterator> index;

    while (q--) {
        string op;
        long long k, v;
        cin >> op >> k;
        if (op == "get") {
            auto it = index.find(k);
            if (it == index.end()) {
                cout << -1 << "\n";
                continue;
            }
            order.splice(order.begin(), order, it->second);
            cout << it->second->value << "\n";
            continue;
        }
        cin >> v;
        // TODO: handle an existing key
        order.push_front({k, v});
        index[k] = order.begin();
        if ((int)order.size() > capacity)
        evict(order, index);
    }
}
`,
  },
];

function addProblem(db: MockDb, p: SeedProblem, at: (days: number) => string, collections: Map<string, string[]>): void {
  const id = itemId(p.n);
  const variantOf = p.variantOf ? SEED_PROBLEMS.find((x) => x.key === p.variantOf) : undefined;
  const item: StoredItem = {
    id,
    type: 'problem',
    title: p.title,
    summary: p.summary,
    body: seedBody(p.key),
    difficulty: p.difficulty,
    tags: [...p.tags].sort(),
    status: p.status,
    favorite: p.favorite ?? false,
    notes: p.notes ?? '',
    rawInput: p.rawInput ?? null,
    source: { url: p.sourceUrl ?? null, note: p.sourceNote ?? null },
    problem: p.solutionOnly
      ? { ...structuredClone(DEFAULT_PROBLEM), interface: 'function', ...structuredClone(p.solutionOnly) }
      : { ...structuredClone(DEFAULT_PROBLEM), starterCode: { ...starterCode(p.languages), ...p.starter } },
    variantOf: variantOf ? itemId(variantOf.n) : null,
    revision: p.revision ?? 1,
    createdAt: at(p.created),
    updatedAt: at(p.updated),
    seq: db.nextSeq(),
  };
  db.items.set(id, item);
  p.cases.forEach((c, i) => {
    const caseId = testCaseId(p.n, i + 1);
    db.testCases.push({
      id: caseId,
      itemId: id,
      position: i,
      name: c.name,
      stdin: c.stdin,
      expectedStdout: c.out,
      isSample: c.sample ?? false,
      origin: c.origin ?? 'manual',
      verified: c.verified ?? false,
      createdAt: at(p.created),
      updatedAt: at(p.updated),
    });
    if (c.truth !== undefined) db.truth.set(caseId, c.truth);
  });
  // The reference solution was written with the problem; the other approaches were saved later.
  const set = SEED_SOLUTIONS[p.key];
  const solutions = [
    ...(p.reference
      ? [{ name: 'Reference solution', notes: '', ...set?.reference, language: 'python', source: p.reference, isReference: true }]
      : []),
    ...(set?.others ?? []).map((s) => ({ ...s, isReference: false })),
  ];
  solutions.forEach((s, i) => {
    const createdAt = at(s.isReference ? p.created : p.updated);
    db.solutions.push({ id: solutionId(p.n, i + 1), itemId: id, ...s, createdAt, updatedAt: createdAt, seq: db.nextSeq() });
  });
  for (const key of p.collections) collections.get(key)?.push(id);
}

function addSubmission(db: MockDb, s: SeedSubmission, at: (days: number) => string): void {
  const problem = SEED_PROBLEMS.find((p) => p.key === s.item)!;
  const id = itemId(problem.n);
  const cases = db.casesOf(id).filter((c) => s.mode === 'submit' || c.isSample);
  const createdAt = at(s.age);
  const submission: Submission = {
    id: submissionId(s.n),
    itemId: id,
    mode: s.mode,
    language: s.language,
    source: s.source,
    lineOffset: 0,
    status: 'running',
    verdict: null,
    passedCount: 0,
    totalCount: cases.length,
    timeMs: null,
    memoryKb: null,
    compileOutput: s.compileOutput ?? '',
    error: null,
    results: [],
    createdAt,
    finishedAt: null,
  };
  if (!s.compileOutput) {
    submission.results = cases.map((c, i): SubmissionResult => {
      const usage = resourceUsage(s.language, s.n * 131 + i * 17);
      const wrong = s.wrong?.[c.name];
      const base = {
        testCaseId: c.id,
        name: c.name,
        isSample: c.isSample,
        stdin: c.stdin,
        expectedStdout: c.expectedStdout,
        ...usage,
      };
      if (s.crash) return { ...base, verdict: s.crash.verdict, stdout: '', stderr: s.crash.stderr(c.name) };
      if (wrong !== undefined) return { ...base, verdict: 'wrong_answer', stdout: wrong, stderr: '' };
      return { ...base, verdict: 'accepted', stdout: c.expectedStdout, stderr: '' };
    });
  }
  // Finishing must not disturb the item's seeded status, so restore it afterwards.
  const item = db.getItem(id);
  const status = item.status;
  finish(db, submission, createdAt, s.compileOutput ? 'compile_error' : undefined);
  item.status = status;
  db.submissions.push(submission);
}

/** Populate `db` with the seed library. */
export function seedDatabase(db: MockDb): void {
  const start = Date.now();
  const at = (days: number) => new Date(start - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const members = new Map<string, string[]>(COLLECTIONS.map((c) => [c.key, []]));

  for (const p of SEED_PROBLEMS) addProblem(db, p, at, members);
  for (const r of SEED_READINGS) {
    const id = itemId(r.n);
    db.items.set(id, {
      id,
      type: 'reading',
      title: r.title,
      summary: r.summary,
      body: seedBody(r.key),
      difficulty: null,
      tags: [...r.tags].sort(),
      status: r.status,
      favorite: r.favorite ?? false,
      notes: r.notes ?? '',
      rawInput: null,
      source: { url: r.sourceUrl ?? null, note: r.sourceNote ?? null },
      problem: null,
      variantOf: null,
      revision: r.revision ?? 1,
      createdAt: at(r.created),
      updatedAt: at(r.updated),
      seq: db.nextSeq(),
    });
    for (const key of r.collections) members.get(key)?.push(id);
  }

  const positions = new Map<string | null, number>();
  for (const c of COLLECTIONS) {
    const position = positions.get(c.parent) ?? 0;
    positions.set(c.parent, position + 1);
    const parent = COLLECTIONS.find((x) => x.key === c.parent);
    db.collections.push({
      id: collectionId(c.n),
      name: c.name,
      description: c.description,
      parentId: parent ? collectionId(parent.n) : null,
      position,
      itemIds: members.get(c.key) ?? [],
      createdAt: at(120),
      updatedAt: at(120),
    });
  }

  for (const s of [...SUBMISSIONS].sort((a, b) => b.age - a.age)) addSubmission(db, s, at);
}

/** The style presets a seeded instance starts with. */
export function seedStyles(db: MockDb): void {
  const createdAt = new Date(Date.now() - 45 * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.styles.push(
    {
      id: styleId(1),
      name: 'LeetCode style',
      instructions:
        'Short description, then Example blocks with Input / Output / Explanation, then a Constraints list. Starter code in Python and Go only.',
      isDefault: true,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: styleId(2),
      name: 'Terse contest style',
      instructions:
        'Terse, like a programming-contest statement: two or three sentences, then Input, Output and Constraints sections, then examples without explanations. No hints, notes or follow-ups. Starter code in C++ and Python only.',
      isDefault: false,
      createdAt,
      updatedAt: createdAt,
    },
  );
}
