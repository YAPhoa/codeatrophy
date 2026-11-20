import { describe, expect, it } from 'vitest';
import { draftStateLabel, elapsedLabel, jobBelongsTo, jobKindLabel, jobTarget } from './labels';

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
