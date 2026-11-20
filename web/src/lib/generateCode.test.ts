import { describe, expect, it } from 'vitest';
import type { AiCodeResponse } from '../api/types';
import { checkedCode, codeLanguages, codeRequestFromForm, codeToReplace, currentRunnerChecks, withGeneratedCode } from './generateCode';
import { emptyForm, type ItemFormState } from './itemForm';
import { isGenericStarter, starterCode } from './starterTemplates';

const form = (over: Partial<ItemFormState>): ItemFormState => ({ ...emptyForm('problem'), title: ' Coin Change ', body: '## Input', ...over });

describe('isGenericStarter', () => {
  it('takes blank code and the skeleton, however it is indented or spaced, as generic', () => {
    const python = starterCode(['python']).python!;
    expect(isGenericStarter('python', '')).toBe(true);
    expect(isGenericStarter('python', '  \n')).toBe(true);
    expect(isGenericStarter('python', python)).toBe(true);
    expect(isGenericStarter('python', python.replace(/\n/g, '\r\n\n').replace(/^ {4}/gm, '\t'))).toBe(true);
    expect(isGenericStarter('python', python.replace('# TODO: parse the input and print the answer', 'n = int(data[0])'))).toBe(false);
    // A language without a skeleton is generic only when blank.
    expect(isGenericStarter('kotlin', 'fun main() {}')).toBe(false);
  });
});

describe('codeToReplace', () => {
  it('names the listed languages with code of their own, and with a runner when the problem is solution only', () => {
    const code = { ...starterCode(['python', 'cpp']), java: 'class Main { /* edited */ }', go: '' };
    const harness = { python: { prefix: 'import json', suffix: '' }, cpp: { prefix: ' ', suffix: '\n' } };
    expect(codeToReplace(form({ starterCode: code, harness }))).toEqual(['java']);
    expect(codeToReplace(form({ interface: 'function', starterCode: code, harness }))).toEqual(['python', 'java']);
    expect(codeToReplace(form({ starterCode: starterCode(['python', 'go']) }))).toEqual([]);
  });
});

describe('codeRequestFromForm', () => {
  it('asks for the listed languages, in tab order, from the form as it stands', () => {
    const f = form({ interface: 'function', starterCode: { go: '', python: 'x' }, harness: { cpp: { prefix: '', suffix: '' } } });
    expect(codeLanguages(f)).toEqual(['python', 'cpp', 'go']);
    expect(codeRequestFromForm(f, [{ stdin: '1\n', expectedStdout: '2\n', name: 'Example 1' } as never], 'id-1')).toEqual({
      itemId: 'id-1',
      title: 'Coin Change',
      body: '## Input',
      interface: 'function',
      languages: ['python', 'cpp', 'go'],
      samples: [{ stdin: '1\n', expectedStdout: '2\n' }],
    });
    expect(codeRequestFromForm(f, [], null)).not.toHaveProperty('itemId');
  });
});

const answer: AiCodeResponse = {
  starterCode: { python: 'stub', cpp: 'stub cpp' },
  harness: { python: { prefix: 'p', suffix: 's' }, cpp: { prefix: 'cp', suffix: 'cs' } },
  check: {
    attempted: true,
    engine: 'judge0',
    runners: [
      { language: 'cpp', status: 'failed', error: 'does not compile' },
      { language: 'python', status: 'ok', error: null },
      { language: 'rust', status: 'skipped', error: null },
    ],
  },
  style: null,
  usage: { logId: null, model: 'm', durationMs: 1, inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
};

describe('withGeneratedCode', () => {
  it('replaces the languages that came back and keeps the rest', () => {
    const before = form({ interface: 'function', starterCode: { python: 'old', go: 'mine' }, harness: { python: { prefix: 'old', suffix: '' }, go: { prefix: 'g', suffix: '' } } });
    const after = withGeneratedCode(before, answer, 'function');
    expect(after.starterCode).toEqual({ python: 'stub', go: 'mine', cpp: 'stub cpp' });
    expect(after.harness).toEqual({ python: { prefix: 'p', suffix: 's' }, go: { prefix: 'g', suffix: '' }, cpp: { prefix: 'cp', suffix: 'cs' } });
    // A full program's runners stay as they are, for switching back.
    expect(withGeneratedCode(before, { starterCode: { python: 'reads n' }, harness: {} }, 'program').harness).toBe(before.harness);
  });
});

describe('currentRunnerChecks', () => {
  it('keeps a runner check while its language is as it was checked', () => {
    const checked = checkedCode(answer);
    const f = withGeneratedCode(form({ interface: 'function' }), answer, 'function');
    expect([...currentRunnerChecks(f, checked).entries()]).toEqual([
      ['cpp', answer.check!.runners[0]],
      ['python', answer.check!.runners[1]],
    ]);
    // Editing a language's stub or runner drops its mark, and only its.
    const edited = { ...f, harness: { ...f.harness, cpp: { prefix: 'cp', suffix: 'cs // edited' } } };
    expect([...currentRunnerChecks(edited, checked).keys()]).toEqual(['python']);
    expect([...currentRunnerChecks({ ...f, starterCode: { ...f.starterCode, python: 'x' } }, checked).keys()]).toEqual(['cpp']);
    // A full program shows none, and nor does a form without a check.
    expect(currentRunnerChecks({ ...f, interface: 'program' }, checked).size).toBe(0);
    expect(currentRunnerChecks(f, null).size).toBe(0);
  });
});
