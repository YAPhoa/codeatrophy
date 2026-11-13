# Solution-only problems

Read this before creating or editing a problem whose `problem.interface` is `function`.

In a solution-only problem the solver sees a stub — a function or class to fill in — and nothing else. The judge still works on stdin and stdout: for each language, hidden **runner** code is placed around the solver's code to make a complete program.

```
program that runs  =  runner prefix
                      + the solver's code
                      + runner suffix
```

Per language you write three things:

| Part | Field | Who sees it |
| --- | --- | --- |
| Starter stub | `problem.starterCode[language]` | The solver; it is what the editor opens with |
| Runner prefix | `problem.harness[language].prefix` | Hidden unless they choose to look |
| Runner suffix | `problem.harness[language].suffix` | Hidden unless they choose to look |

A language without a `harness` entry cannot be used for that problem, so give every language you write a stub for a runner too.

## The stub

Give exactly what is needed to start, and no logic:

- the class and method (or function) with a precise signature and type hints;
- helper types the signature mentions (list nodes, tree nodes) **described in a comment**, because their real definition lives in the prefix — defining them again in the stub would be a duplicate;
- a placeholder body with no logic, so that the stub compiles and runs as it stands and an untouched stub ends in a plain wrong answer: `pass` in Python, a typed zero value elsewhere (`return 0;`, `return {};`, `return nullptr;`, `return null;` …).

```python
# Definition for singly-linked list.
# class ListNode:
#     def __init__(self, val=0, next=None):
#         self.val = val
#         self.next = next
class Solution:
    def mergeKLists(self, lists: list[ListNode | None]) -> ListNode | None:
        pass
```

## The prefix

Everything the solver's code relies on but should not have to write: imports, and the real definitions of the helper types the stub describes.

Write for the judge's actual versions (see `get_overview`), not the newest language. The common trap is Python: on Python 3.8, annotations such as `list[int]` or `ListNode | None` fail when the class is defined. Start the Python prefix with `from __future__ import annotations` — it must be the first statement of the file, which the prefix is — and such hints are then never evaluated.

## The suffix

Reads one test case from stdin, builds the arguments, calls the solution once, prints the result.

- **Input format:** one JSON value per line, one line per argument, in signature order. A linked list or a tree is written as the array a person would write (`[1,4,5]`, `[3,9,20,null,null,15,7]`), and the suffix converts it.
- **Output format:** one compact JSON value on one line (no spaces: `[1,2,3]`, because output is compared token by token). Convert structures back to arrays; print booleans as `true`/`false` and `null` for nothing, so the output is the same in every language.
- **When several answers are valid,** the statement must fix which one counts, or the suffix must normalise the result (sort it) before printing — otherwise a correct solution fails.
- **Keep it boring.** No output besides the answer, no assumptions about the solver's helper names, and it must not crash on the smallest input.

For a class with several operations (an LRU cache, a queue), the input is two lines — the operation names and their argument lists — and the output is the list of results, with `null` for operations that return nothing.

## Languages

- **Python:** prefix = future import, imports, helper classes; suffix = parsing and the call under `if __name__ == "__main__":`.
- **Java:** the file is compiled as `Main.java`. Put `import` lines and helper classes in the prefix, leave the solver's `class Solution` non-public, and put `public class Main` with `main` in the suffix. Java has no JSON parser in its standard library, so the suffix parses the simple shapes it needs by hand.
- **C++:** includes, `using namespace std;` if the stub relies on it, and helper structs in the prefix; `main` in the suffix.
- **Go, JavaScript, TypeScript and the others:** the same split — declarations before, the driver after.

## Check it before you call it done

A runner is code nobody will read, so it has to be proven by running:

1. Save a reference solution **that is only the solution part**, exactly as a solver would write it.
2. Add the statement's examples as sample cases in the JSON-per-line format and run `verify_test_cases`. Their outputs must equal the examples in the statement.
3. Run the unchanged stub with `run_code`. It should run and end in a plain wrong answer; a compile error or a crash means the stub or the runner is wrong. Line numbers in errors are the solver's own; a location inside the runner shows as `<runner prefix>` or `<runner suffix>` with a line within that part.
4. Do this for every language you wrote a runner for. A runner that was never run is a problem that cannot be solved in that language.

## Changing an existing problem

Switching a full-program problem to solution only means writing stub and runner *and* replacing the reference solution with its solution-only form, then re-verifying. The test cases can stay only if their stdin already matches what the new suffix reads; usually they need rewriting into the JSON-per-line format. Tell the user before doing this to a problem that has submission history.
