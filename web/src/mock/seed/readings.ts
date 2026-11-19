// The readings of the seed library. Bodies live as Markdown files in
// ./content, keyed by `key`.

import type { Difficulty, ItemStatus } from '../../api/types';

export interface SeedReading {
  key: string;
  n: number;
  title: string;
  summary: string;
  /** Readings may have one too; most do not. */
  difficulty?: Difficulty;
  tags: string[];
  status: ItemStatus;
  favorite?: boolean;
  created: number;
  updated: number;
  revision?: number;
  notes?: string;
  sourceUrl?: string;
  sourceNote?: string;
  collections: string[];
}

export const SEED_READINGS: SeedReading[] = [
  {
    key: 'consistent-hashing',
    n: 17,
    title: 'Consistent Hashing',
    summary: 'Why hash-mod-N falls apart when a cluster changes size, how the ring fixes it, and the alternatives.',
    tags: ['distributed-systems', 'algorithms'],
    status: 'done',
    favorite: true,
    created: 100,
    updated: 64,
    revision: 5,
    sourceUrl: 'https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chash.pdf',
    sourceNote: 'Karger et al., 1997 — plus the Dynamo paper and the jump hash paper',
    notes:
      'Rendezvous hashing is the one to reach for under ~50 nodes — no ring to maintain.\n\nAsked about this in the systems round: they wanted the vnode argument, not the code.',
    collections: ['distributed'],
  },
  {
    key: 'b-trees',
    n: 18,
    title: 'How B-Trees Work',
    summary: 'Pages, fanout, splits and why almost every database index is a B+ tree.',
    tags: ['databases'],
    status: 'in_progress',
    created: 55,
    updated: 7,
    revision: 6,
    notes: '- Stopped at "Concurrency and crash safety"\n- Compare with the LSM notes once those exist',
    collections: ['databases'],
  },
  {
    key: 'cap-theorem',
    n: 19,
    title: 'CAP Theorem Notes',
    summary: 'What the theorem actually says, what it does not, and PACELC.',
    tags: ['distributed-systems'],
    status: 'done',
    created: 90,
    updated: 82,
    revision: 2,
    collections: ['distributed'],
  },
  {
    key: 'go-scheduler',
    n: 20,
    title: 'Go Scheduler Notes: G, M and P',
    summary: 'How goroutines are multiplexed onto threads: run queues, work stealing, syscalls and preemption.',
    tags: ['go', 'concurrency'],
    status: 'todo',
    created: 30,
    updated: 30,
    sourceUrl: 'https://go.dev/src/runtime/HACKING',
    collections: ['systems'],
  },
  {
    key: 'amortised-analysis',
    n: 21,
    title: 'Amortised Analysis, Three Ways',
    summary: 'The doubling array analysed with the aggregate, accounting and potential methods.',
    tags: ['algorithms'],
    status: 'done',
    favorite: true,
    created: 84,
    updated: 59,
    revision: 3,
    collections: [],
  },
  {
    key: 'wal-fsync',
    n: 22,
    title: 'Write-Ahead Logging and fsync',
    summary: 'The one ordering rule behind crash safety, and why write() alone guarantees nothing.',
    tags: ['databases'],
    status: 'todo',
    created: 22,
    updated: 22,
    collections: ['databases', 'weekly'],
  },
  {
    key: 'untrusted-markdown',
    n: 23,
    title: 'Untrusted Markdown: What a Renderer Must Not Do',
    summary: 'Raw HTML, script URLs and remote images in Markdown that came from someone else.',
    tags: ['security'],
    status: 'todo',
    created: 4,
    updated: 4,
    sourceNote: 'Review notes for the preview feature',
    collections: [],
  },
  {
    key: 'raft-leader-election',
    n: 24,
    title: 'Raft: Leader Election Cheat Sheet',
    summary: 'States, vote rules and timing for the election half of Raft.',
    difficulty: 'medium',
    tags: ['distributed-systems'],
    status: 'in_progress',
    created: 18,
    updated: 10,
    revision: 2,
    sourceUrl: 'https://raft.github.io/raft.pdf',
    collections: ['distributed'],
  },
];
