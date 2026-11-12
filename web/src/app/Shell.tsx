import { Suspense, useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { Menu as MenuIcon, Plus, Search } from 'lucide-react';
import { useMeta } from '../api/queries';
import { CollectionActionsProvider } from '../features/collections/CollectionActions';
import { useHotkeys } from '../lib/hotkeys';
import { IconButton, LinkButton } from '../ui/Button';
import { ErrorState, PageLoading } from '../ui/misc';
import { CommandPalette } from './CommandPalette';
import { ShortcutsDialog } from './ShortcutsDialog';
import { Sidebar } from './Sidebar';

/** Application frame: sidebar, routed content, and the global keyboard shortcuts. */
export function Shell() {
  const meta = useMeta();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Close the navigation drawer (narrow screens) after navigating.
  useEffect(() => setDrawerOpen(false), [location.pathname, location.search]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  useHotkeys({
    'mod+k': (e) => {
      e.preventDefault();
      setPaletteOpen((v) => !v);
    },
    c: (e) => {
      e.preventDefault();
      navigate('/new');
    },
    '?': () => setShortcutsOpen(true),
  });

  if (meta.isPending) {
    return (
      <div className="boot">
        <PageLoading label="Connecting to Codeathropy…" />
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
    <CollectionActionsProvider>
      <div className="shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="topbar">
          <IconButton label="Open navigation" icon={<MenuIcon size={18} />} onClick={() => setDrawerOpen(true)} />
          <Link to="/" className="topbar-brand">
            Codeathropy
          </Link>
          <span className="spacer" />
          <IconButton label="Search and commands" icon={<Search size={17} />} onClick={openPalette} />
          <LinkButton to="/new" variant="primary" size="sm" icon={<Plus size={14} />}>
            New
          </LinkButton>
        </header>
        <Sidebar meta={meta.data} open={drawerOpen} onClose={() => setDrawerOpen(false)} onOpenPalette={openPalette} onOpenShortcuts={() => setShortcutsOpen(true)} />
        {drawerOpen && <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
        <main id="main" className="main" tabIndex={-1}>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </CollectionActionsProvider>
  );
}
