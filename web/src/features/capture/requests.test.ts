import { describe, expect, it } from 'vitest';
import type { Item } from '../../api/types';
import { draftRequest, revisionTestCaseCount, variantRequest } from './requests';

const item = (type: Item['type']): Item => ({ type, problem: type === 'problem' ? { interface: 'function' } : null }) as unknown as Item;

describe('draftRequest', () => {
  it('asks a problem, or an undecided capture, for the test case count', () => {
    expect(draftRequest({ text: 'two sum', typeHint: 'auto', interfaceHint: 'auto' }, null, 0, 8, {})).toEqual({
      text: 'two sum',
      typeHint: 'auto',
      interfaceHint: 'auto',
      testCaseCount: 8,
      styleId: null,
      largeTestCases: 0,
    });
    expect(draftRequest({ text: 'two sum', typeHint: 'problem', interfaceHint: 'program' }, 'style-1', 2, 5, { providerId: 'p' })).toMatchObject({ testCaseCount: 5, largeTestCases: 2, providerId: 'p' });
  });

  it('sends no interface and no count for a reading', () => {
    const req = draftRequest({ text: 'notes', typeHint: 'reading', interfaceHint: 'function' }, null, 0, 8, {});
    expect(req).not.toHaveProperty('testCaseCount');
    expect(req).not.toHaveProperty('interfaceHint');
  });
});

describe('variantRequest', () => {
  it('sends the count for a problem only', () => {
    expect(variantRequest(item('problem'), { mode: 'harder', instruction: ' ' }, null, 0, 6, {})).toEqual({
      mode: 'harder',
      instruction: null,
      styleId: null,
      interfaceHint: 'function',
      testCaseCount: 6,
      largeTestCases: 0,
    });
    const reading = variantRequest(item('reading'), { mode: 'similar', instruction: 'shorter' }, null, 0, 6, {});
    expect(reading).not.toHaveProperty('testCaseCount');
    expect(reading).toMatchObject({ instruction: 'shorter' });
  });
});

describe('revisionTestCaseCount', () => {
  it('keeps what the draft was asked for, else the choice, else the preference, within the bound', () => {
    expect(revisionTestCaseCount(5, 3, 8, 30)).toBe(5);
    expect(revisionTestCaseCount(undefined, 3, 8, 30)).toBe(3);
    // An earlier request without a count, or with 0, falls back.
    expect(revisionTestCaseCount(0, undefined, 8, 30)).toBe(8);
    expect(revisionTestCaseCount(undefined, undefined, 40, 30)).toBe(30);
  });
});
