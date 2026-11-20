import { lazyScreen } from '../lib/newBuild';

// Everything but the library is loaded on demand: the editor and Markdown
// stacks are large and not needed to show the first screen. Kept apart from
// the routes so that links can preload the screen they lead to.
export const CapturePage = lazyScreen(() => import('../features/capture/CapturePage'));
export const VariantPage = lazyScreen(() => import('../features/capture/VariantPage'));
export const DraftsPage = lazyScreen(() => import('../features/drafts/DraftsPage'));
export const DraftPage = lazyScreen(() => import('../features/drafts/DraftPage'));
export const SavedPage = lazyScreen(() => import('../features/capture/SavedPage'));
export const ItemPage = lazyScreen(() => import('../features/item/ItemPage'));
export const EditItemPage = lazyScreen(() => import('../features/item/EditItemPage'));
export const TestsPage = lazyScreen(() => import('../features/tests/TestsPage'));
export const GenerateTestsPage = lazyScreen(() => import('../features/tests/GenerateTestsPage'));
export const SolutionsPage = lazyScreen(() => import('../features/solutions/SolutionsPage'));
export const TagsPage = lazyScreen(() => import('../features/tags/TagsPage'));
export const SettingsPage = lazyScreen(() => import('../features/settings/SettingsPage'));
