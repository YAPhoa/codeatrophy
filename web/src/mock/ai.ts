// A pretend AI provider: deterministic text manipulation that returns drafts
// in the shapes the real endpoints produce. A few well-known inputs get
// polished canned drafts; everything else is built from the text itself.

import type {
  AiTestCasesResponse,
  CheckedCase,
  Difficulty,
  DraftCheck,
  DraftProblemSpec,
  DraftTestCase,
  HarnessCode,
  InterfaceHint,
  ItemDraft,
  ProblemInterface,
  ProposedTestCase,
  RunnerCheck,
  SourceCode,
  StylePreset,
  VariantMode,
} from '../api/types';
import type { MockDb, StoredItem } from './db';
import { JUDGE_LANGUAGES } from './db';
import type { Signature } from './harness';
import { assemble, functionKit } from './harness';
import { invalid, isRecord, isStringArray } from './http';
import { detectBehaviour, perturbOutput } from './judge';
import { seedBody } from './seed';
import { SEED_PROBLEMS } from './seed/problems';
import { genericSolution, starterCode } from './starter';
import { hash32, isLanguage, titleCase } from './util';

const DRAFT_LANGUAGES = ['python', 'cpp', 'java', 'javascript', 'go'];

// ---- Canned drafts ------------------------------------------------------------

const CANNED: { pattern: RegExp; key: string; assumptions: string[] }[] = [
  {
    pattern: /two[\s-]?sum/i,
    key: 'two-sum',
    assumptions: [
      'Your text did not say whether indices are 0-based or 1-based; I chose 0-based.',
      'No constraints were given; assumed 2 ≤ n ≤ 10^5 with values up to 10^9 in magnitude.',
      'Assumed exactly one valid pair exists, so the expected output is unique.',
      'Chose an input layout: n, then the array on one line, then the target on its own line.',
    ],
  },
  {
    pattern: /parenthes|bracket/i,
    key: 'valid-parentheses',
    assumptions: [
      'Assumed three kinds of brackets: (), [] and {}.',
      'Assumed the input is one non-empty line of at most 10^5 characters and contains nothing but brackets.',
      'The output format (lower-case "true" / "false") is my choice.',
    ],
  },
  {
    pattern: /\blru\b/i,
    key: 'lru-cache',
    assumptions: [
      'The usual formulation is a class with get and put methods; I recast it as a list of operations on stdin so it can be judged by its output.',
      'Assumed "get" on a missing key prints -1.',
      'Assumed "put" on an existing key replaces the value and counts as a use.',
      'The limits (capacity ≤ 10^5, at most 2·10^5 operations) are assumed.',
    ],
  },
  {
    pattern: /binary[\s-]?search/i,
    key: 'first-occurrence',
    assumptions: [
      'You did not say which position to report when the value repeats; I asked for the first occurrence.',
      'Added several queries per test so that a linear scan per query is too slow.',
      'Assumed 0-based indices, and -1 for a value that is absent.',
      'The limits (n, q ≤ 10^5) are assumed.',
    ],
  },
];

/** A drafted problem's settings as a complete program, with the model's own solution. */
function programSpec(reference: string): DraftProblemSpec {
  return {
    interface: 'program',
    timeLimitMs: 2000,
    memoryLimitKb: 262144,
    compare: 'tokens',
    starterCode: starterCode(DRAFT_LANGUAGES),
    harness: {},
    referenceSolution: { language: 'python', source: reference },
  };
}

function cannedDraft(key: string, assumptions: string[]): ItemDraft {
  const p = SEED_PROBLEMS.find((x) => x.key === key)!;
  return {
    type: 'problem',
    title: p.title,
    summary: p.summary,
    body: seedBody(key),
    difficulty: p.difficulty,
    tags: [...p.tags].sort(),
    problem: programSpec(p.reference ?? genericSolution('python')),
    testCases: p.cases
      .filter((c) => c.sample)
      .map((c, i) => ({ name: `Example ${i + 1}`, stdin: c.stdin, expectedStdout: c.out, isSample: true, verified: false })),
    assumptions: [...assumptions],
  };
}

// ---- "Solution only" drafts -----------------------------------------------------
//
// What the model writes when a problem is about one routine: a signature, a
// statement in terms of its arguments, a stub and a hidden runner per
// language, and examples as one JSON value per line.

interface FunctionForm {
  signature: Signature;
  body: string;
  /** Input lines (one JSON value per argument) and the expected JSON value. */
  examples: [stdin: string, out: string][];
  /** The solution part, in Python. */
  solution: string;
}

const FUNCTION_FORMS: Record<string, FunctionForm> = {
  'two-sum': {
    signature: { name: 'twoSum', params: [{ name: 'nums', type: 'int[]' }, { name: 'target', type: 'int' }], returns: 'int[]' },
    body: [
      '## Problem',
      '',
      'Given an array of integers `nums` and an integer `target`, return the indices of the two numbers that add up to `target`, smaller index first.',
      '',
      'Exactly one pair is valid, and the same element may not be used twice.',
      '',
      '## Examples',
      '',
      '```text',
      'Input',
      'nums = [2,7,11,15], target = 9',
      '',
      'Output',
      '[0,1]',
      '```',
      '',
      '```text',
      'Input',
      'nums = [3,2,4], target = 6',
      '',
      'Output',
      '[1,2]',
      '```',
      '',
      '## Constraints',
      '',
      '- $2 \\le n \\le 10^5$',
      '- $-10^9 \\le \\text{nums}_i, \\text{target} \\le 10^9$',
      '- Exactly one valid pair exists.',
      '',
    ].join('\n'),
    examples: [
      ['[2,7,11,15]\n9\n', '[0,1]\n'],
      ['[3,2,4]\n6\n', '[1,2]\n'],
    ],
    solution: [
      'class Solution:',
      '    def twoSum(self, nums: list[int], target: int) -> list[int]:',
      '        seen = {}',
      '        for i, x in enumerate(nums):',
      '            if target - x in seen:',
      '                return [seen[target - x], i]',
      '            seen[x] = i',
      '        return []',
      '',
    ].join('\n'),
  },
  'valid-parentheses': {
    signature: { name: 'isValid', params: [{ name: 's', type: 'string' }], returns: 'bool' },
    body: [
      '## Problem',
      '',
      'Given a string `s` of the characters `(`, `)`, `[`, `]`, `{` and `}`, return whether it is valid: every bracket is closed by one of the same kind, in the right order.',
      '',
      '## Examples',
      '',
      '```text',
      'Input',
      's = "()[]{}"',
      '',
      'Output',
      'true',
      '```',
      '',
      '```text',
      'Input',
      's = "(]"',
      '',
      'Output',
      'false',
      '```',
      '',
      '## Constraints',
      '',
      '- $1 \\le |s| \\le 10^5$',
      '- `s` contains brackets only.',
      '',
    ].join('\n'),
    examples: [
      ['"()[]{}"\n', 'true\n'],
      ['"(]"\n', 'false\n'],
    ],
    solution: [
      'class Solution:',
      '    def isValid(self, s: str) -> bool:',
      '        pairs = {")": "(", "]": "[", "}": "{"}',
      '        stack = []',
      '        for ch in s:',
      '            if ch in pairs:',
      '                if not stack or stack.pop() != pairs[ch]:',
      '                    return False',
      '            else:',
      '                stack.append(ch)',
      '        return not stack',
      '',
    ].join('\n'),
  },
};

