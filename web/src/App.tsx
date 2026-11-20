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
import { movedIntoSettings, type SettingsSlug } from './features/settings/pages';

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
