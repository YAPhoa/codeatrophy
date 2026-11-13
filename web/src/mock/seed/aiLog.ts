// The seed of the AI activity log: a long run of generated entries, enough
// to need more than one load, and a few written by hand on top to show every
// kind of entry — failed, cancelled, cut off, with and without the figures a
// provider may leave out.

import type { AiLogDetail, AiOperation, TokenUsage } from '../../api/types';
import type { MockDb, StoredAiProvider } from '../db';
import { hash32 } from '../util';

const HOUR = 3600;
const DAY = 24 * HOUR;

const NO_TOKENS: TokenUsage = { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null };

const SYSTEM =
  'You write entries for a personal library of coding problems and technical readings. Answer with one JSON object that follows the given schema. List everything you inferred or invented under "assumptions".';

const request = (content: string, schema: string) => ({ system: SYSTEM, messages: [{ role: 'user', content }], schema, maxOutputTokens: 64000 });

const SCHEMA: Record<AiOperation, string> = { draft: 'item_draft', variant: 'item_draft', testcases: 'test_cases', test: 'none' };

type Seeded = Pick<AiLogDetail, 'operation' | 'itemId' | 'title' | 'status' | 'error' | 'durationMs' | 'usage' | 'request' | 'response'> & { truncated?: boolean; model?: string };

export interface LogSeedItem {
  id: string;
  title: string;
}

