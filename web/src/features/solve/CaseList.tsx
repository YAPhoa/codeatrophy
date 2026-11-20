import { Eye, EyeOff, FlaskConical, Settings2 } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Item, TestCase } from '../../api/types';
import { describeCases } from '../../lib/format';
import { textFilename } from '../../lib/largeText';
import { Button, LinkButton } from '../../ui/Button';
import { Callout, ErrorState, PageLoading } from '../../ui/misc';
import { Output } from './ResultPanel';
import type { Reveal } from './useReveal';

interface CaseListProps {
  item: Item;
  cases: UseQueryResult<TestCase[]>;
  reveal: Reveal;
  aiEnabled: boolean;
  /** Offer to run the program on a case's input; absent when code cannot be run. */
  onUseInput?: (stdin: string) => void;
}

/**
 * The problem's test cases as the solver sees them: how many there are, the
 * sample cases in full, and the hidden ones only as far as the user's
 * preference (or an explicit reveal) allows.
 */
export function CaseList({ item, cases, reveal, aiEnabled, onUseInput }: CaseListProps) {
  if (cases.isPending) return <PageLoading />;
  if (cases.isError) return <ErrorState compact error={cases.error} onRetry={() => void cases.refetch()} />;

  const list = cases.data;
  if (list.length === 0) {
    return (
      <Callout
        tone="info"
        title="No test cases yet"
        actions={
          <>
            <LinkButton size="sm" to={`/items/${item.id}/tests`}>
              Add test cases
            </LinkButton>
            {aiEnabled && (
              <LinkButton size="sm" to={`/items/${item.id}/tests/generate`} icon={<FlaskConical size={14} />}>
                Generate with AI
              </LinkButton>
            )}
          </>
        }
      >
        Without test cases this problem cannot be judged. You can still run your code against a custom input.
      </Callout>
    );
  }

  const samples = list.filter((c) => c.isSample).length;
  const concealed = list.filter((c) => reveal.conceals(c)).length;
  const revealedSome = reveal.hiding && concealed < list.length - samples;

  return (
    <div className="tcases">
      <div className="tcases-head">
        <span className="tcases-summary">{describeCases(list.length, samples)}</span>
        <span className="spacer" />
        {concealed > 0 && (
          <Button size="sm" icon={<Eye size={14} />} onClick={reveal.revealAll}>
            Reveal all
          </Button>
        )}
        {revealedSome && concealed === 0 && (
          <Button size="sm" variant="ghost" icon={<EyeOff size={14} />} onClick={reveal.reset}>
            Hide again
          </Button>
        )}
        <LinkButton size="sm" variant="ghost" to={`/items/${item.id}/tests`} icon={<Settings2 size={14} />}>
          Manage
        </LinkButton>
      </div>

      {/* Concealed cases say nothing but their number, so they share one row: a number reveals its case in its place below. */}
      {concealed > 0 && (
        <div className="tcases-hidden" role="group" aria-label="Hidden cases">
          <span className="tcases-hidden-label" aria-hidden="true">
            Hidden
          </span>
          {list.map((c, i) =>
            reveal.conceals(c) ? (
              <button key={c.id} type="button" className="tcase-chip" onClick={() => reveal.reveal(c.id)} aria-label={`Reveal case ${i + 1}`} title="Reveal">
                {i + 1}
              </button>
            ) : null,
          )}
        </div>
      )}

      {concealed < list.length && (
        <ol className="tcase-list">
          {list.map((c, i) => {
            const number = i + 1;
            if (reveal.conceals(c)) return null;
            return (
              <li key={c.id} className="tcase">
                <div className="tcase-head">
                  <span className="tcase-name">{c.name || `Case ${number}`}</span>
                  {/* While a hidden case is revealed, a Hide button takes the place of its tag. */}
                  {reveal.hiding && !c.isSample ? (
                    <Button size="sm" variant="ghost" icon={<EyeOff size={14} />} onClick={() => reveal.hide(c.id)} aria-label={`Hide case ${number}`}>
                      Hide
                    </Button>
                  ) : (
                    <span className="chip">{c.isSample ? 'sample' : 'hidden'}</span>
                  )}
                  <span className="spacer" />
                  {onUseInput && (
                    <Button size="sm" variant="ghost" onClick={() => onUseInput(c.stdin)} title="Copy this input to the Custom input tab">
                      Use as custom input
                    </Button>
                  )}
                </div>
                <div className="io-pair">
                  <Output label="Input" text={c.stdin} filename={textFilename(item.title, c.name || `case ${number}`, 'input')} />
                  <Output label="Expected output" text={c.expectedStdout} filename={textFilename(item.title, c.name || `case ${number}`, 'output')} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
