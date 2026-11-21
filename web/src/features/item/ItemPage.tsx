import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { FileQuestion } from 'lucide-react';
import { isApiError } from '../../api/client';
import { useItem, useTestCases, useWorkspace } from '../../api/queries';
import { rememberItemKind, useDeclareWorkspace } from '../../app/shellLayout';
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
  const type = item.data?.type;
  useEffect(() => {
    if (type) rememberItemKind(id, type === 'reading');
  }, [id, type]);

  // A problem's workspace opens with its test cases (the drawer, the Run
  // hint) and with the code written on it, so it waits for them too and
  // appears whole, behind one indicator: the editor never shows the starter
  // code first. The code is read fresh unless this tab has just read or
  // saved it, and only once: a read later on never replaces an open editor.
  const problem = type === 'problem';
  const cases = useTestCases(id, problem);
  const workspace = useWorkspace(id, problem);
  const [opened, setOpened] = useState<string | null>(null);
  const codeReady = opened === id || (workspace.isSuccess && !(workspace.isFetching && workspace.isStale));
  if (item.isPending || (problem && (cases.isPending || (!codeReady && !workspace.isError)))) return <PageLoading />;
  if (problem && opened !== id && workspace.isError) {
    if (isApiError(workspace.error) && workspace.error.code === 'not_found') return <ItemMissing />;
    return (
      <div className="page">
        <ErrorState page error={workspace.error} onRetry={() => void workspace.refetch()} />
      </div>
    );
  }
  if (item.isError) {
    if (isApiError(item.error) && item.error.code === 'not_found') return <ItemMissing />;
    return (
      <div className="page">
        <ErrorState page error={item.error} onRetry={() => void item.refetch()} />
      </div>
    );
  }
  if (item.data.type !== 'problem') return <ReaderView key={item.data.id} item={item.data} />;
  if (opened !== id) setOpened(id);
  return <SolveView key={item.data.id} item={item.data} workingCopies={workspace.data?.items ?? []} />;
}
