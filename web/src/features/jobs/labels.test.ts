import { describe, expect, it } from 'vitest';
import type { AiJob, AiJobKind, AiJobStatus } from '../../api/types';
import { draftStateLabel, elapsedLabel, jobBelongsTo, jobKindLabel, jobLink, jobTarget, listedJobs } from './labels';

describe('draftStateLabel', () => {
  it('names each state, in the tone it is shown in', () => {
    expect(draftStateLabel({ state: 'drafting', edited: false })).toEqual({ text: 'Drafting…', tone: 'neutral' });
    expect(draftStateLabel({ state: 'ready', edited: false })).toEqual({ text: 'Ready to review', tone: 'ok' });
    expect(draftStateLabel({ state: 'failed', edited: true })).toEqual({ text: 'Failed', tone: 'danger' });
    expect(draftStateLabel({ state: 'new', edited: false })).toEqual({ text: 'Not drafted', tone: 'neutral' });
  });

  it('calls an edited draft whose first generation was cancelled, with nothing of the user’s in it, not drafted', () => {
    expect(draftStateLabel({ state: 'edited', edited: true }).text).toBe('Edited');
    expect(draftStateLabel({ state: 'edited', edited: false }).text).toBe('Not drafted');
  });
});

describe('where a job belongs', () => {
  it('is its draft, or else the screen it was started from', () => {
    expect(jobTarget({ draftId: 'd1', origin: '/items/i1' })).toBe('/drafts/d1');
    expect(jobTarget({ draftId: null, origin: '/items/i1/edit?tab=tests' })).toBe('/items/i1/edit?tab=tests');
    expect(jobTarget({ draftId: null, origin: null })).toBeNull();
  });

  it('matches the screen by its path alone, without query or fragment', () => {
    const job = { draftId: null, origin: '/items/i1/edit?tab=tests#cases' };
    expect(jobBelongsTo(job, '/items/i1/edit')).toBe(true);
    expect(jobBelongsTo({ draftId: null, origin: '/items/i1#top' }, '/items/i1')).toBe(true);
    expect(jobBelongsTo(job, '/items/i1')).toBe(false);
    expect(jobBelongsTo({ draftId: 'd1', origin: '/items/i1' }, '/drafts/d1')).toBe(true);
    expect(jobBelongsTo({ draftId: 'd1', origin: '/items/i1' }, '/items/i1')).toBe(false);
    expect(jobBelongsTo({ draftId: null, origin: null }, '/')).toBe(false);
  });
});

describe('which jobs the AI jobs list shows', () => {
  type Listed = Pick<AiJob, 'status' | 'draftId' | 'origin'>;
  const job = (status: AiJobStatus, target: Partial<Listed>): Listed => ({ status, draftId: null, origin: null, ...target });

  it('shows every queued or running job, the open screen’s own too', () => {
    const jobs = [job('queued', { draftId: 'd1' }), job('running', { draftId: 'd1' }), job('running', { origin: '/items/i1/tests/generate' })];
    expect(listedJobs(jobs, '/drafts/d1')).toEqual(jobs);
    expect(listedJobs(jobs, '/items/i1/tests/generate')).toEqual(jobs);
  });

  it('leaves the open screen’s finished jobs to it, and shows those of other screens', () => {
    const own = [job('succeeded', { draftId: 'd1' }), job('failed', { draftId: 'd1' }), job('cancelled', { draftId: 'd1' })];
    const other = [job('succeeded', { draftId: 'd2' }), job('failed', { origin: '/items/i1/edit?tab=code' }), job('succeeded', {})];
    expect(listedJobs([...own, ...other], '/drafts/d1')).toEqual(other);
    expect(listedJobs([...own, ...other], '/items/i1/edit')).toEqual([...own, other[0], other[2]]);
  });
});

describe('where a job leads from the AI jobs list', () => {
  const STATUSES: AiJobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
  type Linked = Pick<AiJob, 'kind' | 'itemId' | 'draftId' | 'origin'>;
  const cases: [string, Linked, string][] = [
    ['a capture to its draft', { kind: 'draft', itemId: null, draftId: 'd1', origin: null }, '/drafts/d1'],
    ['a variant to its draft', { kind: 'variant', itemId: 'i1', draftId: 'd2', origin: '/items/i1?tab=variants' }, '/drafts/d2'],
    ['test cases to the screen that collects them', { kind: 'testcases', itemId: 'i1', draftId: null, origin: '/items/i1/tests/generate' }, '/items/i1/tests/generate'],
    ['code to the screen that collects it', { kind: 'code', itemId: 'i1', draftId: null, origin: '/items/i1/edit' }, '/items/i1/edit'],
    ['test cases with no screen to their item', { kind: 'testcases', itemId: 'i1', draftId: null, origin: null }, '/items/i1'],
    ['code with no screen to its item', { kind: 'code', itemId: 'i1', draftId: null, origin: null }, '/items/i1'],
    ['code with neither screen nor item to the library', { kind: 'code', itemId: null, draftId: null, origin: null }, '/'],
    ['a draft job without its draft to the Drafts list', { kind: 'draft', itemId: null, draftId: null, origin: null }, '/drafts'],
  ];

  it.each(cases)('takes %s, in every state', (_name, job, to) => {
    // Where a job leads does not change as it runs, finishes, fails or is cancelled.
    for (const status of STATUSES) expect(jobLink({ ...job, status } as Linked)).toBe(to);
  });

  it('takes a job whose draft is gone to the Drafts list, once the drafts are known', () => {
    const job: Linked = { kind: 'draft', itemId: null, draftId: 'd1', origin: null };
    expect(jobLink(job, new Set(['d2']))).toBe('/drafts');
    expect(jobLink(job, new Set(['d1']))).toBe('/drafts/d1');
    expect(jobLink(job, null)).toBe('/drafts/d1');
    expect(jobLink({ ...job, kind: 'variant' as AiJobKind, itemId: 'i1' }, new Set())).toBe('/drafts');
  });
});

describe('jobKindLabel', () => {
  it('names every kind', () => {
    expect((['draft', 'variant', 'testcases', 'code'] as const).map(jobKindLabel)).toEqual(['Draft', 'Variant', 'Test cases', 'Code']);
  });
});

describe('elapsedLabel', () => {
  it('counts whole seconds up to a minute, then minutes and seconds', () => {
    expect(elapsedLabel(0)).toBe('0 s');
    expect(elapsedLabel(8999)).toBe('8 s');
    expect(elapsedLabel(59_999)).toBe('59 s');
    expect(elapsedLabel(60_000)).toBe('1:00');
    expect(elapsedLabel(65_400)).toBe('1:05');
    expect(elapsedLabel(3_725_000)).toBe('62:05');
  });

  it('never goes below zero, for a clock that is a little behind the server', () => {
    expect(elapsedLabel(-1500)).toBe('0 s');
  });
});
