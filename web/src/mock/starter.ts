// The mock's reference solutions for when a problem has none in the language
// asked for. The generic starter code is in lib/starterTemplates.ts, shared
// with the editor.
//
// Everything here has to compile and run on the judge's toolchains, which are
// old (see JUDGE_LANGUAGES in db.ts): Python 3.8, GCC 9.2, Java 13, Go 1.13,
// Node.js 12, TypeScript 3.7, Rust 1.40. No newer language features.

export { starterCode } from '../lib/starterTemplates';

const SOLUTIONS: Record<string, string> = {
  python: String.raw`import sys


def solve(tokens) -> str:
    n = int(tokens[0])
    values = [int(t) for t in tokens[1:1 + n]]
    # Straightforward and obviously correct rather than clever: this is the
    # oracle the test cases are checked against.
    best = values[0]
    running = 0
    for v in values:
        running = max(v, running + v)
        best = max(best, running)
    return str(best)


if __name__ == "__main__":
    print(solve(sys.stdin.read().split()))
`,
  cpp: String.raw`#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    cin >> n;
    vector<long long> values(n);
    for (auto &v : values) cin >> v;

    // Straightforward and obviously correct rather than clever: this is the
    // oracle the test cases are checked against.
    long long best = values[0], running = 0;
    for (long long v : values) {
        running = max(v, running + v);
        best = max(best, running);
    }
    cout << best << "\n";
    return 0;
}
`,
  java: String.raw`import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedReader(new InputStreamReader(System.in)));
        in.nextToken();
        int n = (int) in.nval;
        long best = Long.MIN_VALUE, running = 0;
        for (int i = 0; i < n; i++) {
            in.nextToken();
            long v = (long) in.nval;
            running = Math.max(v, running + v);
            best = Math.max(best, running);
        }
        System.out.println(best);
    }
}
`,
  javascript: String.raw`const tokens = require("fs").readFileSync(0, "utf8").split(/\s+/).filter(Boolean);

const n = Number(tokens[0]);
const values = tokens.slice(1, 1 + n).map(Number);

// Straightforward and obviously correct rather than clever: this is the
// oracle the test cases are checked against.
let best = values[0];
let running = 0;
for (const v of values) {
  running = Math.max(v, running + v);
  best = Math.max(best, running);
}
console.log(String(best));
`,
  go: String.raw`package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	var n int
	fmt.Fscan(in, &n)
	values := make([]int64, n)
	for i := range values {
		fmt.Fscan(in, &values[i])
	}

	// Straightforward and obviously correct rather than clever: this is the
	// oracle the test cases are checked against.
	best, running := values[0], int64(0)
	for _, v := range values {
		if running < 0 {
			running = 0
		}
		running += v
		if running > best {
			best = running
		}
	}
	fmt.Println(best)
}
`,
};

/** A believable reference solution for when a problem has none in the requested language. */
export function genericSolution(language: string): string {
  return SOLUTIONS[language] ?? SOLUTIONS.python!.replace(/^/, `# Written in Python: no ${language} template is available in the mock.\n`);
}
