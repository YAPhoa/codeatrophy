import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { BookOpen, CheckCircle2, Circle, CircleDot, Code2, FolderPlus, Folders, Star } from 'lucide-react';
import type { ChangeSource, Collection, Difficulty, ItemStatus, ItemType, Verdict } from '../../api/types';
import { ITEM_STATUSES } from '../../api/types';
import { useQuickUpdate } from '../../api/queries';
import { DIFFICULTY_LABEL, STATUS_LABEL, VERDICT_BRIEF, VERDICT_LABEL, verdictTone } from '../../lib/format';
import { changeSourceLine } from '../../lib/changeSource';
import { buildTree, flattenTree } from '../../lib/tree';
import { titleIfCut } from '../../lib/titleIfCut';
import { Button, cx, type ButtonSize } from '../../ui/Button';
import { MenuButton, Popover } from '../../ui/Popover';
import { IconSwap } from '../../ui/Animated';
import { Badge, CopyButton } from '../../ui/misc';
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

/** Neutral, with a coloured dot beside the word: the status colours stay for verdicts and progress. */
export function DifficultyBadge({ difficulty }: { difficulty: Difficulty | null }) {
  if (!difficulty) return null;
  return (
    <Badge className="badge-difficulty">
      <span className={`difficulty-dot is-${difficulty}`} aria-hidden="true" />
      {DIFFICULTY_LABEL[difficulty]}
    </Badge>
  );
}

