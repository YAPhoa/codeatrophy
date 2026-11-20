import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { qk, useAiLog, useAiLogEntry, useAiSettings } from '../../api/queries';
import type { AiLogDetail, AiLogEntry, AiLogFilters, AiLogStatus, AiOperation } from '../../api/types';
import { OPERATIONS, OPERATION_LABEL, entryFacts, exportName, filterParams, filtersFrom, logProviders, rawRequest, rawResponse, thirtyDaysBefore, type RawText } from '../../lib/aiLog';
import { saveJson } from '../../lib/download';
import { parsePage, setPageSize, usePageSize, withPage } from '../../lib/paging';
import { errorLine, sentence } from '../../lib/errors';
import { absoluteTime, formatDuration, formatTokens, relativeTime } from '../../lib/format';
import { Button, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { Collapse, ExpandChevron } from '../../ui/Collapse';
import { Dialog } from '../../ui/Dialog';
import { SelectField } from '../../ui/Field';
import { Badge, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { Pager } from '../library/Pager';

const ANY = '';

const STATUS_OPTIONS: { value: AiLogStatus | typeof ANY; label: string }[] = [
  { value: ANY, label: 'Any outcome' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const OPERATION_OPTIONS: { value: AiOperation | typeof ANY; label: string }[] = [{ value: ANY, label: 'All requests' }, ...OPERATIONS.map((o) => ({ value: o, label: OPERATION_LABEL[o] }))];

/** The log's page size, kept apart from the library's. */
const PAGE_SIZE_KEY = 'aiLogPageSize';

/**
 * The requests sent to AI providers, newest first, a numbered page at a
 * time like the library: the page is in the address with the filters, and
 * changing a filter goes back to the first. Rows are plain and of one
 * height; what was sent and what came back is fetched only for a row that
 * is opened.
 */
export function AiActivitySection() {
  const [params, setParams] = useSearchParams();
  const filters = filtersFrom(params);
  // An entry linked to from where it was generated arrives opened.
  const linked = params.get('entry');
  const pageSize = usePageSize(PAGE_SIZE_KEY);
  const page = parsePage(params);
  const offset = (page - 1) * pageSize;
  const log = useAiLog(filters, pageSize, offset);
  const providers = useAiSettings().data?.providers;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(linked ? [linked] : []));
  const [clearing, setClearing] = useState(false);

  const entries = log.data?.items ?? [];
  const total = log.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const filtered = Object.keys(filters).length > 0;
  // Shown on its own while the page shown does not hold it.
  const apart = linked !== null && log.data !== undefined && !entries.some((e) => e.id === linked);

  // A page past the end (entries cleared, a link kept from a longer log) shows the last one instead.
  const pastEnd = log.isSuccess && !log.isPlaceholderData && page > pageCount;
  useEffect(() => {
    if (pastEnd) setParams((sp) => withPage(sp, pageCount), { replace: true });
  }, [pastEnd, pageCount, setParams]);

  // Another page starts at the list's top: brought into view if it is scrolled past.
  const top = useRef<HTMLDivElement>(null);
  const shownPage = useRef(page);
  useEffect(() => {
    if (shownPage.current === page) return;
    shownPage.current = page;
    const el = top.current;
    const scroller = el?.closest('.main');
    if (el && scroller && el.getBoundingClientRect().top < scroller.getBoundingClientRect().top) el.scrollIntoView({ block: 'start' });
  }, [page]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // New filters start again from the first page.
  const setFilters = (next: AiLogFilters) => setParams(filterParams(next), { replace: true });

  return (
    <section className="settings-section" aria-labelledby="ai-activity-title">
      <div className="row">
        <h1 id="ai-activity-title" className="page-title">
          AI activity
        </h1>
        <span className="spacer" />
        <Button variant="ghost" icon={<Download size={14} />} onClick={() => saveJson(entries, 'ai-activity.json')} disabled={entries.length === 0} title="The entries on this page">
          Export list
        </Button>
        <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setClearing(true)}>
          Clear…
        </Button>
      </div>
      <p className="settings-lead">Logs for every request sent to AI providers.</p>

      <div className="row log-filters" ref={top}>
        <SelectField
          label="Provider"
          hideLabel
          value={filters.providerId ?? ANY}
          onChange={(providerId) => setFilters({ ...filters, providerId: providerId || undefined })}
          options={[{ value: ANY, label: 'All providers' }, ...logProviders(providers ?? [], entries, filters.providerId ?? null)]}
        />
        <SelectField label="Kind of request" hideLabel value={filters.operation ?? ANY} onChange={(operation) => setFilters({ ...filters, operation: operation || undefined })} options={OPERATION_OPTIONS} />
        <SelectField label="Outcome" hideLabel value={filters.status ?? ANY} onChange={(status) => setFilters({ ...filters, status: status || undefined })} options={STATUS_OPTIONS} />
      </div>

      {log.isPending ? (
        <PageLoading />
      ) : log.isError ? (
        <ErrorState compact error={log.error} onRetry={() => void log.refetch()} />
      ) : (
        <>
          {apart && linked && (
            <ul className="card log-list" aria-label="The linked request">
              <LinkedEntry id={linked} onClose={() => setParams(filterParams(filters), { replace: true })} />
            </ul>
          )}
          {entries.length === 0 ? (
            <p className="editor-empty">{filtered ? 'No requests match.' : 'No requests yet.'}</p>
          ) : (
            <div className={cx('card log-table', log.isPlaceholderData && 'is-stale')}>
              <div className="log-row log-head" aria-hidden="true">
                <span />
                <span>Request</span>
                <span>Provider</span>
                <span>Model</span>
                <span className="log-num">In</span>
                <span className="log-num">Out</span>
                <span className="log-num">Time</span>
                <span className="log-when">When</span>
              </div>
              <ul className="log-list" aria-label="Requests">
                {entries.map((e) => (
                  <LogRow key={e.id} entry={e} open={open.has(e.id)} onToggle={() => toggle(e.id)} />
                ))}
              </ul>
              <div className="item-list-foot">
                <Pager
                  page={page}
                  pageCount={pageCount}
                  offset={offset}
                  shown={entries.length}
                  total={total}
                  pageSize={pageSize}
                  onPageSize={(size) => {
                    setPageSize(size, PAGE_SIZE_KEY);
                    setParams((sp) => withPage(sp, 1), { replace: true });
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}

      <ClearDialog open={clearing} onClose={() => setClearing(false)} onCleared={() => setOpen(new Set())} />
    </section>
  );
}

const STATUS_TONE = { failed: 'danger', cancelled: 'warn' } as const;

const tokens = (n: number | null) => (n == null ? '—' : formatTokens(n));

/** One request: what it was and its key figures in a line, opening in place to the rest. */
/** The column a value belongs to, for a screen reader: the visible header row is not tied to the rows. */
function Col({ children }: { children: string }) {
  return <span className="sr-only">, {children}: </span>;
}

function LogRow({ entry, open, onToggle }: { entry: AiLogEntry; open: boolean; onToggle: () => void }) {
  const what = `${OPERATION_LABEL[entry.operation]}${entry.title ? ` · ${entry.title}` : ''}`;
  return (
    <li className={cx('log-entry', open && 'is-open')}>
      <button type="button" className="log-row" aria-expanded={open} onClick={onToggle}>
        <ExpandChevron open={open} />
        <span className="log-what" title={what}>
          <span className="truncate">
            <strong>{OPERATION_LABEL[entry.operation]}</strong>
            {entry.title && ` · ${entry.title}`}
          </span>
          {entry.status !== 'ok' && <Badge tone={STATUS_TONE[entry.status]}>{entry.status}</Badge>}
        </span>
        <span className="truncate">
          <Col>Provider</Col>
          {entry.providerName}
        </span>
        <span className="truncate" title={entry.model}>
          <Col>Model</Col>
          {entry.model}
        </span>
        <span className="log-num" title={entry.usage.inputTokens == null ? undefined : `${entry.usage.inputTokens.toLocaleString()} tokens in`}>
          <Col>Tokens in</Col>
          {tokens(entry.usage.inputTokens)}
        </span>
        <span className="log-num" title={entry.usage.outputTokens == null ? undefined : `${entry.usage.outputTokens.toLocaleString()} tokens out`}>
          <Col>Tokens out</Col>
          {tokens(entry.usage.outputTokens)}
        </span>
        <span className="log-num">
          <Col>Time</Col>
          {formatDuration(entry.durationMs)}
        </span>
        <span className="log-when">
          <Col>When</Col>
          <time dateTime={entry.createdAt} title={absoluteTime(entry.createdAt)}>
            {relativeTime(entry.createdAt)}
          </time>
        </span>
      </button>
      <Collapse open={open}>
        <LogDetail entry={entry} />
      </Collapse>
    </li>
  );
}

/** The rest of an opened entry. Its raw texts are fetched here, and let go when it closes. */
function LogDetail({ entry }: { entry: AiLogEntry }) {
  const detail = useAiLogEntry(entry.id);
  return (
    <div className="log-detail">
      {entry.error && (
        <p className="check-line tone-danger" role="status">
          {sentence(entry.error)}
        </p>
      )}
      <dl className="log-facts">
        {entryFacts(entry, absoluteTime(entry.createdAt)).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {detail.isPending ? <PageLoading /> : detail.isError ? <ErrorState compact error={detail.error} onRetry={() => void detail.refetch()} /> : <RawMessages detail={detail.data} />}
    </div>
  );
}

/** An entry opened by its address that the loaded part of the list does not hold. */
function LinkedEntry({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useAiLogEntry(id);
  if (detail.data) return <LogRow entry={detail.data} open onToggle={onClose} />;
  return <li className="log-entry log-gone muted">{detail.isError ? 'This request is not in the log.' : 'Loading…'}</li>;
}

/** What was sent and what came back. Raw text, never rendered: it holds pasted input and model output. */
function RawMessages({ detail }: { detail: AiLogDetail }) {
  return (
    <>
      {detail.truncated && <p className="muted">Cut off at 256&nbsp;KiB.</p>}
      <Raw label="Request" raw={rawRequest(detail.request)}>
        <Button size="sm" variant="ghost" icon={<Download size={14} />} onClick={() => saveJson(detail, exportName(detail))}>
          Export
        </Button>
      </Raw>
      {detail.response === null ? <p className="muted">No response arrived.</p> : <Raw label="Response" raw={rawResponse(detail.response)} />}
    </>
  );
}

function Raw({ label, raw, children }: { label: string; raw: RawText; children?: ReactNode }) {
  return (
    <div className="io-block">
      <div className="io-label row">
        {label}
        <span className="spacer" />
        {children}
      </div>
      <div className="editor-frame log-code">
        <CodeEditor value={raw.text} language={raw.language} readOnly wrap ariaLabel={label} />
      </div>
    </div>
  );
}

/** Clearing the log: the older part, or all of it. */
function ClearDialog({ open, onClose, onCleared }: { open: boolean; onClose: () => void; onCleared: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setAll(false);
  }, [open]);

  const clear = async () => {
    setBusy(true);
    try {
      await api.settings.clearLog(all ? undefined : thirtyDaysBefore());
      onCleared();
      await qc.invalidateQueries({ queryKey: qk.aiLog });
      toast.success(all ? 'Log cleared' : 'Older requests cleared');
      onClose();
    } catch (error) {
      toast.error(errorLine(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Clear the AI activity log"
      size="sm"
      locked={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void clear()} busy={busy}>
            Clear log
          </Button>
        </>
      }
    >
      <fieldset className="proposal-mode">
        <legend className="sr-only">What to clear</legend>
        <label className="check">
          <input type="radio" name="clear-log" checked={!all} onChange={() => setAll(false)} />
          <span>Older than 30 days</span>
        </label>
        <label className="check">
          <input type="radio" name="clear-log" checked={all} onChange={() => setAll(true)} />
          <span>Everything</span>
        </label>
      </fieldset>
      <p className="dialog-text log-clear-note">The totals on the AI providers page stay.</p>
    </Dialog>
  );
}
