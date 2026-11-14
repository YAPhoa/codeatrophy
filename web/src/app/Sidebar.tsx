import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Code2,
  Download,
  FolderPlus,
  Inbox,
  Keyboard,
  Library,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings,
  Star,
  Sun,
  Tags,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { invalidateLibrary, useCollections, useStats } from '../api/queries';
import type { Collection, Meta } from '../api/types';
import { useCollectionActions } from '../features/collections/CollectionActions';
import { MOD } from '../lib/hotkeys';
import { useNewItemHref } from '../lib/newItem';
import { readJson, writeJson } from '../lib/storage';
import { setThemePreference, useThemePreference, type ThemePreference } from '../lib/theme';
import { buildTree, siblingsOf, type CollectionNode } from '../lib/tree';
import { IconButton, LinkButton, cx } from '../ui/Button';
import { MenuButton } from '../ui/Popover';
import { Kbd } from '../ui/misc';
import { Collapse, ExpandChevron } from '../ui/Collapse';
import { useToast } from '../ui/Toast';

/** MIME type used when dragging library rows onto a collection. */
export const DRAG_ITEMS = 'application/x-codeatrophy-items';

interface SidebarProps {
  meta: Meta;
  open: boolean;
  /** Show the narrow rail of icons instead of the full navigation. */
  minimised: boolean;
  onToggleMinimised: () => void;
  onClose: () => void;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
}

interface NavEntryProps {
  to: string;
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
}

function NavEntry({ to, icon, label, count, active }: NavEntryProps) {
  return (
    <Link to={to} className={cx('nav-item', active && 'is-active')} aria-current={active ? 'page' : undefined}>
      <span className="nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="grow truncate">{label}</span>
      {count != null && <span className="nav-count">{count}</span>}
    </Link>
  );
}

/** One destination in the minimised navigation: an icon whose name is its tooltip and accessible name. */
function RailEntry({ to, icon, label, active }: Omit<NavEntryProps, 'count'>) {
  return (
    <Link to={to} className={cx('rail-item', active && 'is-active')} aria-current={active ? 'page' : undefined} aria-label={label} title={label}>
      {icon}
    </Link>
  );
}

function CollectionTreeNode({
  node,
  all,
  collapsed,
  toggle,
  activeId,
}: {
  node: CollectionNode;
  all: Collection[];
  collapsed: ReadonlySet<string>;
  toggle: (id: string) => void;
  activeId: string | undefined;
}) {
  const actions = useCollectionActions();
  const qc = useQueryClient();
  const toast = useToast();
  const [dropping, setDropping] = useState(false);
  const c = node.collection;
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(c.id);
  const siblings = siblingsOf(all, c.id);
  const index = siblings.findIndex((s) => s.id === c.id);

  const onDrop = (e: DragEvent) => {
    setDropping(false);
    const raw = e.dataTransfer.getData(DRAG_ITEMS);
    if (!raw) return;
    e.preventDefault();
    const ids = JSON.parse(raw) as string[];
    api.collections
      .addItems(c.id, ids)
      .then(() => {
        toast.success(`Added ${ids.length === 1 ? '1 item' : `${ids.length} items`} to “${c.name}”`);
        return invalidateLibrary(qc);
      })
      .catch((err) => toast.error(err));
  };

  return (
    <li>
      <div
        className={cx('nav-item nav-tree-item', activeId === c.id && 'is-active', dropping && 'is-drop')}
        style={{ paddingLeft: 6 + node.depth * 14 }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_ITEMS)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDropping(true);
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        {hasChildren ? (
          <button
            type="button"
            className="nav-twisty"
            aria-expanded={!isCollapsed}
            aria-label={`Collections inside ${c.name}`}
            onClick={() => toggle(c.id)}
          >
            <ExpandChevron open={!isCollapsed} />
          </button>
        ) : (
          <span className="nav-twisty" aria-hidden="true" />
        )}
        <NavLink to={`/collections/${c.id}`} className="nav-tree-link truncate" title={c.description || c.name}>
          {c.name}
        </NavLink>
        <span className="nav-count">{c.itemCount}</span>
        <MenuButton
          variant="ghost"
          size="sm"
          className="nav-more"
          label={`Actions for ${c.name}`}
          align="end"
          icon={<MoreHorizontal size={14} />}
          items={[
            { label: 'New collection inside…', icon: <FolderPlus size={14} />, onSelect: () => actions.create(c.id) },
            { label: 'Rename or move…', icon: <Pencil size={14} />, onSelect: () => actions.edit(c) },
            'separator',
            { label: 'Move up', icon: <ArrowUp size={14} />, disabled: index <= 0, onSelect: () => actions.shift(c, -1) },
            {
              label: 'Move down',
              icon: <ArrowDown size={14} />,
              disabled: index === -1 || index >= siblings.length - 1,
              onSelect: () => actions.shift(c, 1),
            },
            'separator',
            { label: 'Export…', icon: <Download size={14} />, to: `/export?collection=${c.id}` },
            { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => actions.remove(c) },
          ]}
        />
      </div>
      {hasChildren && (
        <Collapse open={!isCollapsed}>
          <ul>
            {node.children.map((child) => (
              <CollectionTreeNode key={child.collection.id} node={child} all={all} collapsed={collapsed} toggle={toggle} activeId={activeId} />
            ))}
          </ul>
        </Collapse>
      )}
    </li>
  );
}

