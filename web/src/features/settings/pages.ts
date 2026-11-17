/*
 * The pages of Settings, in the order of the navigation: what people come
 * for most first, then the status of the services the server runs with,
 * then moving the library in and out as bundles.
 * Each has its own address, `/settings/<slug>`.
 */

export const SETTINGS_PAGES = [
  { slug: 'ai', label: 'AI providers' },
  { slug: 'ai-activity', label: 'AI activity' },
  { slug: 'styles', label: 'Writing styles' },
  { slug: 'preferences', label: 'Preferences' },
  { slug: 'judge', label: 'Judge' },
  { slug: 'mcp', label: 'MCP server' },
  { slug: 'import', label: 'Import' },
  { slug: 'export', label: 'Export' },
] as const;

export type SettingsSlug = (typeof SETTINGS_PAGES)[number]['slug'];

export const settingsPath = (slug: SettingsSlug): string => `/settings/${slug}`;

/** The page for a slug from the address, or `undefined` when there is none. */
export function findSettingsPage(slug: string | undefined) {
  return SETTINGS_PAGES.find((p) => p.slug === slug);
}

/** Earlier pages and sections that now live on another page. */
const MOVED: Readonly<Record<string, SettingsSlug>> = { appearance: 'preferences' };

/** The page a retired slug moved to, or `undefined` when the slug was never one. */
export function movedSettingsPage(slug: string | undefined): SettingsSlug | undefined {
  return slug === undefined ? undefined : MOVED[slug];
}

/**
 * Where `/settings` itself leads. Settings used to be one long page whose
 * sections were linked as `/settings#ai`; such an address goes to the page
 * that section became, anything else to the first page.
 */
export function settingsLanding(hash: string): string {
  const section = hash.replace(/^#/, '');
  const slug = findSettingsPage(section)?.slug ?? movedSettingsPage(section) ?? SETTINGS_PAGES[0].slug;
  return settingsPath(slug);
}

/**
 * The new address of a page that moved into Settings (`/import`, `/export`),
 * keeping the query string and fragment of the old one, which say what to export.
 */
export function movedIntoSettings(slug: SettingsSlug, location: { search: string; hash: string }): string {
  return `${settingsPath(slug)}${location.search}${location.hash}`;
}
