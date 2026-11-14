import { Link, useParams } from 'react-router';
import { ArrowRight, CheckCircle2, EyeOff, FlaskConical, Plus } from 'lucide-react';
import { useItem, useMeta } from '../../api/queries';
import type { Item, SourceCode } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { plural } from '../../lib/format';
import { languageName } from '../../lib/languages';
import { readString } from '../../lib/storage';
import { LinkButton } from '../../ui/Button';
import { ErrorState, PageLoading } from '../../ui/misc';
import { DifficultyBadge, TagChips } from '../item/controls';
import { TestButton, TestOutcome, useSolutionTest } from '../solutions/SolutionTest';
import { VariantCard } from './VariantCard';

/**
 * The reference solution that was saved with the problem — the AI's own, for
 * a draft. It can be tried on the test cases from here; its code is only
 * shown on the Solutions page, on request.
 */
function SavedSolution({ item, solution }: { item: Item; solution: SourceCode }) {
  const test = useSolutionTest(item, { language: solution.language, isReference: true });
  return (
    <section className="saved-solution" aria-labelledby="saved-solution-title">
      <div className="row">
        <EyeOff size={16} aria-hidden="true" />
        <h2 id="saved-solution-title">Reference solution</h2>
        <span className="muted">{languageName(solution.language)}, kept hidden</span>
        <span className="spacer" />
        <TestButton test={test} label="Test it" />
        <Link to={`/items/${item.id}/solutions`}>Solutions</Link>
      </div>
      <TestOutcome item={item} test={test} />
    </section>
  );
}

/**
 * Shown right after a problem is saved: confirms the save and offers the
 * natural next steps — a full test suite, a variant to practise on — without
 * requiring either.
 */
export default function SavedPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  const meta = useMeta();
  useDocumentTitle(item.data ? `Saved: ${item.data.title}` : 'Saved');

  if (item.isPending) return <PageLoading />;
  if (item.isError) {
    return (
      <div className="page">
        <ErrorState page error={item.error} onRetry={() => void item.refetch()} />
      </div>
    );
  }
  const it = item.data;
  const aiEnabled = meta.data?.ai.enabled ?? false;
  const judge = meta.data?.judge;
  const isProblem = it.type === 'problem';

  return (
    <div className="page page-narrow saved">
      <div className="saved-banner" role="status">
        <CheckCircle2 size={22} aria-hidden="true" />
        <div className="grow">
          <p className="saved-kicker">Saved to your library</p>
          <h1 className="page-title">{it.title}</h1>
          <div className="row-wrap saved-meta">
            <DifficultyBadge difficulty={it.difficulty} />
            {isProblem && <span className="muted">{it.testCaseCount === 0 ? 'no test cases yet' : plural(it.testCaseCount, 'test case')}</span>}
            <TagChips tags={it.tags} max={5} />
          </div>
        </div>
        <LinkButton to={`/items/${it.id}`} variant="primary" icon={<ArrowRight size={16} />}>
          {isProblem ? 'Open and solve' : 'Open'}
        </LinkButton>
      </div>

      {it.problem?.referenceSolution && <SavedSolution item={it} solution={it.problem.referenceSolution} />}

      {isProblem && (
        <>
          <h2 className="saved-next">Next steps</h2>
          <div className="next-cards">
            <section className="next-card" aria-labelledby="next-tests">
              <div className="next-card-icon" aria-hidden="true">
                <FlaskConical size={18} />
              </div>
              <h3 id="next-tests">Add hidden test cases</h3>
              {aiEnabled ? (
                <p>
                  The AI writes a reference solution and proposes edge cases, such as the smallest inputs and inputs at the limits.{' '}
                  {judge?.enabled
                    ? 'Each expected output comes from running the solution, and you choose which cases to keep.'
                    : 'Without a judge engine the expected outputs are the model’s predictions, so they are kept as unverified.'}
                </p>
              ) : (
                <p>Samples alone rarely catch a wrong solution. Add hidden cases by hand now, or set up an AI provider to have them proposed for you.</p>
              )}
              <div className="next-card-actions">
                {aiEnabled ? (
                  <LinkButton to={`/items/${it.id}/tests/generate`} icon={<FlaskConical size={14} />}>
                    Generate test cases
                  </LinkButton>
                ) : (
                  <>
                    <LinkButton to={`/items/${it.id}/tests`}>Add test cases</LinkButton>
                    <Link to="/settings/ai">Set up AI</Link>
                  </>
                )}
              </div>
            </section>

            <VariantCard item={it} aiEnabled={aiEnabled} />
          </div>
        </>
      )}

      <div className="saved-foot">
        <LinkButton to="/new" variant="ghost" icon={<Plus size={14} />}>
          Capture another
        </LinkButton>
        <LinkButton to={readString('library:last') ?? '/'} variant="ghost">
          Back to the library
        </LinkButton>
      </div>
    </div>
  );
}
