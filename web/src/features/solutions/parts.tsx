import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Limits } from '../../api/types';
import { Button } from '../../ui/Button';
import { Badge, Callout, ErrorCallout } from '../../ui/misc';
import { isSolutionLimitError, type SolutionWrite } from './solutionWrites';

/** The marker of the solution that is run to verify expected outputs. */
export function ReferenceBadge() {
  return (
    <Badge tone="accent" title="Run to check the expected output of each test case">
      <ShieldCheck size={12} aria-hidden="true" /> Reference
    </Badge>
  );
}

/**
 * What a solution write shows when it did not go through: the revision
 * conflict with its "Save anyway", the limit on saved solutions, or the
 * error. Renders nothing while there is nothing to report.
 */
export function WriteProblems({
  write,
  limits,
  title = 'Could not save the solution',
  consequence,
  hideError,
}: {
  write: SolutionWrite;
  limits: Limits | undefined;
  title?: string;
  /** What "Save anyway" will do, in a sentence. */
  consequence?: ReactNode;
  /** The error is already shown next to the fields it is about. */
  hideError?: boolean;
}) {
  if (write.conflict) {
    return (
      <Callout
        tone="warn"
        role="alert"
        title="This problem was changed elsewhere"
        actions={
          <>
            <Button size="sm" onClick={() => void write.saveAnyway()} busy={write.busy}>
              Save anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={write.reset} disabled={write.busy}>
              Dismiss
            </Button>
          </>
        }
      >
        Another tab or an assistant connected over MCP edited this problem while it was open, possibly its statement or reference solution. Nothing was saved, and the page now shows the current
        version. {consequence ?? 'Saving anyway applies your change on top of it.'}
      </Callout>
    );
  }
  if (write.error == null || hideError) return null;
  if (isSolutionLimitError(write.error)) {
    return (
      <Callout tone="danger" role="alert" title={limits ? `This problem already has the maximum of ${limits.maxSolutionsPerItem.toLocaleString()} saved solutions` : 'This problem has the maximum number of saved solutions'}>
        Nothing was saved. Delete a solution you no longer need, then save again.
      </Callout>
    );
  }
  return <ErrorCallout error={write.error} title={title} />;
}
