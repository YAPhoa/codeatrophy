import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileArchive, Upload } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateLibrary, useMeta } from '../../api/queries';
import type { ImportItemState, ImportPreview, ImportResult, ImportStrategy } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { absoluteTime, describeChanges, formatBytes, plural, type Tone } from '../../lib/format';
import { Button, LinkButton, cx } from '../../ui/Button';
import { Badge, Callout, ErrorCallout, Spinner } from '../../ui/misc';
import { TypeIcon } from '../item/controls';
import { ShareTabs } from './ShareTabs';

const STATE_LABEL: Record<ImportItemState, string> = { new: 'New', changed: 'Changed', unchanged: 'Unchanged' };
const STATE_TONE: Record<ImportItemState, Tone> = { new: 'ok', changed: 'warn', unchanged: 'neutral' };

const STRATEGIES: { value: ImportStrategy; title: string; text: string }[] = [
  {
    value: 'skip',
    title: 'Keep mine',
    text: 'Leave the items you already have exactly as they are. Only new items are added.',
  },
  {
    value: 'overwrite',
    title: 'Take the bundle’s version',
    text: 'Replace the content, solutions and test cases of changed items with the bundle’s. Your status, notes, favorites and submissions are kept, and so are your solutions and hidden test cases where the bundle was exported without them.',
  },
  {
    value: 'duplicate',
    title: 'Keep both',
    text: 'Leave your versions alone and add the bundle’s versions as separate new items.',
  },
];

/**
 * Import a bundle in two steps: a preview that writes nothing and shows what
 * is new, changed and unchanged, then the import itself with the chosen
 * strategy for changed items.
 */
