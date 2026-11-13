// After an upgrade an open tab still runs the previous build, whose lazily
// loaded files are gone from the server: the first screen or editor it asks
// for fails to load. When that is the reason, a screen reloads the page (the
// user was leaving the old one anyway) and a part inside a screen asks for a
// reload instead, so that nothing on the screen is lost.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** What the checks need from the browser, so that they can be tested without one. */
export interface BuildEnv {
  /** The entry script of the running build, as its page names it. */
  entry(): string | null;
  /** The page the server serves now, or null when it cannot be fetched. */
  page(): Promise<string | null>;
  /** When this tab last reloaded itself for a new build (ms), if it has. */
  lastReload(): number | null;
  reload(at: number): void;
  now(): number;
}

/** A second reload this soon after the first would mean reloading does not help. */
const RELOAD_AGAIN_AFTER_MS = 10_000;
const RELOADED_AT = 'codeatrophy.reloadedAt';

const browser: BuildEnv = {
  entry: () => document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null,
  page: async () => {
    try {
      const response = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } });
      return response.ok ? await response.text() : null;
    } catch {
      return null;
    }
  },
  lastReload: () => {
    try {
      const at = Number(sessionStorage.getItem(RELOADED_AT));
      return at > 0 ? at : null;
    } catch {
      return null;
    }
  },
  reload: (at) => {
    try {
      sessionStorage.setItem(RELOADED_AT, String(at));
    } catch {
      // Without storage the reload still happens; the page the server serves is checked each time.
    }
    window.location.reload();
  },
  now: () => Date.now(),
};

/** Whether the server now serves another build: its page no longer names the running build's entry script. */
export async function buildChanged(env: BuildEnv = browser): Promise<boolean> {
  const entry = env.entry();
  if (!entry) return false;
  const page = await env.page();
  return page !== null && !page.includes(entry);
}

/** Reloads the page if the server serves another build; says whether it did. */
export async function reloadForNewBuild(env: BuildEnv = browser): Promise<boolean> {
  if (!(await buildChanged(env))) return false;
  const last = env.lastReload();
  const now = env.now();
  if (last !== null && now - last < RELOAD_AGAIN_AFTER_MS) return false;
  env.reload(now);
  return true;
}

type Load<P> = () => Promise<{ default: ComponentType<P> }>;

/** A screen loaded on demand. If its file is gone because the server was upgraded, the page reloads. */
export function lazyScreen<P>(load: Load<P>): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    load().catch(async (error: unknown) => {
      // The page is on its way out; the screen stays pending until it is.
      if (await reloadForNewBuild()) return new Promise<never>(() => {});
      throw error;
    }),
  );
}

/** A part of a screen loaded on demand. If its file is gone because the server was upgraded, `stale` stands in for it. */
export function lazyPart<P>(load: Load<P>, stale: ComponentType<P>): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    load().catch(async (error: unknown) => {
      if (await buildChanged()) return { default: stale };
      throw error;
    }),
  );
}