/** Fill the log of a seeded library. `items` are what the variant and test-case entries are about. */
export function seedAiLog(db: MockDb, items: readonly LogSeedItem[]): void {
  const [main, ...others] = db.ai.providers;
  if (!main || items.length === 0) return;
  const local = others.find((p) => p.kind === 'openai_compatible' && p.usage.allTime.requests > 0);
  const add = (provider: StoredAiProvider, secondsAgo: number, entry: Seeded) => {
    const { truncated = false, model, ...rest } = entry;
    db.aiLog.push({
      seq: db.nextSeq(),
      id: `log-${String(db.aiLog.length + 1).padStart(4, '0')}`,
      createdAt: db.ago(secondsAgo),
      providerId: provider.id,
      providerName: provider.name,
      kind: provider.kind,
      model: model ?? db.modelOf(provider) ?? '',
      truncated,
      ...rest,
    });
  };

  // ---- Generated history, oldest first: about two requests a day over four months.
  const operations: AiOperation[] = ['draft', 'draft', 'testcases', 'variant', 'draft', 'testcases', 'test'];
  const COUNT = 240;
  for (let i = 0; i < COUNT; i++) {
    const h = hash32(`log ${i}`);
    const secondsAgo = Math.round(((COUNT - i) / COUNT) * 120 * DAY) + 9 * DAY + (h % (6 * HOUR));
    const operation = operations[h % operations.length]!;
    const item = items[(h >>> 4) % items.length]!;
    // The local server was in use for a while, some time ago.
    const provider = local && i >= 40 && i < 49 ? local : main;
    const status = h % 17 === 0 ? 'failed' : h % 53 === 0 ? 'cancelled' : 'ok';
    const inputTokens = operation === 'test' ? 14 : 2100 + ((h >>> 8) % 5200);
    const outputTokens = operation === 'test' ? 5 : 900 + ((h >>> 12) % 5600);
    const content =
      operation === 'draft'
        ? `${item.title.toLowerCase()} — from memory, fill in the rest`
        : operation === 'variant'
          ? `Write a variant (similar) of this item.\n\n# ${item.title}`
          : operation === 'testcases'
            ? `Write a reference solution in python and 8 test cases for this problem.\n\n# ${item.title}`
            : 'Reply with the single word: ok';
    add(provider, secondsAgo, {
      operation,
      itemId: operation === 'variant' || operation === 'testcases' ? item.id : null,
      title: operation === 'test' ? null : item.title,
      status,
      error: status === 'failed' ? (provider === local ? 'Could not reach localhost:11434: dial tcp 127.0.0.1:11434: connect: connection refused' : 'the AI provider returned an error: 529 overloaded_error — Overloaded') : null,
      durationMs: status === 'ok' ? (operation === 'test' ? 380 + (h % 500) : 2500 + outputTokens * 11) : 900 + (h % 4000),
      usage:
        status !== 'ok'
          ? NO_TOKENS
          : provider.kind === 'openai_compatible'
            ? { inputTokens, outputTokens, reasoningTokens: Math.round(outputTokens * 0.3), cacheReadTokens: null, cacheWriteTokens: null }
            : { inputTokens, outputTokens, reasoningTokens: null, cacheReadTokens: h % 3 === 0 ? 1800 : 0, cacheWriteTokens: 0 },
      request: operation === 'test' ? { messages: [{ role: 'user', content }], maxOutputTokens: 16 } : request(content, SCHEMA[operation]),
      response: status !== 'ok' ? null : operation === 'test' ? 'ok' : JSON.stringify({ title: item.title, summary: `Generated for “${item.title}”.`, assumptions: ['Assumed the usual constraints.'] }),
    });
  }

  // ---- The last few days, by hand.
  const [first, second] = items;
  add(main, 6 * DAY, {
    operation: 'test',
    itemId: null,
    title: null,
    status: 'ok',
    error: null,
    durationMs: 412,
    usage: { ...NO_TOKENS, inputTokens: 14, outputTokens: 5 },
    request: { messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxOutputTokens: 16 },
    response: 'ok',
  });
  const prose = 'Vector clocks give each process a counter per process. A process increments its own counter on every event and sends the whole vector with each message; the receiver takes the element-wise maximum and then increments its own. ';
  add(main, 5 * DAY, {
    operation: 'draft',
    itemId: null,
    title: 'Vector Clocks',
    status: 'ok',
    error: null,
    durationMs: 71300,
    usage: { inputTokens: 9120, outputTokens: 6240, reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 },
    request: request('notes on how vector clocks work, as a reading. include the comparison rules and a worked example with three processes', 'item_draft'),
    // Cut off in the middle of the body: what is left is not JSON any more.
    response: `{"type":"reading","title":"Vector Clocks","summary":"How vector clocks order events without a shared clock.","body":"## The idea\\n\\n${prose.repeat(6)}`,
    truncated: true,
  });
  add(main, 2 * DAY, {
    operation: 'draft',
    itemId: null,
    title: null,
    status: 'cancelled',
    error: null,
    durationMs: 9400,
    usage: NO_TOKENS,
    request: request('sliding window maximum, deque approach — statement, constraints, three examples', 'item_draft'),
    response: null,
  });
  add(main, 26 * HOUR, {
    operation: 'variant',
    itemId: second?.id ?? first!.id,
    title: second?.title ?? first!.title,
    status: 'failed',
    error: 'the AI provider returned an error: 529 overloaded_error — Overloaded',
    durationMs: 2100,
    usage: NO_TOKENS,
    request: request(`Write a variant (harder) of this item.\n\n# ${second?.title ?? first!.title}`, 'item_draft'),
    response: null,
  });
  add(main, 3 * HOUR, {
    operation: 'testcases',
    itemId: first!.id,
    title: first!.title,
    status: 'ok',
    error: null,
    durationMs: 21800,
    // Reasoning and a prompt-cache hit, as a provider that reports both shows them.
    usage: { inputTokens: 3900, outputTokens: 1650, reasoningTokens: 420, cacheReadTokens: 3100, cacheWriteTokens: 0 },
    request: request(`Write a reference solution in python and 8 test cases for this problem.\n\n# ${first!.title}\n\nInputs it already has:\n4\n2 7 11 15\n9`, 'test_cases'),
    response: JSON.stringify({
      referenceSolution: { language: 'python', source: 'import sys\n\ndef main():\n    data = sys.stdin.read().split()\n    ...\n\nmain()\n' },
      cases: [{ name: 'Minimum size', rationale: 'Smallest allowed n.', stdin: '2\n1 2\n3\n', predictedStdout: '0 1\n' }],
    }),
  });
  add(main, 2 * HOUR, {
    operation: 'draft',
    itemId: null,
    title: 'Merge k Sorted Lists',
    status: 'ok',
    error: null,
    durationMs: 48200,
    usage: { inputTokens: 5210, outputTokens: 4380, reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 },
    request: request('merge k sorted linked lists — leetcode hard, heap approach. solution only, python and java', 'item_draft'),
    response: JSON.stringify({
      type: 'problem',
      title: 'Merge k Sorted Lists',
      summary: 'Merge k sorted linked lists into one sorted list.',
      difficulty: 'hard',
      tags: ['heap', 'linked-list'],
      assumptions: ['The original text gave no constraints; assumed at most 10^4 lists and 500 nodes per list.'],
    }),
  });
}