function functionSpec(form: FunctionForm): Pick<ItemDraft, 'problem' | 'testCases'> {
  return {
    problem: {
      interface: 'function',
      timeLimitMs: 2000,
      memoryLimitKb: 262144,
      compare: 'tokens',
      ...functionKit(form.signature),
      referenceSolution: { language: 'python', source: form.solution },
    },
    testCases: form.examples.map(([stdin, out], i) => ({ name: `Example ${i + 1}`, stdin, expectedStdout: out, isSample: true, verified: false })),
  };
}

function cannedFunctionDraft(key: string, assumptions: string[]): ItemDraft {
  const p = SEED_PROBLEMS.find((x) => x.key === key)!;
  const form = FUNCTION_FORMS[key]!;
  const name = form.signature.name;
  return {
    type: 'problem',
    title: p.title,
    summary: p.summary,
    body: form.body,
    difficulty: p.difficulty,
    tags: [...p.tags].sort(),
    ...functionSpec(form),
    assumptions: [
      // What the program form assumes about the layout of stdin does not apply here.
      ...assumptions.filter((a) => !/input layout|input is one|output format/i.test(a)),
      `It is about one routine, so I wrote it as a function, \`${name}\`, with a hidden runner; the signature is my choice.`,
    ],
  };
}

/** Signals that reading input and writing output is part of the task, or that it is not about one routine. */
const PROGRAM_SIGNALS =
  /\b(design|simulat\w+|stdin|stdout|(input|output) format|read(s|ing)? (the |from )?(input|file|lines?)|print(s|ed|ing)?|pars(e|er|ing)|log file|commands?|queries|operations|interactive|line by line)\b/i;

/** Whether a draft should be "Solution only": the hint when it gives one, otherwise the model's own reading of the text. */
function wantsFunction(text: string, hint: InterfaceHint, cannedKey: string | undefined): boolean {
  if (hint !== 'auto') return hint === 'function';
  if (cannedKey !== undefined) return cannedKey in FUNCTION_FORMS;
  return !PROGRAM_SIGNALS.test(text);
}

// ---- Drafts built from the text -------------------------------------------------

const TAG_HINTS: [RegExp, string][] = [
  [/\barrays?\b|\blist of (numbers|integers)\b/i, 'array'],
  [/\bhash|\bdict|\bmap\b/i, 'hash-map'],
  [/\bstrings?\b|\bsubstring|\bcharacters?\b|\bwords?\b/i, 'string'],
  [/\bstack\b/i, 'stack'],
  [/\bheap\b|priority queue|k-?th (largest|smallest)/i, 'heap'],
  [/\bgraph|\bnodes?\b|\bedges?\b|shortest path/i, 'graph'],
  [/\bbfs\b|breadth/i, 'bfs'],
  [/\bdp\b|dynamic programming|\bsubsequence/i, 'dp'],
  [/\bsort/i, 'sorting'],
  [/\bwindow\b/i, 'sliding-window'],
  [/two[\s-]pointers?/i, 'two-pointers'],
  [/\bdesign\b|\bcache\b|rate limit/i, 'design'],
  [/\bdatabase|\bindex(es)?\b|\bsql\b|b-?tree|\bwal\b/i, 'databases'],
  [/distributed|consensus|replica|partition|\braft\b|\bpaxos\b/i, 'distributed-systems'],
  [/goroutine|\bmutex|\bthreads?\b|concurren|scheduler/i, 'concurrency'],
  [/\bgolang\b|\bgoroutine/i, 'go'],
  [/\bxss\b|sanitis|sanitiz|injection|csrf/i, 'security'],
  [/complexity|amorti[sz]ed|big-?o\b|algorithm/i, 'algorithms'],
];

function inferTags(text: string, fallback: string): string[] {
  const tags = TAG_HINTS.filter(([pattern]) => pattern.test(text)).map(([, tag]) => tag);
  return [...new Set(tags.length > 0 ? tags.slice(0, 4) : [fallback])].sort();
}