const THEME_ICON: Record<ThemePreference, ReactNode> = {
  system: <Monitor size={16} />,
  light: <Sun size={16} />,
  dark: <Moon size={16} />,
};

export function Sidebar({ meta, open, minimised, onToggleMinimised, onClose, onOpenPalette, onOpenShortcuts }: SidebarProps) {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const newHref = useNewItemHref();
  const { collectionId } = useParams();
  const stats = useStats();
  const collections = useCollections();
  const actions = useCollectionActions();
  const theme = useThemePreference();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readJson<string[]>('sidebar:collapsed', [])));

  const tree = useMemo(() => buildTree(collections.data ?? []), [collections.data]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeJson('sidebar:collapsed', [...next]);
      return next;
    });

  const onLibrary = location.pathname === '/';
  const type = searchParams.get('type');
  const fav = searchParams.get('favorite') === 'true';
  const uncollected = searchParams.get('uncollected') === 'true';
  const s = stats.data;

  const judgeState = !meta.judge.enabled ? 'off' : meta.judge.healthy ? 'ok' : 'down';

  const themeMenu = (
    <MenuButton
      variant="ghost"
      size="sm"
      label={`Theme: ${theme}`}
      align="end"
      icon={THEME_ICON[theme]}
      items={(['system', 'light', 'dark'] as const).map((t) => ({
        label: t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark',
        icon: THEME_ICON[t],
        selected: t === theme,
        onSelect: () => setThemePreference(t),
      }))}
    />
  );
  const onSettings = location.pathname === '/settings' || location.pathname.startsWith('/settings/');
  const aiTitle = meta.ai.enabled ? `AI drafting: ${[meta.ai.providerName, meta.ai.model].filter(Boolean).join(' · ') || 'on'}` : 'AI drafting is not set up';
  const judgeTitle = judgeState === 'ok' ? `Judge: ${meta.judge.engine}` : judgeState === 'down' ? 'The judge engine is not responding' : 'No judge engine is configured';

  if (minimised) {
    // The rail keeps the destinations one click away; collections need the room of the full navigation.
    return (
      <aside className="sidebar is-rail" aria-label="Navigation">
        <Link to="/" className="rail-brand" aria-label="Codeatrophy: all items" title="Codeatrophy">
          <span className="brand-mark" aria-hidden="true">
            <Code2 size={16} strokeWidth={2.6} />
          </span>
        </Link>
        <IconButton label={`Expand navigation (${MOD}+B)`} size="sm" icon={<PanelLeftOpen size={16} />} onClick={onToggleMinimised} />
        <Link to={newHref} className="rail-item rail-new" aria-label="New item" title="New item (C)">
          <Plus size={16} />
        </Link>
        <button type="button" className="rail-item" onClick={onOpenPalette} aria-label="Search and commands" title={`Search and commands (${MOD}+K)`}>
          <Search size={16} />
        </button>
        <nav className="rail-nav" aria-label="Sections">
          <RailEntry to="/" icon={<Library size={16} />} label="All items" active={onLibrary && !type && !fav && !uncollected} />
          <RailEntry to="/?type=problem" icon={<Code2 size={16} />} label="Problems" active={onLibrary && type === 'problem' && !fav && !uncollected} />
          <RailEntry to="/?type=reading" icon={<BookOpen size={16} />} label="Readings" active={onLibrary && type === 'reading' && !fav && !uncollected} />
          <RailEntry to="/?favorite=true" icon={<Star size={16} />} label="Favorites" active={onLibrary && fav} />
          <span className="rail-sep" aria-hidden="true" />
          <RailEntry to="/tags" icon={<Tags size={16} />} label="Tags" active={location.pathname === '/tags'} />
          <RailEntry to="/import" icon={<Upload size={16} />} label="Import" active={location.pathname === '/import'} />
          <RailEntry to="/export" icon={<Download size={16} />} label="Export" active={location.pathname === '/export'} />
          <RailEntry to="/settings" icon={<Settings size={16} />} label="Settings" active={onSettings} />
        </nav>
        <div className="rail-foot">
          <Link to="/settings/ai" className="rail-svc" title={aiTitle} aria-label={aiTitle}>
            <span className={cx('svc-dot', meta.ai.enabled ? 'is-ok' : 'is-off')} aria-hidden="true" />
            <span aria-hidden="true">AI</span>
          </Link>
          <Link to="/settings/judge" className="rail-svc" title={judgeTitle} aria-label={judgeTitle}>
            <span className={cx('svc-dot', `is-${judgeState}`)} aria-hidden="true" />
            <span aria-hidden="true">Judge</span>
          </Link>
          <IconButton label="Keyboard shortcuts" size="sm" icon={<Keyboard size={16} />} onClick={onOpenShortcuts} />
          {themeMenu}
        </div>
      </aside>
    );
  }

  return (
    <aside className={cx('sidebar', open && 'is-open')} aria-label="Navigation">
      <div className="sidebar-head">
        <Link to="/" className="brand" translate="no">
          <span className="brand-mark" aria-hidden="true">
            <Code2 size={16} strokeWidth={2.6} />
          </span>
          Codeatrophy
        </Link>
        <IconButton className="sidebar-minimise" label={`Minimise navigation (${MOD}+B)`} size="sm" icon={<PanelLeftClose size={16} />} onClick={onToggleMinimised} />
        <IconButton className="sidebar-close" label="Close navigation" size="sm" icon={<X size={16} />} onClick={onClose} />
      </div>

      <div className="sidebar-actions">
        <LinkButton to={newHref} variant="primary" icon={<Plus size={16} />} className="sidebar-new">
          New item
          <Kbd>C</Kbd>
        </LinkButton>
        <button type="button" className="sidebar-search" onClick={onOpenPalette}>
          <Search size={14} aria-hidden="true" />
          <span className="grow">Search…</span>
          <Kbd>{MOD}</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>

      <nav className="sidebar-scroll">
        <ul className="nav-group">
          <li>
            <NavEntry to="/" icon={<Library size={16} />} label="All items" count={s?.items.total} active={onLibrary && !type && !fav && !uncollected} />
          </li>
          <li>
            <NavEntry to="/?type=problem" icon={<Code2 size={16} />} label="Problems" count={s?.items.byType.problem} active={onLibrary && type === 'problem' && !fav && !uncollected} />
          </li>
          <li>
            <NavEntry to="/?type=reading" icon={<BookOpen size={16} />} label="Readings" count={s?.items.byType.reading} active={onLibrary && type === 'reading' && !fav && !uncollected} />
          </li>
          <li>
            <NavEntry to="/?favorite=true" icon={<Star size={16} />} label="Favorites" active={onLibrary && fav} />
          </li>
          <li>
            <NavEntry to="/?uncollected=true" icon={<Inbox size={16} />} label="Uncollected" active={onLibrary && uncollected} />
          </li>
        </ul>

        <div className="nav-heading">
          <h2 id="nav-collections">Collections</h2>
          <IconButton label="New collection" size="sm" icon={<Plus size={14} />} onClick={() => actions.create(null)} />
        </div>
        {tree.length === 0 ? (
          <p className="nav-empty">
            Group items into ordered lists, such as a study plan or a topic.{' '}
            <button type="button" className="link-btn" onClick={() => actions.create(null)}>
              Create one
            </button>
          </p>
        ) : (
          <ul aria-labelledby="nav-collections" className="nav-tree">
            {tree.map((node) => (
              <CollectionTreeNode key={node.collection.id} node={node} all={collections.data ?? []} collapsed={collapsed} toggle={toggle} activeId={collectionId} />
            ))}
          </ul>
        )}

        <div className="nav-heading">
          <h2 id="nav-manage">Manage</h2>
        </div>
        <ul className="nav-group" aria-labelledby="nav-manage">
          <li>
            <NavEntry to="/tags" icon={<Tags size={16} />} label="Tags" count={s?.tags} active={location.pathname === '/tags'} />
          </li>
          <li>
            <NavEntry to="/import" icon={<Upload size={16} />} label="Import" active={location.pathname === '/import'} />
          </li>
          <li>
            <NavEntry to="/export" icon={<Download size={16} />} label="Export" active={location.pathname === '/export'} />
          </li>
          <li>
            <NavEntry to="/settings" icon={<Settings size={16} />} label="Settings" active={onSettings} />
          </li>
        </ul>
      </nav>

      <div className="sidebar-foot">
        <Link to="/settings/ai" className="svc" title={aiTitle}>
          <span className={cx('svc-dot', meta.ai.enabled ? 'is-ok' : 'is-off')} aria-hidden="true" />
          AI<span className="sr-only">: {meta.ai.enabled ? 'on' : 'off'}</span>
        </Link>
        <Link to="/settings/judge" className="svc" title={judgeTitle}>
          <span className={cx('svc-dot', `is-${judgeState}`)} aria-hidden="true" />
          Judge<span className="sr-only">: {judgeState === 'ok' ? 'healthy' : judgeState === 'down' ? 'not responding' : 'off'}</span>
        </Link>
        <span className="spacer" />
        <IconButton label="Keyboard shortcuts" size="sm" icon={<Keyboard size={16} />} onClick={onOpenShortcuts} />
        {themeMenu}
      </div>
    </aside>
  );
}
