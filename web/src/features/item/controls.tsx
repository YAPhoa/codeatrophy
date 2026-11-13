import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { BookOpen, CheckCircle2, Circle, CircleDot, Code2, FolderPlus, Folders, Star } from 'lucide-react';
import type { Collection, Difficulty, ItemStatus, ItemType, Verdict } from '../../api/types';
import { ITEM_STATUSES } from '../../api/types';
import { useQuickUpdate } from '../../api/queries';
import { DIFFICULTY_LABEL, STATUS_LABEL, VERDICT_BRIEF, VERDICT_LABEL, difficultyTone, verdictTone } from '../../lib/format';
import { buildTree, flattenTree } from '../../lib/tree';
import { Button, cx, type ButtonSize } from '../../ui/Button';
import { MenuButton, Popover } from '../../ui/Popover';
import { Badge } from '../../ui/misc';
import { useToast } from '../../ui/Toast';

export function StatusIcon({ status, size = 15 }: { status: ItemStatus; size?: number }) {
  if (status === 'done') return <CheckCircle2 size={size} className="status-icon status-done" aria-hidden="true" />;
  if (status === 'in_progress') return <CircleDot size={size} className="status-icon status-in_progress" aria-hidden="true" />;
  return <Circle size={size} className="status-icon status-todo" aria-hidden="true" />;
}

export function TypeIcon({ type, size = 15 }: { type: ItemType; size?: number }) {
  return type === 'problem' ? (
    <Code2 size={size} className="type-icon" aria-label="Problem" />
  ) : (
    <BookOpen size={size} className="type-icon" aria-label="Reading" />
  );
}

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty | null }) {
  if (!difficulty) return null;
  return <Badge tone={difficultyTone(difficulty)}>{DIFFICULTY_LABEL[difficulty]}</Badge>;
}

export function VerdictBadge({ verdict, short }: { verdict: Verdict; short?: boolean }) {
  return (
    <Badge tone={verdictTone(verdict)} title={VERDICT_LABEL[verdict]}>
      {short ? VERDICT_BRIEF[verdict] : VERDICT_LABEL[verdict]}
    </Badge>
  );
}

interface ItemRef {
  id: string;
  status: ItemStatus;
  favorite: boolean;
  title: string;
}

/** Status as a menu button; changes are saved immediately. */
export function StatusControl({ item, compact, size = 'md' }: { item: ItemRef; compact?: boolean; size?: ButtonSize }) {
  const update = useQuickUpdate();
  const toast = useToast();
  return (
    <MenuButton
      variant={compact ? 'ghost' : 'default'}
      size={size}
      label={compact ? `Status of ${item.title}: ${STATUS_LABEL[item.status]}. Change` : undefined}
      title={`Status: ${STATUS_LABEL[item.status]}`}
      menuLabel="Set status"
      icon={<StatusIcon status={item.status} />}
      items={ITEM_STATUSES.map((s) => ({
        label: STATUS_LABEL[s],
        icon: <StatusIcon status={s} size={14} />,
        hint: s === item.status ? 'current' : undefined,
        onSelect: () => {
          if (s !== item.status) update.mutate({ id: item.id, change: { status: s } }, { onError: (e) => toast.error(e) });
        },
      }))}
    >
      {compact ? undefined : STATUS_LABEL[item.status]}
    </MenuButton>
  );
}

export function FavoriteButton({ item, size = 'md' }: { item: ItemRef; size?: ButtonSize }) {
  const update = useQuickUpdate();
  const toast = useToast();
  return (
    <Button
      variant="ghost"
      size={size}
      className={cx('fav-btn', item.favorite && 'is-fav')}
      aria-pressed={item.favorite}
      aria-label={item.favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
      title={item.favorite ? 'Favorite — click to remove' : 'Add to favorites'}
      icon={<Star size={15} fill={item.favorite ? 'currentColor' : 'none'} />}
      onClick={(e) => {
        e.stopPropagation();
        update.mutate({ id: item.id, change: { favorite: !item.favorite } }, { onError: (err) => toast.error(err) });
      }}
    />
  );
}

export function TagChips({ tags, max }: { tags: readonly string[]; max?: number }) {
  const shown = max != null ? tags.slice(0, max) : tags;
  const rest = tags.length - shown.length;
  return (
    <span className="tagchips">
      {shown.map((t) => (
        <Link key={t} to={`/?tag=${encodeURIComponent(t)}`} className="chip chip-tag" title={`Show items tagged ${t}`} onClick={(e) => e.stopPropagation()}>
          <span className="truncate">{t}</span>
        </Link>
      ))}
      {rest > 0 && (
        <span className="chip" title={tags.slice(shown.length).join(', ')}>
          +{rest}
        </span>
      )}
    </span>
  );
}

interface CollectionPickerProps {
  collections: readonly Collection[];
  selected: readonly string[];
  onToggle: (collectionId: string, selected: boolean) => void;
  onCreate?: () => void;
  size?: ButtonSize;
  /** Button text; defaults to a count of the selected collections. */
  label?: string;
  disabled?: boolean;
}

/** Popover with the collection tree as a checklist. An item can be in any number of collections. */
export function CollectionPicker({ collections, selected, onToggle, onCreate, size = 'md', label, disabled }: CollectionPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const nodes = useMemo(() => flattenTree(buildTree(collections)), [collections]);
  const q = filter.trim().toLowerCase();
  const visible = q ? nodes.filter((n) => n.collection.name.toLowerCase().includes(q)) : nodes;
  const text =
    label ??
    (selected.length === 0
      ? 'Add to collection'
      : selected.length === 1
        ? (collections.find((c) => c.id === selected[0])?.name ?? '1 collection')
        : `${selected.length} collections`);

  return (
    <>
      <Button
        ref={anchorRef}
        size={size}
        icon={<Folders size={14} />}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="Collections"
      >
        <span className="truncate" style={{ maxWidth: 180 }}>
          {text}
        </span>
      </Button>
      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} role="dialog" label="Collections" className="popover-panel">
        {nodes.length > 6 && (
          <input
            name="collection-filter"
            autoComplete="off"
            className="input input-sm"
            placeholder="Filter collections…"
            aria-label="Filter collections"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-autofocus
            style={{ marginBottom: 6 }}
          />
        )}
        {nodes.length === 0 ? (
          <p className="muted" style={{ padding: '4px 4px 8px' }}>
            No collections yet. Collections are ordered lists — a study plan, a topic.
          </p>
        ) : (
          <div className="picklist">
            {visible.map((n) => (
              <label key={n.collection.id} className="picklist-item" style={{ paddingLeft: 8 + (q ? 0 : n.depth * 16) }}>
                <input
                  type="checkbox"
                  checked={selected.includes(n.collection.id)}
                  onChange={(e) => onToggle(n.collection.id, e.target.checked)}
                />
                <span className="truncate">{n.collection.name}</span>
                <span className="picklist-count">{n.collection.itemCount}</span>
              </label>
            ))}
            {visible.length === 0 && <p className="muted" style={{ padding: 8 }}>No match.</p>}
          </div>
        )}
        {onCreate && (
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderPlus size={14} />}
            style={{ marginTop: 6 }}
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
          >
            New collection…
          </Button>
        )}
      </Popover>
    </>
  );
}