/** A title from the first line: its leading clause, without Markdown or trailing punctuation. */
function inferTitle(text: string, fallback: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  const clean = firstLine
    .replace(/^[#>\-*\s]+/, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_]/g, '')
    .trim();
  const clause = clean.split(/[.;:!?]|,\s|\s[-–—]\s|\(/)[0]!.trim();
  const words = clause.split(/\s+/).filter(Boolean).slice(0, 8);
  const title = titleCase(words.join(' ')).slice(0, 80).trim();
  return title.length >= 3 ? title : fallback;
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function inferSummary(text: string): string {
  const first = sentences(text.replace(/^[#>\-*\s]+/, ''))[0] ?? '';
  const short = first.length > 140 ? `${first.slice(0, 137).trimEnd()}…` : first;
  if (short === '') return '';
  const capitalised = short.charAt(0).toUpperCase() + short.slice(1);
  return /[.!?…]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** Does free text read like notes or an article rather than a task to solve? */
function looksLikeReading(text: string): boolean {
  const taskSignals = (
    text.match(
      /\b(given|return|print|output|input|find the|compute|determine|count the|how many|minimum|maximum|constraints?|test cases?|asked (at|in)|interview(er)?|solve)\b/gi,
    ) ?? []
  ).length;
  if (taskSignals >= 2) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const readingSignals = /\b(notes? on|how .{2,40} works?|why\b|overview|explained|tl;dr|article|chapter|paper|talk|blog post|takeaways?)\b/i.test(
    text,
  );
  return readingSignals || /^https?:\/\//.test(text.trim()) || wordCount >= 60;
}

function paragraphs(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

const GENERIC_SAMPLES: DraftTestCase[] = [
  { name: 'Example 1', stdin: '5\n3 -1 4 -1 5\n', expectedStdout: '10\n', isSample: true, verified: false },
  { name: 'Example 2', stdin: '3\n-2 -7 -4\n', expectedStdout: '-2\n', isSample: true, verified: false },
  { name: 'Example 3', stdin: '1\n42\n', expectedStdout: '42\n', isSample: true, verified: false },
];

function inferDifficulty(text: string): Difficulty {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return /\b(hard|tricky|optimal|np-)/i.test(text) ? 'hard' : wordCount < 14 ? 'easy' : 'medium';
}

const GENERIC_FUNCTION: Omit<FunctionForm, 'body'> = {
  signature: { name: 'solve', params: [{ name: 'nums', type: 'int[]' }], returns: 'int' },
  examples: [
    ['[3,-1,4,-1,5]\n', '10\n'],
    ['[-2,-7,-4]\n', '-2\n'],
    ['[42]\n', '42\n'],
  ],
  solution: [
    'class Solution:',
    '    def solve(self, nums: list[int]) -> int:',
    '        best = nums[0]',
    '        running = 0',
    '        for v in nums:',
    '            running = max(v, running + v)',
    '            best = max(best, running)',
    '        return best',
    '',
  ].join('\n'),
};

function functionFromText(text: string): ItemDraft {
  const difficulty = inferDifficulty(text);
  const example = ([stdin, out]: [string, string]) => ['```text', 'Input', `nums = ${stdin.trimEnd()}`, '', 'Output', out.trimEnd(), '```'].join('\n');
  const body = [
    '## Problem',
    '',
    paragraphs(text),
    '',
    'Implement `solve`, which takes the values as an array `nums` and returns the answer.',
    '',
    '## Examples',
    '',
    example(GENERIC_FUNCTION.examples[0]!),
    '',
    example(GENERIC_FUNCTION.examples[1]!),
    '',
    '## Constraints',
    '',
    '- $1 \\le n \\le 10^5$',
    '- $-10^9 \\le \\text{nums}_i \\le 10^9$',
    '',
  ].join('\n');
  return {
    type: 'problem',
    title: inferTitle(text, 'Untitled problem'),
    summary: inferSummary(text),
    body,
    difficulty,
    tags: inferTags(text, 'array'),
    ...functionSpec({ ...GENERIC_FUNCTION, body }),
    assumptions: [
      'It is about one routine, so I wrote it as a function, `solve`, with a hidden runner; your text gave no signature, so that is my choice.',
      'No constraints were given; assumed 1 ≤ n ≤ 10^5 and |nums_i| ≤ 10^9.',
      'The examples and their outputs are my own reading of the task, not taken from your text — check them before relying on them.',
      `Difficulty (${difficulty}) and tags are estimates.`,
      'Kept your wording for the statement and only added the sections around it.',
    ],
  };
}

function problemFromText(text: string): ItemDraft {
  const difficulty = inferDifficulty(text);
  const example = (c: DraftTestCase) =>
    ['```text', 'Input', c.stdin.trimEnd(), '', 'Output', c.expectedStdout.trimEnd(), '```'].join('\n');
  const body = [
    '## Problem',
    '',
    paragraphs(text),
    '',
    'Write a program that reads the input described below and prints the answer.',
    '',
    '## Input',
    '',
    '- The first line contains an integer $n$ — the number of values.',
    '- The second line contains $n$ space-separated integers $a_1, a_2, \\dots, a_n$.',
    '',
    '## Output',
    '',
    'Print a single line with the answer.',
    '',
    '## Constraints',
    '',
    '- $1 \\le n \\le 10^5$',
    '- $-10^9 \\le a_i \\le 10^9$',
    '',
    '## Examples',
    '',
    example(GENERIC_SAMPLES[0]!),
    '',
    example(GENERIC_SAMPLES[1]!),
    '',
  ].join('\n');
  return {
    type: 'problem',
    title: inferTitle(text, 'Untitled problem'),
    summary: inferSummary(text),
    body,
    difficulty,
    tags: inferTags(text, 'array'),
    problem: programSpec(genericSolution('python')),
    testCases: structuredClone(GENERIC_SAMPLES),
    assumptions: [
      'Your text did not describe an input format; I chose a common one (n, then n integers on one line).',
      'No constraints were given; assumed 1 ≤ n ≤ 10^5 and |a_i| ≤ 10^9.',
      'The examples and their outputs are my own reading of the task, not taken from your text — check them before relying on them.',
      `Difficulty (${difficulty}) and tags are estimates.`,
      'Kept your wording for the statement and only added the sections around it.',
    ],
  };
}

function readingFromText(text: string): ItemDraft {
  const all = sentences(text);
  const points = all.filter((s) => s.length > 25).slice(0, 5);
  const body = [
    '## Overview',
    '',
    paragraphs(text),
    '',
    ...(points.length >= 2 ? ['## Key points', '', ...points.map((s) => `- ${s}`), ''] : []),
    '## Open questions',
    '',
    '- [ ] What would be a good worked example for this?',
    '- [ ] Which primary source should this link to?',
    '',
  ].join('\n');
  return {
    type: 'reading',
    title: inferTitle(text, 'Untitled note'),
    summary: inferSummary(text),
    body,
    difficulty: null,
    tags: inferTags(text, 'notes'),
    problem: null,
    testCases: [],
    assumptions: [
      'Organised your text under headings; the wording of the overview is yours.',
      ...(points.length >= 2 ? ['The "Key points" list is extracted from your sentences, not new information.'] : []),
      'Added an "Open questions" section with two prompts of my own.',
      'The title, summary and tags are inferred from the text.',
    ],
  };
}

// ---- Revisions ------------------------------------------------------------------

const HARDER: Record<string, Difficulty> = { easy: 'medium', medium: 'hard', hard: 'hard' };
const EASIER: Record<string, Difficulty> = { easy: 'easy', medium: 'easy', hard: 'medium' };

/** Shift every power of ten in the text by `delta` orders of magnitude, never below 10^2. */
function scaleLimits(body: string, delta: number): string {
  return body.replace(/10\^(\{?)(\d+)(\}?)/g, (_match, open: string, exp: string, close: string) => {
    return `10^${open}${Math.max(2, Number(exp) + delta)}${close}`;
  });
}

const EXTRA_SECTIONS = /\n## (Notes|Hint|Follow-up)\n[\s\S]*?(?=\n## |$)/g;

function parsePreviousDraft(value: unknown): ItemDraft {
  if (
    !isRecord(value) ||
    (value.type !== 'problem' && value.type !== 'reading') ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string'
  ) {
    throw invalid('previousDraft', 'must be an item draft as returned by an earlier call');
  }
  const problem = isRecord(value.problem) ? value.problem : null;
  const harness: Record<string, HarnessCode> = {};
  for (const [language, code] of Object.entries(isRecord(problem?.harness) ? problem.harness : {})) {
    if (isLanguage(language) && isRecord(code)) {
      harness[language] = { prefix: typeof code.prefix === 'string' ? code.prefix : '', suffix: typeof code.suffix === 'string' ? code.suffix : '' };
    }
  }
  const reference = problem?.referenceSolution;
  return {
    type: value.type,
    title: value.title,
    summary: typeof value.summary === 'string' ? value.summary : '',
    body: value.body,
    difficulty:
      value.difficulty === 'easy' || value.difficulty === 'medium' || value.difficulty === 'hard' ? value.difficulty : null,
    tags: isStringArray(value.tags) ? value.tags : [],
    problem:
      value.type === 'problem'
        ? {
            interface: problem?.interface === 'function' ? 'function' : 'program',
            timeLimitMs: typeof problem?.timeLimitMs === 'number' ? problem.timeLimitMs : 2000,
            memoryLimitKb: typeof problem?.memoryLimitKb === 'number' ? problem.memoryLimitKb : 262144,
            compare: problem?.compare === 'exact' ? 'exact' : 'tokens',
            starterCode: isRecord(problem?.starterCode) ? (problem.starterCode as Record<string, string>) : {},
            harness: problem?.interface === 'function' ? harness : {},
            referenceSolution:
              isRecord(reference) && isLanguage(reference.language) && typeof reference.source === 'string'
                ? { language: reference.language, source: reference.source }
                : null,
          }
        : null,
    testCases:
      value.type === 'problem' && Array.isArray(value.testCases)
        ? value.testCases.filter(isRecord).map((c) => ({
            name: typeof c.name === 'string' ? c.name : '',
            stdin: typeof c.stdin === 'string' ? c.stdin : '',
            expectedStdout: typeof c.expectedStdout === 'string' ? c.expectedStdout : '',
            isSample: c.isSample !== false,
            verified: false,
          }))
        : [],
    assumptions: isStringArray(value.assumptions) ? value.assumptions : [],
  };
}

function revise(previous: ItemDraft, instruction: string): ItemDraft {
  const draft = structuredClone(previous);
  const quoted = instruction.length > 120 ? `${instruction.slice(0, 117)}…` : instruction;
  let note: string;
  if (/\b(harder|more difficult|tougher|more challenging)\b/i.test(instruction)) {
    draft.body = scaleLimits(draft.body, 1);
    if (draft.type === 'problem') draft.difficulty = HARDER[draft.difficulty ?? 'easy']!;
    note = 'Made it harder as asked: every limit is ten times larger, so a quadratic solution no longer fits the time limit.';
  } else if (/\b(easier|simpler|less difficult|beginner)\b/i.test(instruction)) {
    draft.body = scaleLimits(draft.body, -2);
    if (draft.type === 'problem') draft.difficulty = EASIER[draft.difficulty ?? 'medium']!;
    note = 'Made it easier as asked: limits are a hundred times smaller, so a brute-force solution is acceptable.';
  } else if (/\b(1|one)[\s-]?(based|indexed)\b/i.test(instruction)) {
    draft.body = draft.body.replace(/0-based/g, '1-based').replace(/zero-based/g, 'one-based');
    note = 'Switched the statement to 1-based indices. I did not recompute the example outputs — check them.';
  } else if (/\b(shorter|concise|terse|trim|brief)\b/i.test(instruction)) {
    draft.body = `${draft.body.replace(EXTRA_SECTIONS, '').trimEnd()}\n`;
    note = 'Shortened the statement: removed the notes, hints and follow-ups, and kept the task, format, limits and examples.';
  } else {
    draft.body = `${draft.body.trimEnd()}\n\n## Revision note\n\nReworked following the instruction “${quoted}”.\n`;
    note = `Revised as instructed (“${quoted}”). The change is confined to the statement; examples and limits are as before.`;
  }
  draft.assumptions = [note, ...draft.assumptions.filter((a) => a !== note)];
  return draft;
}

// ---- Style presets ----------------------------------------------------------------

const STYLE_LANGUAGES: [RegExp, string][] = [
  [/\bpython\b/i, 'python'],
  [/c\+\+|\bcpp\b/i, 'cpp'],
  [/\bjava\b/i, 'java'],
  [/\bjavascript\b|\bjs\b/i, 'javascript'],
  [/\btypescript\b/i, 'typescript'],
  [/\bgo(lang)?\b/i, 'go'],
  [/\brust\b/i, 'rust'],
];

interface Section {
  heading: string | null;
  content: string;
}

function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  for (const part of body.split(/^(?=## )/m)) {
    const match = /^## (.+)\n/.exec(part);
    if (match) sections.push({ heading: match[1]!.trim(), content: part.slice(match[0].length).trim() });
    else if (part.trim() !== '') sections.push({ heading: null, content: part.trim() });
  }
  return sections;
}

/** Rewrite `Input … Output …` fences as numbered Example blocks with labelled parts. */
function exampleBlocks(content: string): string {
  let n = 0;
  const fence = /```text\nInput\n([\s\S]*?)\n\nOutput\n([\s\S]*?)\n```(?:\n\n(?!```)(?!#)([^\n]+))?/g;
  return content.replace(fence, (_match, input: string, output: string, explanation?: string) => {
    n += 1;
    return [
      `**Example ${n}**`,
      '',
      '**Input**',
      '',
      '```text',
      input,
      '```',
      '',
      '**Output**',
      '',
      '```text',
      output,
      '```',
      ...(explanation ? ['', `**Explanation:** ${explanation}`] : []),
    ].join('\n');
  });
}

/**
 * Let a style preset leave a visible mark on a draft: restrict the starter
 * languages it names, and follow the layout it describes.
 */
export function applyStyle(draft: ItemDraft, style: StylePreset | null): ItemDraft {
  if (!style || draft.type !== 'problem') return draft;
  const out = structuredClone(draft);
  const text = style.instructions;

  const starterSentence = sentences(text).find((s) => /starter/i.test(s));
  if (starterSentence && out.problem) {
    const languages = STYLE_LANGUAGES.filter(([pattern]) => pattern.test(starterSentence)).map(([, id]) => id);
    if (out.problem.interface === 'function') {
      // A stub is no use without its runner: the two are narrowed together,
      // and only to languages the draft has both for.
      const kept = languages.filter((l) => l in out.problem!.harness);
      const only = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([l]) => kept.includes(l)));
      if (kept.length > 0) {
        out.problem.starterCode = only(out.problem.starterCode);
        out.problem.harness = only(out.problem.harness);
      }
    } else if (languages.length > 0) out.problem.starterCode = starterCode(languages);
  }

  let sections = splitSections(out.body);
  if (/\b(terse|concise|no hints)\b/i.test(text)) {
    sections = sections.filter((s) => !['Notes', 'Hint', 'Follow-up'].includes(s.heading ?? ''));
    // A terse statement gives examples without commentary.
    sections = sections.map((s) =>
      s.heading === 'Examples' ? { ...s, content: s.content.replace(/(```)\n\n(?!```)[^\n]+/g, '$1') } : s,
    );
  }
  if (/example blocks?|leetcode/i.test(text)) {
    const examples = sections.find((s) => s.heading === 'Examples');
    const constraints = sections.find((s) => s.heading === 'Constraints');
    if (examples) {
      examples.content = exampleBlocks(examples.content);
      examples.heading = '';
      // Description first, then the examples, then the constraints.
      if (constraints) {
        sections = sections.filter((s) => s !== constraints);
        sections.splice(sections.indexOf(examples) + 1, 0, constraints);
      }
    }
    sections = sections.map((s) => (s.heading === 'Problem' ? { ...s, heading: '' } : s));
  }
  out.body = `${sections
    .map((s) => (s.heading ? `## ${s.heading}\n\n${s.content}` : s.content))
    .join('\n\n')
    .trim()}\n`;
  return out;
}

// ---- Entry points -----------------------------------------------------------------

/** Rework an earlier draft (as the client sent it back, possibly edited) according to an instruction. */
export function reviseDraft(previousDraft: unknown, instruction: string): ItemDraft {
  return revise(parsePreviousDraft(previousDraft), instruction);
}

export function draftFromText(
  text: string,
  typeHint: 'auto' | 'problem' | 'reading',
  instruction: string | null,
  previousDraft: unknown,
  interfaceHint: InterfaceHint = 'auto',
): ItemDraft {
  // A revision keeps the interface of the draft it reworks.
  if (previousDraft != null && instruction) return reviseDraft(previousDraft, instruction);
  const canned = typeHint === 'reading' ? undefined : CANNED.find((c) => c.pattern.test(text));
  let draft: ItemDraft;
  if (canned) {
    if (!wantsFunction(text, interfaceHint, canned.key)) draft = cannedDraft(canned.key, canned.assumptions);
    // Asked for as a function, but written up only as a program: draft it from the text instead.
    else draft = canned.key in FUNCTION_FORMS ? cannedFunctionDraft(canned.key, canned.assumptions) : functionFromText(text);
  } else if (typeHint === 'reading' || (typeHint === 'auto' && looksLikeReading(text))) draft = readingFromText(text);
  else draft = wantsFunction(text, interfaceHint, undefined) ? functionFromText(text) : problemFromText(text);
  return instruction ? revise(draft, instruction) : draft;
}

/** Typing `MOCK:MISMATCH` in a draft request makes the reference solution disagree with the last example. */
export const MISMATCH_MARKER = 'MOCK:MISMATCH';

/**
 * The check a draft comes with: its reference solution "run" on its test
 * cases. Sets each case's `verified` and returns the summary; `null` for a
 * reading. Nothing is executed — the solution is taken to print the expected
 * output, unless `mismatch` asks for a disagreement on the last case.
 */
export function checkDraft(db: MockDb, draft: ItemDraft, mismatch = false): DraftCheck | null {
  if (draft.type !== 'problem' || !draft.problem) return null;
  const cases = draft.testCases;
  for (const c of cases) c.verified = false;
  const reference = draft.problem.referenceSolution;
  const judge = db.options.judge;
  if (judge === 'none' || !reference || cases.length === 0) {
    return { attempted: false, engine: judge === 'none' ? null : 'judge0', passed: 0, total: cases.length, error: null, runners: [], largeCases: [] };
  }
  // Every harness is tried, whatever becomes of the reference solution.
  const runners = checkRunners(draft, judge === 'down');
  const unchecked = (attempted: boolean, error: string | null): DraftCheck => ({ attempted, engine: 'judge0', passed: 0, total: cases.length, error, runners, largeCases: [] });
  if (judge === 'down') return unchecked(true, 'judge engine unreachable: dial tcp: connection refused');
  const runner = draft.problem.harness[reference.language];
  if (draft.problem.interface === 'function' && !runner) {
    return unchecked(true, `the reference solution is in ${reference.language}, which has no harness`);
  }
  const behaviour = detectBehaviour(reference.source, undefined, assemble(runner, reference.source).program);
  if (behaviour === 'ce') return unchecked(true, 'the reference solution did not compile');
  if (behaviour === 're') return unchecked(true, `the reference solution crashed on ${cases[0]!.name || 'the first case'}`);

  const last = cases.length - 1;
  cases.forEach((c, i) => {
    c.verified = !(mismatch && i === last);
  });
  const failed = mismatch ? cases[last]! : null;
  return {
    attempted: true,
    engine: 'judge0',
    passed: cases.filter((c) => c.verified).length,
    total: cases.length,
    error: failed
      ? wrongOutput(failed, last)
      : null,
    runners,
    largeCases: [],
  };
}

/**
 * Prove each harness of a "solution only" draft: its language's starter
 * code, unchanged, has to compile and run to an answer of any kind. A
 * language the engine does not offer, or one without starter code, is
 * skipped, and so is everything when the engine cannot be reached.
 */
function checkRunners(draft: ItemDraft, engineDown: boolean): RunnerCheck[] {
  const problem = draft.problem;
  if (!problem || problem.interface !== 'function') return [];
  return Object.keys(problem.harness)
    .sort()
    .map((language): RunnerCheck => {
      const starter = problem.starterCode[language] ?? '';
      if (engineDown || starter.trim() === '' || !JUDGE_LANGUAGES.some((l) => l.id === language)) return { language, status: 'skipped', error: null };
      const behaviour = detectBehaviour(starter, undefined, assemble(problem.harness[language], starter).program);
      if (behaviour === 'ce') return { language, status: 'failed', error: `the ${language} starter code did not compile inside its harness: ${RUNNER_ERRORS[language] ?? 'syntax error'}` };
      if (behaviour === 're') return { language, status: 'failed', error: `the ${language} starter code crashed inside its harness on the first test case` };
      return { language, status: 'ok', error: null };
    });
}

const RUNNER_ERRORS: Record<string, string> = {
  go: './main.go:24:2: undefined: readArgs',
  java: 'Main.java:11: error: cannot find symbol Json.longs',
  javascript: 'SyntaxError: Unexpected token )',
  python: "SyntaxError: unexpected EOF while parsing",
};

export const RUNNER_MARKER = 'MOCK:RUNNER';

/**
 * Leave one runner of a "solution only" draft broken, the way a model can:
 * Go's when the draft has it, else the last one that is not the reference
 * solution's. The pretend judge reads the marker as a compile error.
 */
export function breakRunner(draft: ItemDraft): ItemDraft {
  const problem = draft.problem;
  if (!problem || problem.interface !== 'function') return draft;
  const others = Object.keys(problem.harness).filter((l) => l !== problem.referenceSolution?.language);
  const language = others.includes('go') ? 'go' : others[others.length - 1];
  const harness = language === undefined ? undefined : problem.harness[language];
  if (language === undefined || !harness || harness.suffix.includes('MOCK:CE')) return draft;
  const comment = language === 'python' ? '#' : '//';
  const out = structuredClone(draft);
  out.problem!.harness[language] = { ...harness, suffix: `${harness.suffix}${harness.suffix.endsWith('\n') ? '' : '\n'}${comment} MOCK:CE (the mock reads this as a runner that does not compile)\n` };
  return out;
}

/**
 * Give a variant the other interface than its original has. The mock cannot
 * rewrite a problem for that: it changes the setting and says what is left
 * to do.
 */
export function withInterface(draft: ItemDraft, wanted: ProblemInterface): ItemDraft {
  if (!draft.problem || draft.problem.interface === wanted) return draft;
  const out = structuredClone(draft);
  out.problem = {
    ...out.problem!,
    interface: wanted,
    starterCode: wanted === 'program' ? starterCode(DRAFT_LANGUAGES) : {},
    harness: {},
    referenceSolution: null,
  };
  out.testCases = [];
  out.assumptions = [
    wanted === 'program'
      ? 'Recast as a full program that reads its input and prints the answer; the statement still describes the function.'
      : 'Recast as “solution only”; the stubs and runners are still to be written.',
    'No sample cases or reference solution are included: those of the original use the other input convention.',
    ...out.assumptions,
  ];
  return out;
}

const SETTINGS = [
  { label: 'Warehouse Edition', story: 'A warehouse scans parcels as they come off a conveyor belt, and the numbers below are what the scanner recorded.' },
  { label: 'Timetable Edition', story: 'A railway operator is checking a day of its timetable, and the numbers below come straight from the departure board.' },
  { label: 'Sensor Log Edition', story: 'A weather station writes one reading per minute to a log, and the numbers below are an excerpt from it.' },
  { label: 'Playlist Edition', story: 'A music service is analysing a listening session, and the numbers below describe the tracks in the order they were played.' },
];

const TWISTS = [
  {
    rule: 'The input can no longer be read in full before answering. Process it **online**: after reading each element, print the answer for the prefix seen so far, one per line.',
    summary: 'the answer must now be produced online, after every element',
  },
  {
    rule: 'Memory is tight. The limit is **16 MB**, so an auxiliary structure proportional to the size of the input does not fit.',
    summary: 'the memory limit drops to 16 MB, ruling out an auxiliary structure as large as the input',
  },
  {
    rule: 'Answers are no longer unique. When several answers are valid, print the **lexicographically smallest** one.',
    summary: 'ties are now possible and must be broken lexicographically',
  },
];

/** The first sentence of a section's prose, without list markers, quotes, code or tables. */
function leadSentence(content: string): string {
  const line = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*>]|\d+\.|#+)\s+(?:\[[ x]\]\s+)?/, '').trim())
    .find((l) => l !== '' && !l.startsWith('|'));
  const first = sentences(line ?? '')[0] ?? '';
  return first.replace(/:$/, '.');
}

function insertAfterFirstHeading(body: string, paragraph: string): string {
  const match = /^## .+\n\n?/m.exec(body);
  if (!match) return `${paragraph}\n\n${body}`;
  const at = match.index + match[0].length;
  return `${body.slice(0, at)}${paragraph}\n\n${body.slice(at)}`;
}

export function variantOfItem(
  db: MockDb,
  item: StoredItem,
  mode: VariantMode,
  instruction: string | null,
): ItemDraft {
  const pick = hash32(`${item.id}:${db.nextSeq()}`);
  const extra = instruction ? [`Also followed your instruction: “${instruction.slice(0, 160)}”.`] : [];

  if (item.type === 'reading') {
    const outline = splitSections(item.body)
      .filter((s) => s.heading)
      .map((s) => `- **${s.heading}** — ${leadSentence(s.content)}`);
    const angle = instruction ?? 'A one-page revision sheet: what to remember from each part.';
    return {
      type: 'reading',
      title: `${item.title}, Revisited`,
      summary: `A reworking of “${item.title}” from a different angle.`,
      body: [`## Angle`, '', angle, '', '## The short version', '', ...outline, ''].join('\n'),
      difficulty: null,
      tags: [...item.tags],
      problem: null,
      testCases: [],
      assumptions: [
        'Condensed the original to one bullet per section instead of rewriting the full text.',
        instruction ? `Chose the angle from your instruction: “${instruction.slice(0, 160)}”.` : 'No angle was given, so I wrote a revision sheet.',
        'Code samples, tables and formulas from the original are left out.',
      ],
    };
  }

  const problem = item.problem!;
  const samples: DraftTestCase[] = db
    .casesOf(item.id)
    .filter((c) => c.isSample)
    .map((c, i) => ({ name: `Example ${i + 1}`, stdin: c.stdin, expectedStdout: c.expectedStdout, isSample: true, verified: false }));
  const reference = db.referenceOf(item.id);
  const noStarter = Object.keys(problem.starterCode).length === 0 && problem.interface === 'program';
  const base: ItemDraft = {
    type: 'problem',
    title: item.title,
    summary: item.summary,
    body: item.body,
    difficulty: item.difficulty,
    tags: [...item.tags],
    // A variant keeps the original's interface, and with it the stubs and runners.
    problem: {
      interface: problem.interface,
      timeLimitMs: problem.timeLimitMs,
      memoryLimitKb: problem.memoryLimitKb,
      compare: problem.compare,
      starterCode: noStarter ? starterCode(DRAFT_LANGUAGES) : { ...problem.starterCode },
      harness: structuredClone(problem.harness),
      referenceSolution: reference ? { language: reference.language, source: reference.source } : null,
    },
    testCases: samples,
    assumptions: [],
  };
  const from = item.difficulty ?? 'unrated';

  switch (mode) {
    case 'similar': {
      const setting = SETTINGS[pick % SETTINGS.length]!;
      return {
        ...base,
        title: `${item.title}: ${setting.label}`,
        body: insertAfterFirstHeading(item.body, `${setting.story} The task underneath is one you have met before.`),
        assumptions: [
          'Same technique and difficulty as the original; only the setting and wording changed.',
          'The input and output formats are unchanged, so the examples carry over.',
          ...extra,
        ],
      };
    }
    case 'easier': {
      const difficulty = EASIER[item.difficulty ?? 'medium']!;
      return {
        ...base,
        title: `${item.title} (Warm-up)`,
        summary: `A gentler version of “${item.title}” with small limits.`,
        body: scaleLimits(item.body, -2),
        difficulty,
        assumptions: [
          'Same task as the original with limits a hundred times smaller, so a brute-force solution passes.',
          `Difficulty lowered from ${from} to ${difficulty}.`,
          ...extra,
        ],
      };
    }
    case 'harder': {
      const difficulty = HARDER[item.difficulty ?? 'easy']!;
      return {
        ...base,
        title: `${item.title} (Hard Mode)`,
        summary: `A stronger version of “${item.title}”: bigger limits, less time.`,
        body: scaleLimits(item.body, 1),
        difficulty,
        problem: { ...base.problem!, timeLimitMs: Math.max(500, Math.round(problem.timeLimitMs / 2)) },
        assumptions: [
          'Limits are ten times larger than in the original and the time limit is halved.',
          `Difficulty raised from ${from} to ${difficulty}.`,
          'The examples are unchanged; they are too small to tell a fast solution from a slow one.',
          ...extra,
        ],
      };
    }
    case 'twist': {
      const twist = TWISTS[pick % TWISTS.length]!;
      return {
        ...base,
        title: `${item.title} (With a Twist)`,
        summary: `“${item.title}” with one rule changed.`,
        body: `${item.body.trimEnd()}\n\n## The twist\n\n${twist.rule}\n`,
        difficulty: HARDER[item.difficulty ?? 'easy']!,
        problem: {
          ...base.problem!,
          memoryLimitKb: twist.rule.includes('16 MB') ? 16384 : problem.memoryLimitKb,
        },
        testCases: [],
        assumptions: [
          `One rule changed: ${twist.summary}. The usual approach to the original no longer works as is.`,
          "No sample cases are included: the original's expected outputs do not apply under the new rule.",
          ...extra,
        ],
      };
    }
  }
}

// ---- Test case proposals ------------------------------------------------------------

const ARCHETYPES: [string, string, number[]][] = [
  ['Minimum size', 'The smallest input the constraints allow; catches off-by-one errors in loops and indexing.', [7]],
  ['All values equal', 'Every element is the same; breaks solutions that assume distinct values.', [4, 4, 4, 4]],
  ['Already sorted', 'Monotone input: the best case for some approaches and the worst for others.', [1, 2, 3, 5, 8, 13]],
  ['Reverse order', 'Descending input; exercises the opposite branch of every comparison.', [9, 7, 4, 2, 1]],
  ['Negative values', 'Negative numbers and zero; catches a running maximum initialised to 0.', [-3, -1, -4, -1, -5]],
  ['Answer at the boundary', 'The answer involves the very first and last elements.', [6, -2, -3, 1, 5]],
  ['Large magnitudes', 'Values near the top of the allowed range; overflows 32-bit arithmetic if sums are not widened.', [1000000000, 999999999, -1000000000, 1000000000]],
  ['Alternating signs', 'Sign changes at every step; any stale state between iterations shows up here.', [5, -6, 7, -8, 9, -10]],
  ['Single dip', 'One bad element in an otherwise favourable run; checks that the solution recovers after it.', [3, 4, -20, 5, 6]],
  ['Mixed mid-sized case', 'An unremarkable case of moderate size, as a general sanity check.', [2, -1, 2, 3, 4, -5, 1, 1]],
];

function maxSubarray(values: number[]): number {
  let best = values[0]!;
  let running = 0;
  for (const v of values) {
    running = Math.max(v, running + v);
    best = Math.max(best, running);
  }
  return best;
}

/**
 * The reference solution a proposal comes with: the problem's own when it is
 * in the requested language, else something believable. For a "solution
 * only" problem that is the solution part only: another saved solution in
 * that language, or failing that the stub itself.
 */
function proposedSolution(db: MockDb, item: StoredItem, language: string): SourceCode {
  const reference = db.referenceOf(item.id);
  if (reference && reference.language === language) return { language, source: reference.source };
  if (item.problem?.interface !== 'function') return { language, source: genericSolution(language) };
  const saved = db.solutionsOf(item.id).find((s) => s.language === language);
  return { language, source: saved?.source ?? item.problem.starterCode[language] ?? '' };
}

export const REPEAT_MARKER = 'MOCK:REPEAT';
export const REPEAT_ALL_MARKER = 'MOCK:REPEAT-ALL';

/**
 * `repeats` of the proposed cases are treated as repeating an input the
 * problem already has, and left out as the server would; that can be all of
 * them.
 */
export function proposeTestCases(
  db: MockDb,
  item: StoredItem,
  count: number,
  language: string,
  repeats = 0,
): Omit<AiTestCasesResponse, 'usage'> {
  const existing = db.casesOf(item.id);
  const judge = db.options.judge;
  const verifying = judge === 'ok';
  const solutionOnly = item.problem?.interface === 'function';

  const cases: ProposedTestCase[] = [];
  for (let i = 0; i < count; i++) {
    const [name, rationale, values] = ARCHETYPES[i % ARCHETYPES.length]!;
    const round = Math.floor(i / ARCHETYPES.length);
    // With existing cases their inputs are reused, so the outputs are right
    // for this problem; otherwise fall back to inputs the stock solution fits.
    const base = existing.length > 0 ? existing[i % existing.length]! : null;
    // A "solution only" problem takes its arguments as JSON, one per line.
    const stdin = base ? base.stdin : solutionOnly ? `${JSON.stringify(values)}\n` : `${values.length}\n${values.join(' ')}\n`;
    const actual = base ? (db.truth.get(base.id) ?? base.expectedStdout) : `${maxSubarray(values)}\n`;

    const mismatch = i === Math.min(2, count - 1);
    const crashed = count >= 6 && i === 4;
    const predicted = mismatch ? perturbOutput(actual) : actual;
    const ran = verifying && !crashed;
    cases.push({
      name: round > 0 ? `${name} (${round + 1})` : name,
      rationale,
      stdin,
      expectedStdout: ran ? actual : predicted,
      predictedStdout: predicted,
      isSample: false,
      verified: ran,
      predictionMatched: ran ? !mismatch : null,
      error:
        verifying && crashed
          ? 'The reference solution failed on this input (runtime_error): IndexError: list index out of range'
          : null,
    });
  }

  const dropped = Math.min(repeats, cases.length);
  return {
    referenceSolution: proposedSolution(db, item, language),
    verification: {
      attempted: judge !== 'none',
      engine: judge === 'none' ? null : 'judge0',
      error: judge === 'down' ? 'judge engine unreachable: dial tcp: connection refused' : null,
    },
    duplicatesDropped: dropped,
    largeCases: [],
    cases: cases.slice(0, cases.length - dropped),
  };
}

// ---- Checking a problem that is not saved yet -------------------------------------

/** Why a case's expected output was not printed, in the words of a check; a long output is not quoted. */
function wrongOutput(c: { name: string; expectedStdout: string }, index: number): string {
  const name = c.name || `case ${index + 1}`;
  if (c.expectedStdout.length > 200) return `${name}: the reference solution printed a different output`;
  return `${name}: expected ${c.expectedStdout.trim()}, but the reference solution printed ${perturbOutput(c.expectedStdout).trim() || 'nothing'}`;
}

/** In a test case's input or expected output: the reference solution prints something else for it. */
export const CHECK_WRONG_MARKER = 'MOCK:WA';
/** In a test case's input or expected output: the reference solution crashes on it. */
export const CHECK_CRASH_MARKER = 'MOCK:RE';
/** In the reference solution: the check runs out of time halfway through. */
export const CHECK_TIMEOUT_MARKER = 'MOCK:TIMEOUT';

/**
 * `POST /items/check`: the draft check, for a problem as edited, with an
 * outcome for every case. A case is `wrong` when its data carries `MOCK:WA`
 * and `failed` when it carries `MOCK:RE`; `MOCK:CE` in the reference solution
 * fails them all, and `MOCK:TIMEOUT` leaves the second half `not_run`.
 */
export function checkProblem(
  db: MockDb,
  problem: DraftProblemSpec,
  cases: readonly { name: string; stdin: string; expectedStdout: string }[],
): { check: DraftCheck; cases: CheckedCase[] } {
  const judge = db.options.judge;
  const reference = problem.referenceSolution;
  const total = cases.length;
  const all = (outcome: CheckedCase): CheckedCase[] => cases.map(() => ({ ...outcome }));
  if (judge === 'none' || !reference || total === 0) {
    const error = judge === 'none' ? 'there is no judge engine' : 'there is no reference solution';
    return { check: { attempted: false, engine: judge === 'none' ? null : 'judge0', passed: 0, total, error: null, runners: [], largeCases: [] }, cases: all({ outcome: 'not_run', error }) };
  }
  const draft = { problem, testCases: [], type: 'problem', title: '', summary: '', body: '', difficulty: null, tags: [], assumptions: [] } satisfies ItemDraft;
  const runners = checkRunners(draft, judge === 'down');
  const stopped = (error: string, outcome: CheckedCase) => ({ check: { attempted: true, engine: 'judge0', passed: 0, total, error, runners, largeCases: [] }, cases: all(outcome) });
  if (judge === 'down') return stopped('judge engine unreachable: dial tcp: connection refused', { outcome: 'not_run', error: 'the judge engine could not be reached' });
  const runner = problem.harness[reference.language];
  if (problem.interface === 'function' && !runner) {
    const error = `the reference solution is in ${reference.language}, which has no harness`;
    return stopped(error, { outcome: 'not_run', error });
  }
  if (detectBehaviour(reference.source, undefined, assemble(runner, reference.source).program) === 'ce') {
    return stopped('the reference solution did not compile', { outcome: 'failed', error: 'the reference solution did not compile' });
  }
  const reached = reference.source.includes(CHECK_TIMEOUT_MARKER) ? Math.ceil(total / 2) : total;
  const outcomes = cases.map((c, i): CheckedCase => {
    if (i >= reached) return { outcome: 'not_run', error: 'the check ran out of time' };
    const data = c.stdin + c.expectedStdout;
    if (data.includes(CHECK_CRASH_MARKER)) return { outcome: 'failed', error: 'the reference solution crashed (runtime error): IndexError: list index out of range' };
    if (data.includes(CHECK_WRONG_MARKER)) return { outcome: 'wrong', error: null };
    return { outcome: 'passed', error: null };
  });
  const first = outcomes.findIndex((o) => o.outcome !== 'passed');
  const error =
    first === -1
      ? null
      : outcomes[first]!.outcome === 'wrong'
        ? wrongOutput(cases[first]!, first)
        : outcomes[first]!.outcome === 'failed'
          ? `${cases[first]!.name || `case ${first + 1}`}: ${outcomes[first]!.error}`
          : `the check ran out of time after ${first} of ${total} test cases`;
  return { check: { attempted: true, engine: 'judge0', passed: outcomes.filter((o) => o.outcome === 'passed').length, total, error, runners, largeCases: [] }, cases: outcomes };
}