/** Who created the item and who last changed it, in one muted line; nothing when there is nothing to say. */
export function ChangeSourceLine({ createdBy, lastUpdatedBy, className }: { createdBy?: ChangeSource | null; lastUpdatedBy?: ChangeSource | null; className?: string }) {
  const parts = changeSourceLine(createdBy, lastUpdatedBy);
  if (parts.length === 0) return null;
  return (
    <span className={cx('change-source', className)}>
      {parts.map((p, i) =>
        p.value ? (
          <span key={i} className="change-source-value truncate" title={p.text}>
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </span>
  );
}

/** The item's id as it is, for MCP tools and the API, with a button that copies it. */
export function ItemIdLine({ id, className }: { id: string; className?: string }) {
  return (
    <div className={cx('item-id-line', className)}>
      <span className="fact-label">Item ID:</span>
      <code translate="no" className="item-id">
        <span className="item-id-hash" aria-hidden="true">
          #
        </span>
        {id}
      </code>
      <CopyButton text={id} label="Copy ID" />
    </div>
  );
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

/** Status as a menu button; changes are saved immediately. `title` replaces its tooltip. */
export function StatusControl({ item, compact, size = 'md', title }: { item: ItemRef; compact?: boolean; size?: ButtonSize; title?: string }) {
  const update = useQuickUpdate();
  const toast = useToast();
  return (
    <MenuButton
      variant={compact ? 'ghost' : 'default'}
      size={size}
      label={compact ? `Status of ${item.title}: ${STATUS_LABEL[item.status]}. Change` : undefined}
      title={title ?? `Status: ${STATUS_LABEL[item.status]}`}
      menuLabel="Set status"
      icon={
        <IconSwap swapKey={item.status}>
          <StatusIcon status={item.status} />
        </IconSwap>
      }
      items={ITEM_STATUSES.map((s) => ({
        label: STATUS_LABEL[s],
        icon: <StatusIcon status={s} size={14} />,
        selected: s === item.status,
        onSelect: () => {
          if (s !== item.status) update.mutate({ id: item.id, change: { status: s } }, { onError: (e) => toast.error(e) });
        },
      }))}
    >
      {compact ? undefined : STATUS_LABEL[item.status]}
    </MenuButton>
  );
}

/** The favorite toggle: a star alone in a row of the library, a labelled button in an item's bar (`labelled`). */
export function FavoriteButton({ item, size = 'md', labelled = false }: { item: ItemRef; size?: ButtonSize; labelled?: boolean }) {
  const update = useQuickUpdate();
  const toast = useToast();
  return (
    <Button
      variant={labelled ? 'default' : 'ghost'}
      size={size}
      className={cx('fav-btn', labelled && 'is-labelled', item.favorite && 'is-fav')}
      aria-pressed={item.favorite}
      // Labelled, the button is named by its text.
      aria-label={labelled ? undefined : item.favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
      title={labelled ? undefined : item.favorite ? 'Remove from favorites' : 'Add to favorites'}
      icon={
        // A small pop on becoming a favorite; a plain fade on leaving.
        <IconSwap swapKey={item.favorite} plain className={cx('fav-icon', item.favorite && 'is-on')}>
          <Star size={16} fill={item.favorite ? 'currentColor' : 'none'} className={cx(item.favorite && 'fav-star-on')} />
        </IconSwap>
      }
      onClick={(e) => {
        e.stopPropagation();
        update.mutate({ id: item.id, change: { favorite: !item.favorite } }, { onError: (err) => toast.error(err) });
      }}
    >
      {labelled ? (item.favorite ? 'Favorite' : 'Add to favorites') : undefined}
    </Button>
  );
}

interface TagChipsProps {
  tags: readonly string[];
  max?: number;
  tabIndex?: number;
  /** Makes the "+N" chip a button that shows the rest elsewhere: whether that is open, and its id. */
  more?: { expanded: boolean; controls: string; onToggle: () => void };
}

export function TagChips({ tags, max, tabIndex, more }: TagChipsProps) {
  const shown = max != null ? tags.slice(0, max) : tags;
  const rest = tags.length - shown.length;
  const hidden = tags.slice(shown.length).join(', ');
  return (
    <span className="tagchips">
      {shown.map((t) => (
        <Link
          key={t}
          to={`/?tag=${encodeURIComponent(t)}`}
          className="chip chip-tag"
          title={`Show items tagged ${t}`}
          tabIndex={tabIndex}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="truncate">{t}</span>
        </Link>
      ))}
      {rest > 0 &&
        (more ? (
          <button
            type="button"
            className="chip chip-more"
            title={hidden}
            aria-label={`${rest} more ${rest === 1 ? 'tag' : 'tags'}`}
            aria-expanded={more.expanded}
            aria-controls={more.controls}
            tabIndex={tabIndex}
            onClick={(e) => {
              e.stopPropagation();
              more.onToggle();
            }}
          >
            +{rest}
          </button>
        ) : (
          <span className="chip" title={hidden}>
            +{rest}
          </span>
        ))}
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
      >
        <span className="truncate" style={{ maxWidth: 180 }} onMouseEnter={titleIfCut}>
          {text}
        </span>
      </Button>
      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} role="dialog" label="Collections" className="popover-panel">
        {nodes.length > 6 && (
          <input
            name="collection-filter"
            autoComplete="off"
            className="input input-sm picklist-filter"
            placeholder="Filter collections…"
            aria-label="Filter collections"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-autofocus
          />
        )}
        {nodes.length === 0 ? (
          <p className="muted picklist-empty">
            No collections yet. Collections are ordered lists, such as a study plan or a topic.
          </p>
        ) : (
          <div className="picklist">
            {visible.map((n) => (
              <label key={n.collection.id} className="picklist-item" style={{ paddingLeft: 4 + (q ? 0 : n.depth * 16) }}>
                <input
                  type="checkbox"
                  checked={selected.includes(n.collection.id)}
                  onChange={(e) => onToggle(n.collection.id, e.target.checked)}
                />
                <span className="truncate" onMouseEnter={titleIfCut}>
                  {n.collection.name}
                </span>
                <span className="picklist-count">{n.collection.itemCount}</span>
              </label>
            ))}
            {visible.length === 0 && <p className="muted picklist-empty">No match.</p>}
          </div>
        )}
        {onCreate && (
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderPlus size={14} />}
            className="picklist-note"
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
