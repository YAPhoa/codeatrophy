import { Navigate, Route, createRoutesFromElements, useLocation } from 'react-router';
import { Shell } from './app/Shell';
import { NotFoundPage, RouteError } from './app/NotFoundPage';
import { LibraryPage } from './features/library/LibraryPage';
import { movedIntoSettings, type SettingsSlug } from './features/settings/pages';
import { lazyScreen } from './lib/newBuild';

// Everything but the library is loaded on demand: the editor and Markdown
// stacks are large and not needed to show the first screen.
const CapturePage = lazyScreen(() => import('./features/capture/CapturePage'));
const VariantPage = lazyScreen(() => import('./features/capture/VariantPage'));
const SavedPage = lazyScreen(() => import('./features/capture/SavedPage'));
const ItemPage = lazyScreen(() => import('./features/item/ItemPage'));
const EditItemPage = lazyScreen(() => import('./features/item/EditItemPage'));
const TestsPage = lazyScreen(() => import('./features/tests/TestsPage'));
const GenerateTestsPage = lazyScreen(() => import('./features/tests/GenerateTestsPage'));
const SolutionsPage = lazyScreen(() => import('./features/solutions/SolutionsPage'));
const TagsPage = lazyScreen(() => import('./features/tags/TagsPage'));
const SettingsPage = lazyScreen(() => import('./features/settings/SettingsPage'));

/** A page that moved into Settings: its old address leads there, query string included. */
function MovedIntoSettings({ slug }: { slug: SettingsSlug }) {
  const location = useLocation();
  return <Navigate to={movedIntoSettings(slug, location)} replace />;
}

export const routes = createRoutesFromElements(
  <Route element={<Shell />} errorElement={<RouteError />}>
    <Route index element={<LibraryPage />} />
    <Route path="collections/:collectionId" element={<LibraryPage />} />
    <Route path="new" element={<CapturePage />} />
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
