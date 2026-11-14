import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Download, PackageCheck } from 'lucide-react';
import { api } from '../../api/client';
import { useCollections, useItemQuery, useLimits, useStats } from '../../api/queries';
import type { ExportScope } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { saveBlob } from '../../lib/download';
import { formatBytes, plural } from '../../lib/format';
import { buildTree, descendantIds, flattenTree } from '../../lib/tree';
import { useUrlMirror, useUrlState } from '../../lib/urlState';
import { Button, cx } from '../../ui/Button';
import { Checkbox, SelectField, TextAreaField, TextField } from '../../ui/Field';
import { Callout, ErrorCallout } from '../../ui/misc';
import { ShareTabs } from './ShareTabs';

const SHOWN_TITLES = 8;

// An option that is on unless the address says `0`.
const parseOn = (raw: string | null): boolean => raw !== '0';
const formatOn = (value: boolean): string | null => (value ? null : '0');

/** Export the whole library, one collection subtree, or a selection of items as a bundle. */
export default function ExportPage() {
  useDocumentTitle('Export');
  const [searchParams] = useSearchParams();
  const { data: collections = [] } = useCollections();
  const stats = useStats();
  const limits = useLimits();

  // What is being exported is in the address, so a reload or a shared link
  // keeps it: `?item=…` (repeated) for a selection, `?collection=…`, and
  // `scope`, `solutions` and `hidden` where they differ from the default.
  const itemParams = searchParams.getAll('item').join('\n');
  const passedIds = useMemo(() => (itemParams ? itemParams.split('\n') : []), [itemParams]);
  const presetCollection = searchParams.get('collection');

  // Without `scope`, the address says what is meant by what it carries.
  const [implied] = useState<ExportScope>(() => (passedIds.length > 0 ? 'items' : presetCollection ? 'collection' : 'all'));
  const [scope, setScope] = useUrlState<ExportScope>(
    'scope',
    (raw) => (raw === 'all' || raw === 'collection' || raw === 'items' ? raw : implied),
    (value) => (value === implied ? null : value),
  );
  const [collectionId, setCollectionId] = useState(presetCollection ?? '');
  useUrlMirror('collection', scope === 'collection' && collectionId ? collectionId : null, (raw) => setCollectionId(raw ?? ''));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [includeSolutions, setIncludeSolutions] = useUrlState('solutions', parseOn, formatOn);
  const [includeHiddenTests, setIncludeHiddenTests] = useUrlState('hidden', parseOn, formatOn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ filename: string; size: number } | null>(null);

  const tree = useMemo(() => buildTree(collections), [collections]);
  const options = useMemo(() => flattenTree(tree).map((n) => ({ value: n.collection.id, label: `${' '.repeat(n.depth)}${n.collection.name}` })), [tree]);
  const effectiveCollection = collectionId || options[0]?.value || '';
  const chosen = collections.find((c) => c.id === effectiveCollection);
  const nested = chosen ? descendantIds(tree, chosen.id).length : 0;
  const subtreeItems = useItemQuery({ collectionId: effectiveCollection, recursive: true, limit: 1 }, scope === 'collection' && !!effectiveCollection);
  // Only the first few titles are shown, so only those are fetched.
  const shownIds = useMemo(() => passedIds.slice(0, SHOWN_TITLES), [passedIds]);
  const selectedItems = useItemQuery({ id: shownIds, sort: 'title', limit: SHOWN_TITLES }, scope === 'items' && shownIds.length > 0);
  const selectedTitles = selectedItems.data?.items ?? [];

  const defaultName = scope === 'collection' ? (chosen?.name ?? '') : 'Codeatrophy library';
  const valid = scope === 'all' || (scope === 'collection' && !!effectiveCollection) || (scope === 'items' && passedIds.length > 0);

  const run = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.bundle.export({
        scope,
        collectionId: scope === 'collection' ? effectiveCollection : null,
        itemIds: scope === 'items' ? passedIds : [],
        ...(name.trim() ? { name: name.trim() } : {}),
        description: description.trim(),
        author: author.trim(),
        includeSolutions,
        includeHiddenTests,
      });
      const filename = res.filename ?? 'library.codeatrophy.zip';
      saveBlob(res.blob, filename);
      setDone({ filename, size: res.blob.size });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow share">
      <ShareTabs active="export" />
      <h1 className="page-title">Export a bundle</h1>
      <p className="page-sub">
        A bundle is a zip of plain Markdown, JSON and source files — readable, diffable, and importable into any Codeatrophy instance. It carries content only:{' '}
        <strong>your status, favorites, notes and submissions are never included</strong>.
      </p>

      <form
        className="stack share-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <fieldset className="choice-cards">
          <legend className="field-label">What to export</legend>
          <label className={cx('choice-card', scope === 'all' && 'is-selected')}>
            <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
            <span>
              <strong>The whole library</strong>
              <span className="choice-text">
                {stats.data ? `${plural(stats.data.items.total, 'item')} and ${plural(stats.data.collections, 'collection')}` : 'Every item and collection'}
              </span>
            </span>
          </label>
          <label className={cx('choice-card', scope === 'collection' && 'is-selected', options.length === 0 && 'is-disabled')}>
            <input type="radio" name="scope" checked={scope === 'collection'} disabled={options.length === 0} onChange={() => setScope('collection')} />
            <span>
              <strong>A collection</strong>
              <span className="choice-text">{options.length === 0 ? 'There are no collections yet' : 'The collection, everything nested in it, and their items'}</span>
            </span>
          </label>
          <label className={cx('choice-card', scope === 'items' && 'is-selected', passedIds.length === 0 && 'is-disabled')}>
            <input type="radio" name="scope" checked={scope === 'items'} disabled={passedIds.length === 0} onChange={() => setScope('items')} />
            <span>
              <strong>Selected items</strong>
              <span className="choice-text">
                {passedIds.length > 0 ? `${plural(passedIds.length, 'item')} you selected — no collections` : 'Select items in the library, then choose “Export” in the selection bar'}
              </span>
            </span>
          </label>
        </fieldset>

        {scope === 'collection' && options.length > 0 && (
          <SelectField
            label="Collection"
            value={effectiveCollection}
            onChange={setCollectionId}
            options={options}
            hint={
              chosen
                ? `${nested > 0 ? `Includes ${plural(nested, 'nested collection')}. ` : ''}${subtreeItems.data ? `${plural(subtreeItems.data.total, 'item')} in total.` : ''}`
                : undefined
            }
          />
        )}

        {scope === 'items' && passedIds.length > 0 && (
          <div className="card card-pad export-items">
            <ul>
              {selectedTitles.map((i) => (
                <li key={i.id} className="truncate">
                  {i.title}
                </li>
              ))}
            </ul>
            {passedIds.length > shownIds.length && <p className="muted">…and {passedIds.length - shownIds.length} more.</p>}
            <Link to="/">Change the selection in the library</Link>
          </div>
        )}

        <fieldset className="stack">
          <legend className="field-label">What to include</legend>
          <Checkbox
            checked={includeSolutions}
            onChange={setIncludeSolutions}
            label="Saved solutions"
            hint="Every solution saved with a problem, the reference solution included. Turn off to share problems without giving the answers away."
          />
          <Checkbox
            checked={includeHiddenTests}
            onChange={setIncludeHiddenTests}
            label="Hidden test cases"
            hint="Turn off to export only the sample cases. Recipients can read and run samples, but cannot judge a full submission."
          />
        </fieldset>

        <div className="form-grid">
          <TextField label="Bundle name" value={name} onChange={setName} placeholder={defaultName ? `${defaultName}…` : undefined} hint="Also used for the file name." maxLength={limits?.maxBundleNameChars} autoComplete="off" />
          <TextField label="Author (optional)" value={author} onChange={setAuthor} placeholder="e.g. Ada Lovelace…" maxLength={limits?.maxBundleNameChars} autoComplete="off" />
        </div>
        <TextAreaField
          label="Description (optional)"
          hint="Shown to whoever imports the bundle."
          value={description}
          onChange={setDescription}
          rows={2}
          maxLength={limits?.maxBundleDescriptionChars}
          placeholder="e.g. Graph problems from the spring interview loop…"
        />

        {error != null && <ErrorCallout error={error} title="The export failed" onRetry={() => void run()} />}
        {done && (
          <Callout tone="ok" role="status" title="Bundle downloaded">
            <PackageCheck size={14} aria-hidden="true" /> {done.filename} · {formatBytes(done.size)}
          </Callout>
        )}

        <div className="form-actions">
          <Button type="submit" variant="primary" icon={<Download size={16} />} busy={busy}>
            Download bundle
          </Button>
        </div>
      </form>
    </div>
  );
}
