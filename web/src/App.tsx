import { Navigate, Route, createRoutesFromElements } from 'react-router';
import { Shell } from './app/Shell';
import { NotFoundPage, RouteError } from './app/NotFoundPage';
import { LibraryPage } from './features/library/LibraryPage';
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
const ExportPage = lazyScreen(() => import('./features/share/ExportPage'));
const ImportPage = lazyScreen(() => import('./features/share/ImportPage'));
const SettingsPage = lazyScreen(() => import('./features/settings/SettingsPage'));

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
    <Route path="export" element={<ExportPage />} />
    <Route path="import" element={<ImportPage />} />
    <Route path="share" element={<Navigate to="/export" replace />} />
    <Route path="settings" element={<SettingsPage />} />
    <Route path="settings/:section" element={<SettingsPage />} />
    <Route path="*" element={<NotFoundPage />} />
  </Route>,
);
