// A pretend AI provider: deterministic text manipulation that returns drafts
// in the shapes the real endpoints produce. A few well-known inputs get
// polished canned drafts; everything else is built from the text itself.

import type {
  AiTestCasesResponse,
  Difficulty,
  DraftTestCase,
  ItemDraft,
  ProposedTestCase,
  StylePreset,
  VariantMode,
} from '../api/types';
import type { MockDb, StoredItem } from './db';
import { invalid, isRecord, isStringArray } from './http';
import { perturbOutput } from './judge';
import { seedBody } from './seed';
import { SEED_PROBLEMS } from './seed/problems';
import { genericSolution, starterCode } from './starter';
import { hash32, titleCase } from './util';

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

function cannedDraft(key: string, assumptions: string[]): ItemDraft {
  const p = SEED_PROBLEMS.find((x) => x.key === key)!;
  return {
    type: 'problem',
    title: p.title,
    summary: p.summary,
    body: seedBody(key),
    difficulty: p.difficulty,
    tags: [...p.tags].sort(),
    problem: { timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens', starterCode: starterCode(DRAFT_LANGUAGES) },
    testCases: p.cases
      .filter((c) => c.sample)
      .map((c, i) => ({ name: `Example ${i + 1}`, stdin: c.stdin, expectedStdout: c.out, isSample: true })),
    assumptions: [...assumptions],
  };
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
  { name: 'Example 1', stdin: '5\n3 -1 4 -1 5\n', expectedStdout: '10\n', isSample: true },
  { name: 'Example 2', stdin: '3\n-2 -7 -4\n', expectedStdout: '-2\n', isSample: true },
  { name: 'Example 3', stdin: '1\n42\n', expectedStdout: '42\n', isSample: true },
];

function problemFromText(text: string): ItemDraft {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const difficulty: Difficulty = /\b(hard|tricky|optimal|np-)/i.test(text) ? 'hard' : wordCount < 14 ? 'easy' : 'medium';
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
    problem: { timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens', starterCode: starterCode(DRAFT_LANGUAGES) },
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
            timeLimitMs: typeof problem?.timeLimitMs === 'number' ? problem.timeLimitMs : 2000,
            memoryLimitKb: typeof problem?.memoryLimitKb === 'number' ? problem.memoryLimitKb : 262144,
            compare: problem?.compare === 'exact' ? 'exact' : 'tokens',
            starterCode: isRecord(problem?.starterCode) ? (problem.starterCode as Record<string, string>) : {},
          }
        : null,
    testCases:
      value.type === 'problem' && Array.isArray(value.testCases)
        ? value.testCases.filter(isRecord).map((c) => ({
            name: typeof c.name === 'string' ? c.name : '',
            stdin: typeof c.stdin === 'string' ? c.stdin : '',
            expectedStdout: typeof c.expectedStdout === 'string' ? c.expectedStdout : '',
            isSample: c.isSample !== false,
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
    if (languages.length > 0) out.problem.starterCode = starterCode(languages);
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
): ItemDraft {
  if (previousDraft != null && instruction) return reviseDraft(previousDraft, instruction);
  const canned = typeHint === 'reading' ? undefined : CANNED.find((c) => c.pattern.test(text));
  let draft: ItemDraft;
  if (canned) draft = cannedDraft(canned.key, canned.assumptions);
  else if (typeHint === 'reading' || (typeHint === 'auto' && looksLikeReading(text))) draft = readingFromText(text);
  else draft = problemFromText(text);
  return instruction ? revise(draft, instruction) : draft;
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
    .map((c, i) => ({ name: `Example ${i + 1}`, stdin: c.stdin, expectedStdout: c.expectedStdout, isSample: true }));
  const base: ItemDraft = {
    type: 'problem',
    title: item.title,
    summary: item.summary,
    body: item.body,
    difficulty: item.difficulty,
    tags: [...item.tags],
    problem: {
      timeLimitMs: problem.timeLimitMs,
      memoryLimitKb: problem.memoryLimitKb,
      compare: problem.compare,
      starterCode: Object.keys(problem.starterCode).length > 0 ? { ...problem.starterCode } : starterCode(DRAFT_LANGUAGES),
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

export function proposeTestCases(
  db: MockDb,
  item: StoredItem,
  count: number,
  language: string,
): AiTestCasesResponse {
  const existing = db.casesOf(item.id);
  const reference = item.problem?.referenceSolution;
  const judge = db.options.judge;
  const verifying = judge === 'ok';

  const cases: ProposedTestCase[] = [];
  for (let i = 0; i < count; i++) {
    const [name, rationale, values] = ARCHETYPES[i % ARCHETYPES.length]!;
    const round = Math.floor(i / ARCHETYPES.length);
    // With existing cases their inputs are reused, so the outputs are right
    // for this problem; otherwise fall back to inputs the stock solution fits.
    const base = existing.length > 0 ? existing[i % existing.length]! : null;
    const stdin = base ? base.stdin : `${values.length}\n${values.join(' ')}\n`;
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

  return {
    referenceSolution:
      reference && reference.language === language
        ? { ...reference }
        : { language, source: genericSolution(language) },
    verification: {
      attempted: judge !== 'none',
      engine: judge === 'none' ? null : 'judge0',
      error: judge === 'down' ? 'judge engine unreachable: dial tcp: connection refused' : null,
    },
    cases,
  };
}
