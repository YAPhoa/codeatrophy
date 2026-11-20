import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FilePen, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateJobs, qk, useDrafts } from '../../api/queries';
import type { DraftSummary } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { absoluteTime, relativeTime } from '../../lib/format';
import { cx, IconButton, LinkButton } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Badge, EmptyState, ErrorState, PageLoading, Spinner } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { draftStateLabel } from '../jobs/labels';

/**
 * Every draft in progress, most recently changed first: what it is called,
 * where it stands and when it was last touched. A draft opens on its review.
 */
export default function DraftsPage() {
  useDocumentTitle('Drafts');
  const drafts = useDrafts();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();

  const discard = async (draft: DraftSummary) => {
    const ok = await confirm({ title: 'Discard this draft?', body: `“${draft.title}” is thrown away. Nothing has been saved to the library.`, confirmLabel: 'Discard draft', danger: true });
    if (!ok) return;
    try {
      await api.drafts.remove(draft.id);
      if (draft.job) await api.ai.dismiss(draft.job.id).catch(() => undefined);
      qc.removeQueries({ queryKey: qk.draft(draft.id) });
    } catch (e) {
      toast.error(e);
    }
    void invalidateJobs(qc);
  };

  if (drafts.isPending) return <PageLoading />;
  if (drafts.isError) {
    return (
      <div className="page">
        <ErrorState page error={drafts.error} onRetry={() => void drafts.refetch()} />
      </div>
    );
  }
  const list = drafts.data;

  return (
    <div className="page page-narrow drafts-page">
      <div className="page-header">
        <h1 className="page-title">
          Drafts
          {list.length > 0 && <span className="page-count">{list.length}</span>}
        </h1>
        <span className="spacer" />
        <LinkButton to="/new" icon={<Plus size={14} />}>
          New item
        </LinkButton>
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<FilePen size={20} />} title="No drafts">
          New items wait here until they are saved to the library.
        </EmptyState>
      ) : (
        <ul className="drafts-list" aria-label="Drafts">
          {list.map((d) => {
            const state = draftStateLabel(d);
            return (
              <li key={d.id} className={cx('draft-row', d.state === 'ready' && 'is-ready')}>
                <Link to={`/drafts/${d.id}`} className="draft-link">
                  <span className="draft-title truncate">{d.title}</span>
                  <span className="draft-meta">
                    {d.kind === 'variant' && <span className="draft-kind">Variant</span>}
                    <Badge tone={state.tone} className="draft-state">
                      {d.state === 'drafting' && <Spinner size={11} />}
                      {state.text}
                    </Badge>
                    <time dateTime={d.updatedAt} title={absoluteTime(d.updatedAt)} className="draft-time">
                      {relativeTime(d.updatedAt)}
                    </time>
                  </span>
                </Link>
                <IconButton label={`Discard ${d.title}`} size="sm" icon={<Trash2 size={14} />} onClick={() => void discard(d)} className="draft-discard" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
