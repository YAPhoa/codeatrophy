// Language-agnostic starter code: skeletons that read stdin and leave the
// solving to the user. The mock's seed library and drafts use them, and the
// editor tells a starter that is still one of them from code written for the
// problem. The lines that only read the input are marked as a folded region
// (`# region input` … `# endregion`), as the server asks AI providers to do.
//
// Everything here has to compile and run on the judge's toolchains, which are
// old: Python 3.8, GCC 9.2, Java 13, Go 1.13, Node.js 12, TypeScript 3.7,
// Rust 1.40. No newer language features.

const TEMPLATES: Record<string, string> = {
  python: String.raw`import sys


def solve() -> None:
    # region input
    data = sys.stdin.read().split()
    # endregion
    # TODO: parse the input and print the answer


if __name__ == "__main__":
    solve()
`,
  cpp: String.raw`#include <bits/stdc++.h>
using namespace std;

int main() {
    // region input
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    // endregion

    // TODO: read the input and print the answer

    return 0;
}
`,
  c: String.raw`#include <stdio.h>
#include <stdlib.h>

int main(void) {
    /* TODO: read the input with scanf and print the answer */

    return 0;
}
`,
  java: String.raw`import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        // region input
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        // endregion
        // TODO: read the input and print the answer
    }
}
`,
  javascript: String.raw`// region input
const lines = require("fs").readFileSync(0, "utf8").split("\n");
// endregion

// TODO: parse the lines and print the answer with console.log
`,
  typescript: String.raw`import { readFileSync } from "fs";

// region input
const lines: string[] = readFileSync(0, "utf8").split("\n");
// endregion

// TODO: parse the lines and print the answer with console.log
`,
  go: String.raw`package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	// region input
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	// endregion

	// TODO: read the input with fmt.Fscan(in, &x) and print the answer
	_ = in
	fmt.Fprintln(out)
}
`,
  rust: String.raw`use std::io::{self, Read};

fn main() {
    // region input
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut tokens = input.split_ascii_whitespace();
    // endregion

    // TODO: parse the tokens and print the answer
    let _ = tokens.next();
}
`,
};

/** Generic starter code for each of `languages` that has a template. */
export function starterCode(languages: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const language of languages) {
    const template = TEMPLATES[language];
    if (template !== undefined) out[language] = template;
  }
  return out;
}

/** Text compared without regard to indentation, blank lines or line endings. */
const shape = (code: string): string =>
  code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');

/** Whether a language's starter code is blank or still its generic skeleton, so that nothing written for the problem would be lost by replacing it. */
export function isGenericStarter(language: string, code: string): boolean {
  if (code.trim() === '') return true;
  const template = TEMPLATES[language];
  return template !== undefined && shape(template) === shape(code);
}
