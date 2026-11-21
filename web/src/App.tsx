import { Navigate, Route, createRoutesFromElements, useLocation } from 'react-router';
import { Shell } from './app/Shell';
import {
  CapturePage,
  DraftPage,
  DraftsPage,
  EditItemPage,
  GenerateTestsPage,
  ItemPage,
  SavedPage,
  SettingsPage,
  SolutionsPage,
  TagsPage,
  TestsPage,
  VariantPage,
} from './app/screens';
import { NotFoundPage, RouteError } from './app/NotFoundPage';
import { LibraryPage } from './features/library/LibraryPage';
import { legacyLibraryPath } from './lib/libraryPaths';
import { movedIntoSettings, type SettingsSlug } from './features/settings/pages';

/**
 * Every view of the library, by its path. An address from before the views
 * had paths (`/?type=problem`, `/?favorite=true`, `/?uncollected=true`)
 * leads to the path, in place of itself so that Back does not return to it.
 * One element for all of them, so moving between views keeps the page.
 */
function Library() {
  const location = useLocation();
  const moved = location.pathname === '/' ? legacyLibraryPath(location.search) : null;
  if (moved) return <Navigate to={moved + location.hash} replace />;
  return <LibraryPage />;
}

/** A page that moved into Settings: its old address leads there, query string included. */
function MovedIntoSettings({ slug }: { slug: SettingsSlug }) {
  const location = useLocation();
  return <Navigate to={movedIntoSettings(slug, location)} replace />;
}

export const routes = createRoutesFromElements(
  <Route element={<Shell />} errorElement={<RouteError />}>
    <Route index element={<Library />} />
    <Route path="problems" element={<Library />} />
    <Route path="readings" element={<Library />} />
    <Route path="favorites" element={<Library />} />
    <Route path="collections/:collectionId" element={<Library />} />
    <Route path="new" element={<CapturePage />} />
    <Route path="drafts" element={<DraftsPage />} />
    <Route path="drafts/:id" element={<DraftPage />} />
    <Route path="items/:id" element={<ItemPage />} />
    <Route path="items/:id/edit" element={<EditItemPage />} />
    <Route path="items/:id/saved" element={<SavedPage />} />
    <Route path="items/:id/tests" element={<TestsPage />} />
    <Route path="items/:id/tests/generate" element={<GenerateTestsPage />} />
    <Route path="items/:id/solutions" element={<SolutionsPage />} />
    <Route path="items/:id/variant" element={<VariantPage />} />
    <Route path="tags" element={<TagsPage />} />
    <Route path="export" element={<MovedIntoSettings slug="export" />} />
    <Route path="import" element={<MovedIntoSettings slug="import" />} />
    <Route path="share" element={<Navigate to="/settings/export" replace />} />
    <Route path="settings" element={<SettingsPage />} />
    <Route path="settings/:section" element={<SettingsPage />} />
    <Route path="*" element={<NotFoundPage />} />
  </Route>,
);
