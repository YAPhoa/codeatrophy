import { Compass } from 'lucide-react';
import { LinkButton } from '../ui/Button';
import { useRouteError } from 'react-router';
import { EmptyState, ErrorState } from '../ui/misc';
import { useDocumentTitle } from './useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Not found');
  return (
    <div className="page">
      <EmptyState icon={<Compass size={20} />} page title="There is nothing at this address" actions={<LinkButton to="/">Back to the library</LinkButton>}>
        The link may be out of date, or the item was deleted.
      </EmptyState>
    </div>
  );
}

/** Last-resort screen for an error thrown while rendering a route. */
export function RouteError() {
  const error = useRouteError();
  return (
    <div className="boot">
      <ErrorState error={error} page title="This screen failed to load" onRetry={() => window.location.reload()} />
    </div>
  );
}
