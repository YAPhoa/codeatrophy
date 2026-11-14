import { useParams } from 'react-router';
import { FileQuestion } from 'lucide-react';
import { isApiError } from '../../api/client';
import { useItem } from '../../api/queries';
import { useDeclareWorkspace } from '../../app/shellLayout';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { LinkButton } from '../../ui/Button';
import { EmptyState, ErrorState, PageLoading } from '../../ui/misc';
import { ReaderView } from '../reader/ReaderView';
import { SolveView } from '../solve/SolveView';
import { libraryHref } from './itemActions';

export function ItemMissing() {
  return (
    <div className="page">
      <EmptyState icon={<FileQuestion size={20} />} page title="This item does not exist" actions={<LinkButton to={libraryHref()}>Back to the library</LinkButton>}>
        It may have been deleted here, in another tab, or by an assistant connected over MCP.
      </EmptyState>
    </div>
  );
}

/** An item's main page: the solving workspace for a problem, the reader for a reading. */
export default function ItemPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  useDocumentTitle(item.data?.title);
  // A problem opens in the coding workspace, where the navigation steps aside; a reading does not.
  useDeclareWorkspace(item.data ? item.data.type === 'problem' : null);

  if (item.isPending) return <PageLoading />;
  if (item.isError) {
    if (isApiError(item.error) && item.error.code === 'not_found') return <ItemMissing />;
    return (
      <div className="page">
        <ErrorState page error={item.error} onRetry={() => void item.refetch()} />
      </div>
    );
  }
  return item.data.type === 'problem' ? <SolveView key={item.data.id} item={item.data} /> : <ReaderView key={item.data.id} item={item.data} />;
}
