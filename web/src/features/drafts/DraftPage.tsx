import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FileX } from 'lucide-react';
import { isApiError } from '../../api/client';
import { useItem } from '../../api/queries';
import type { Item } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { LinkButton } from '../../ui/Button';
import { EmptyState, ErrorState, PageLoading } from '../../ui/misc';
import { CaptureDraft } from '../capture/CapturePage';
import { VariantDraft, inheritedFrom } from '../capture/VariantPage';
import { draftQuery, useServerDraft } from './useServerDraft';

/** A draft's own page: its input while it has no form yet, then its review. */
export default function DraftPage() {
  const { id = '' } = useParams();
  const draft = useQuery(draftQuery(id));
  const variantOf = draft.data?.variantOf ?? undefined;
  const original = useItem(variantOf);
  if (draft.isPending || (variantOf !== undefined && original.isPending)) return <PageLoading />;
  if (draft.isError) {
    if (isApiError(draft.error) && draft.error.code === 'not_found') return <DraftGone />;
    return (
      <div className="page">
        <ErrorState page error={draft.error} onRetry={() => void draft.refetch()} />
      </div>
    );
  }
  // An original deleted since is no reason not to review the variant.
  return <DraftScreen key={id} id={id} original={original.data ?? null} />;
}

function DraftGone() {
  useDocumentTitle('Draft not found');
  return (
    <div className="page">
      <EmptyState icon={<FileX size={20} />} page title="This draft is gone" actions={<LinkButton to="/drafts">All drafts</LinkButton>}>
        It was saved to the library or discarded.
      </EmptyState>
    </div>
  );
}

function DraftScreen({ id, original }: { id: string; original: Item | null }) {
  const inherited = useMemo(() => inheritedFrom(original), [original]);
  const sd = useServerDraft(id, inherited);
  if (!sd.draft || !sd.content) return <PageLoading />;
  return sd.draft.kind === 'variant' ? <VariantDraft sd={sd} content={sd.content} original={original} /> : <CaptureDraft sd={sd} content={sd.content} />;
}