export default function ImportPage() {
  useDocumentTitle('Import');
  const qc = useQueryClient();
  const meta = useMeta().data;
  const maxBytes = meta?.limits.maxImportBytes ?? Infinity;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>('skip');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setError(null);
    setResult(null);
    setStrategy('skip');
    if (inputRef.current) inputRef.current.value = '';
  };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setResult(null);
    setPreview(null);
    setError(null);
    setFile(f);
    if (f.size > maxBytes) return;
    setPreviewing(true);
    try {
      setPreview(await api.bundle.preview(f));
    } catch (e) {
      setError(e);
    } finally {
      setPreviewing(false);
    }
  };

  const run = async () => {
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.bundle.import(file, strategy);
      setResult(res);
      await invalidateLibrary(qc);
    } catch (e) {
      setError(e);
    } finally {
      setImporting(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void choose(e.dataTransfer.files[0]);
  };

  const tooLarge = file !== null && file.size > maxBytes;
  const counts = preview?.counts;
  const nothingToDo = counts ? counts.new === 0 && (counts.changed === 0 || strategy === 'skip') && preview.collections.every((c) => c.state === 'existing') : false;
  const visibleItems = preview ? (showUnchanged ? preview.items : preview.items.filter((i) => i.state !== 'unchanged')) : [];

  return (
    <div className="page page-narrow share">
      <ShareTabs active="import" />
      <h1 className="page-title">Import a bundle</h1>
      <p className="page-sub">
        Bring in a <code translate="no">.codeatrophy.zip</code> exported from this or another instance. You see exactly what would change before anything is written, and an import is applied completely or not at
        all.
      </p>

      {result ? (
        <div className="stack">
          <Callout tone="ok" role="status" title="Import complete">
            <ul className="import-result">
              <li>{plural(result.created, 'item')} added</li>
              {result.updated > 0 && <li>{plural(result.updated, 'item')} updated to the bundle’s version</li>}
              {result.duplicated > 0 && <li>{result.duplicated === 1 ? '1 item added as a separate copy' : `${result.duplicated} items added as separate copies`}</li>}
              {result.skipped > 0 && <li>{plural(result.skipped, 'changed item')} left as they were</li>}
              {result.unchanged > 0 && <li>{plural(result.unchanged, 'item')} already up to date</li>}
              {result.collectionsCreated > 0 && <li>{plural(result.collectionsCreated, 'collection')} created</li>}
            </ul>
          </Callout>
          {result.warnings.length > 0 && <Warnings warnings={result.warnings} />}
          <div className="form-actions">
            <LinkButton to="/?sort=created" variant="primary">
              See the library
            </LinkButton>
            <Button onClick={reset}>Import another bundle</Button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <div
            className={cx('dropzone', dragOver && 'is-over', file && 'has-file')}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <input
              ref={inputRef}
              id="bundle-file"
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              onChange={(e) => void choose(e.target.files?.[0])}
              disabled={previewing || importing}
            />
            {file ? (
              <>
                <FileArchive size={20} aria-hidden="true" />
                <div className="grow">
                  <strong className="truncate">{file.name}</strong>
                  <div className="muted">{formatBytes(file.size)}</div>
                </div>
                {previewing && <Spinner label="Reading the bundle…" />}
                <Button size="sm" onClick={reset} disabled={previewing || importing}>
                  Choose another
                </Button>
              </>
            ) : (
              <>
                <Upload size={20} aria-hidden="true" />
                <div className="grow">
                  <label htmlFor="bundle-file" className="dropzone-label">
                    Choose a bundle file
                  </label>{' '}
                  or drop it here
                  <div className="muted">
                    A <code translate="no">.codeatrophy.zip</code>
                    {Number.isFinite(maxBytes) ? `, up to ${formatBytes(maxBytes)}` : ''}
                  </div>
                </div>
              </>
            )}
          </div>

          {tooLarge && (
            <Callout tone="danger" role="alert" title="This file is too large">
              It is {formatBytes(file.size)}; this server accepts bundles up to {formatBytes(maxBytes)}. Export a smaller part of the source library, such as one collection at a time.
            </Callout>
          )}
          {error != null && <ErrorCallout error={error} title={preview ? 'The import failed. Nothing was changed.' : 'This file could not be read as a bundle'} onRetry={preview ? () => void run() : undefined} />}

          {preview && counts && (
            <>
              <section className="card card-pad import-summary" aria-label="Bundle">
                <div className="row-wrap">
                  <h2 className="section-title">{preview.bundle.name || 'Unnamed bundle'}</h2>
                  <span className="muted">
                    {preview.bundle.author ? `by ${preview.bundle.author} · ` : ''}
                    exported {absoluteTime(preview.bundle.createdAt)} · format v{preview.bundle.formatVersion}
                  </span>
                </div>
                {preview.bundle.description && <p className="import-desc">{preview.bundle.description}</p>}
                <dl className="import-counts">
                  <div>
                    <dt>New</dt>
                    <dd className="tone-ok">{counts.new}</dd>
                    <span>will be added</span>
                  </div>
                  <div>
                    <dt>Changed</dt>
                    <dd className={counts.changed > 0 ? 'tone-warn' : undefined}>{counts.changed}</dd>
                    <span>you have a different version</span>
                  </div>
                  <div>
                    <dt>Unchanged</dt>
                    <dd>{counts.unchanged}</dd>
                    <span>identical, left alone</span>
                  </div>
                </dl>
              </section>

              {preview.warnings.length > 0 && <Warnings warnings={preview.warnings} />}

              {counts.changed > 0 && (
                <fieldset className="choice-cards">
                  <legend className="field-label">
                    {plural(counts.changed, 'item')} in this bundle {counts.changed === 1 ? 'differs' : 'differ'} from the version you have. What should happen to {counts.changed === 1 ? 'it' : 'them'}?
                  </legend>
                  {STRATEGIES.map((s) => (
                    <label key={s.value} className={cx('choice-card', strategy === s.value && 'is-selected')}>
                      <input type="radio" name="strategy" checked={strategy === s.value} onChange={() => setStrategy(s.value)} />
                      <span>
                        <strong>{s.title}</strong>
                        <span className="choice-text">{s.text}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              <section aria-label="Items in the bundle">
                <div className="row section-head">
                  <h2 className="section-title">Items</h2>
                  <span className="muted">{preview.items.length} in the bundle</span>
                  <span className="spacer" />
                  {counts.unchanged > 0 && (
                    <label className="check">
                      <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
                      <span>Show unchanged</span>
                    </label>
                  )}
                </div>
                <div className="card">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Item</th>
                        <th scope="col" className="num">
                          Tests
                        </th>
                        <th scope="col" className="nowrap">
                          In your library
                        </th>
                        <th scope="col" className="nowrap">
                          On import
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.map((it) => (
                        <tr key={it.id}>
                          <td className="cell-main">
                            <span className="row row-tight">
                              <TypeIcon type={it.type} size={14} />
                              <span className="truncate">{it.title}</span>
                            </span>
                            {it.state === 'changed' && (it.changes ?? []).length > 0 && (
                              <div className="import-changes">Differs in {describeChanges(it.changes, it.type)}</div>
                            )}
                          </td>
                          <td className="num">{it.type === 'problem' ? it.testCaseCount : '—'}</td>
                          <td>
                            <Badge tone={STATE_TONE[it.state]}>{STATE_LABEL[it.state]}</Badge>
                          </td>
                          <td className="muted nowrap">
                            {it.state === 'new'
                              ? 'Added'
                              : it.state === 'unchanged'
                                ? 'Nothing'
                                : strategy === 'skip'
                                  ? 'Yours is kept'
                                  : strategy === 'overwrite'
                                    ? 'Replaced by the bundle’s'
                                    : 'Added as a copy'}
                          </td>
                        </tr>
                      ))}
                      {visibleItems.length === 0 && (
                        <tr>
                          <td colSpan={4} className="muted">
                            Every item in this bundle is identical to what you already have.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {preview.collections.length > 0 && (
                <section aria-label="Collections in the bundle">
                  <div className="row section-head">
                    <h2 className="section-title">Collections</h2>
                    <span className="muted">Existing collections keep their name and place; missing members are appended.</span>
                  </div>
                  <ul className="import-collections">
                    {preview.collections.map((c) => (
                      <li key={c.id}>
                        <span className="truncate">{c.name}</span>
                        <span className="muted">{plural(c.itemCount, 'item')}</span>
                        <Badge tone={c.state === 'new' ? 'ok' : 'neutral'}>{c.state === 'new' ? 'Will be created' : 'Exists'}</Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="form-actions import-actions">
                <Button variant="primary" icon={<CheckCircle2 size={16} />} onClick={() => void run()} busy={importing} disabled={nothingToDo}>
                  {nothingToDo ? 'Nothing to import' : 'Import bundle'}
                </Button>
                <Button variant="ghost" onClick={reset} disabled={importing}>
                  Cancel
                </Button>
                {nothingToDo && (
                  <span className="muted">
                    {counts.changed > 0 ? 'With “Keep mine”, nothing would change.' : 'Your library already has everything in this bundle.'} <Link to="/">Back to the library</Link>
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <Callout tone="warn" title={`${plural(warnings.length, 'warning')} from the bundle`}>
      <ul className="import-warnings">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      Affected items or fields are skipped; the rest of the bundle imports normally.
    </Callout>
  );
}
