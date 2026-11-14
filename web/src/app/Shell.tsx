import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Outlet, matchPath, useLocation, useNavigate } from 'react-router';
import { Menu as MenuIcon, Plus, Search } from 'lucide-react';
import { useMeta } from '../api/queries';
import { CollectionActionsProvider } from '../features/collections/CollectionActions';
import { useHotkeys } from '../lib/hotkeys';
import { useNewItemHref } from '../lib/newItem';
import { readJson, writeJson } from '../lib/storage';
import { useMediaQuery } from '../lib/useMediaQuery';
import { cx } from '../ui/Button';
import { IconButton, LinkButton } from '../ui/Button';
import { ErrorState, PageLoading } from '../ui/misc';
import { CommandPalette } from './CommandPalette';
import { ShellLayoutContext, type ShellLayout } from './shellLayout';
import { ShortcutsDialog } from './ShortcutsDialog';
import { Sidebar } from './Sidebar';

/** Routes that show a problem workspace: the coding page and the pages that share its header. */
const WORKSPACE_ROUTES = ['/items/:id', '/items/:id/tests', '/items/:id/tests/generate', '/items/:id/solutions'];

/** Whether the navigation is minimised, remembered separately for workspaces and for the other pages. */
interface NavPrefs {
  workspace: boolean;
  other: boolean;
}

function readNavPrefs(): NavPrefs {
  const stored = readJson<Partial<NavPrefs> | null>('layout:nav', null);
  // In a workspace the code needs the width, so the navigation starts out as a rail there.
  return { workspace: typeof stored?.workspace === 'boolean' ? stored.workspace : true, other: typeof stored?.other === 'boolean' ? stored.other : false };
}

/** Application frame: sidebar, routed content, and the global keyboard shortcuts. */
export function Shell() {
  const meta = useMeta();
  const navigate = useNavigate();
  const location = useLocation();
  const newHref = useNewItemHref();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [navPrefs, setNavPrefs] = useState(readNavPrefs);
  const [declared, setDeclared] = useState<boolean | null>(null);
  const narrow = useMediaQuery('(max-width: 900px)');

  // Until the page says otherwise, an item route is taken to be a workspace:
  // most items are problems, and guessing avoids a layout jump once it loads.
  const onWorkspaceRoute = WORKSPACE_ROUTES.some((pattern) => matchPath(pattern, location.pathname) !== null);
  const workspace = onWorkspaceRoute && declared !== false;
  const navMinimised = !narrow && (workspace ? navPrefs.workspace : navPrefs.other);

  const toggleNav = useCallback(() => {
    if (narrow) {
      // On a narrow screen the navigation is a drawer; the same control opens and closes it.
      setDrawerOpen((v) => !v);
      return;
    }
    setNavPrefs((prev) => {
      const next = workspace ? { ...prev, workspace: !prev.workspace } : { ...prev, other: !prev.other };
      writeJson('layout:nav', next);
      return next;
    });
  }, [narrow, workspace]);

  const layout = useMemo<ShellLayout>(() => ({ navMinimised, toggleNav, declareWorkspace: setDeclared }), [navMinimised, toggleNav]);

  // Close the navigation drawer (narrow screens) after navigating.
  useEffect(() => setDrawerOpen(false), [location.pathname, location.search]);

  // An open drawer is modal: focus moves into it, Escape closes it, and focus returns to where it was.
  const drawer = narrow && drawerOpen;
  useEffect(() => {
    if (!drawer) return;
    const opener = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>('.sidebar .sidebar-close')?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A menu or dialog opened from the drawer takes its own Escape first.
      if (e.key === 'Escape' && !e.defaultPrevented) setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [drawer]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  useHotkeys({
    'mod+k': (e) => {
      e.preventDefault();
      setPaletteOpen((v) => !v);
    },
    c: (e) => {
      e.preventDefault();
      navigate(newHref);
    },
    'mod+b': (e) => {
      e.preventDefault();
      toggleNav();
    },
    '?': () => setShortcutsOpen(true),
  });

  if (meta.isPending) {
    return (
      <div className="boot">
        <PageLoading label="Connecting to Codeatrophy…" />
      </div>
    );
  }
  if (meta.isError) {
    return (
      <div className="boot">
        <ErrorState error={meta.error} onRetry={() => void meta.refetch()} />
      </div>
    );
  }

  return (
    <ShellLayoutContext.Provider value={layout}>
      <CollectionActionsProvider>
        <div className={cx('shell', navMinimised && 'is-rail')}>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {/* While the drawer is open, the page behind it is out of reach of Tab and of assistive technology. */}
        <header className="topbar" inert={drawer}>
          <IconButton label="Open navigation" icon={<MenuIcon size={18} />} onClick={() => setDrawerOpen(true)} />
          <Link to="/" className="topbar-brand" translate="no">
            Codeatrophy
          </Link>
          <span className="spacer" />
          <IconButton label="Search and commands" icon={<Search size={18} />} onClick={openPalette} />
          <LinkButton to={newHref} variant="primary" size="sm" icon={<Plus size={14} />}>
            New
          </LinkButton>
        </header>
        <Sidebar
          meta={meta.data}
          open={drawerOpen}
          minimised={navMinimised}
          onToggleMinimised={toggleNav}
          onClose={() => setDrawerOpen(false)}
          onOpenPalette={openPalette}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />
        {/* Always there on narrow screens, so it can fade out as the drawer closes. */}
        <div className={cx('drawer-scrim', drawerOpen && 'is-open')} onClick={() => setDrawerOpen(false)} aria-hidden="true" />
        <main id="main" className="main" tabIndex={-1} inert={drawer}>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </CollectionActionsProvider>
    </ShellLayoutContext.Provider>
  );
}
