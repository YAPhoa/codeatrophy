import type { Locator, Page } from '@playwright/test';

/**
 * Open the app with short mock delays (or the scenario `mock` names), and
 * fail the test on any page error or third-party request.
 */
export async function open(page: Page, path: string, mock = 'fast'): Promise<void> {
  page.on('pageerror', (error) => {
    throw error;
  });
  page.on('request', (request) => {
    const { hostname } = new URL(request.url());
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') throw new Error(`request to a third-party origin: ${request.url()}`);
  });
  const [route = '', hash] = path.split('#');
  await page.goto(`${route}${route.includes('?') ? '&' : '?'}mock=${mock}${hash ? `#${hash}` : ''}`);
}

/** What `recordLoading` saw, in ms since the page started. */
export interface LoadingRecord {
  /** When the app was first shown (`is-booting` gone). */
  revealedAt: number | null;
  /** Each loading indicator that became visible: its text, the element, when it was mounted and when it showed. */
  indicators: { what: string; where: string; mountedAt: number; shownAt: number }[];
  /** Each entrance fade that started (styles/layout.css), and when. */
  entrances: { what: string; at: number }[];
}

/**
 * Record, frame by frame, when the app is shown, when loading indicators
 * (`.loading-delay`) are inserted and when they show, and which entrance
 * fades start. Read it with `loadingRecord`.
 */
export async function recordLoading(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Marked = Element & { __mountedAt?: number; __shown?: boolean };
    const record = { revealedAt: null as number | null, indicators: [] as { what: string; where: string; mountedAt: number; shownAt: number }[], entrances: [] as { what: string; at: number }[] };
    (window as unknown as { __loading: typeof record }).__loading = record;
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : ''}`;
    // Marked as it is inserted, not when an observer hears of it at the end of a
    // long task: the indicator's 400ms are timed from no earlier than this.
    const mark = (node: Node) => {
      if (!(node instanceof Element)) return;
      const now = performance.now();
      for (const el of [node, ...node.querySelectorAll('.loading-delay')] as Marked[]) if (el.matches('.loading-delay')) el.__mountedAt ??= now;
    };
    const { appendChild, insertBefore } = Node.prototype;
    Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
      mark(node);
      return appendChild.call(this, node) as T;
    };
    Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
      mark(node);
      return insertBefore.call(this, node, child) as T;
    };
    document.addEventListener(
      'transitionstart',
      (e) => {
        if (e.propertyName === 'opacity' && e.target instanceof Element && e.target.matches('#root, .shell, .page, .workspace > *, .reader'))
          record.entrances.push({ what: describe(e.target), at: performance.now() });
      },
      true,
    );
    const frame = () => {
      const now = performance.now();
      const booting = document.documentElement.classList.contains('is-booting');
      if (!booting && record.revealedAt === null) record.revealedAt = now;
      if (!booting)
        for (const el of document.querySelectorAll<Marked>('.loading-delay:not(.is-pending)'))
          if (!el.__shown) {
            el.__shown = true;
            record.indicators.push({ what: el.textContent?.trim() || '', where: describe(el), mountedAt: el.__mountedAt ?? 0, shownAt: now });
          }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

export async function loadingRecord(page: Page): Promise<LoadingRecord> {
  return page.evaluate(() => structuredClone((window as unknown as { __loading: LoadingRecord }).__loading));
}

/**
 * Give the mock library `count` more readings before the app first loads it
 * (and again on every reload): "Extra reading 001" and on, older than any
 * seeded item, so they come last in the default order.
 */
export async function withExtraItems(page: Page, count: number): Promise<void> {
  await page.addInitScript((count) => {
    type Item = { id: string; type: string; title: string; tags: string[]; favorite: boolean; createdAt: string; updatedAt: string; seq: number };
    type Mock = { db: { items: Map<string, Item>; nextSeq: () => number } };
    let mock: Mock | undefined;
    Object.defineProperty(window, '__codeatrophyMock', {
      configurable: true,
      get: () => mock,
      set: (m: Mock) => {
        mock = m;
        const base = [...m.db.items.values()].find((i) => i.type === 'reading')!;
        for (let n = 1; n <= count; n++) {
          const id = `99999999-9999-4999-8999-${String(n).padStart(12, '0')}`;
          const at = new Date(Date.now() - (400 + n) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
          m.db.items.set(id, { ...base, id, title: `Extra reading ${String(n).padStart(3, '0')}`, tags: ['extra'], favorite: false, createdAt: at, updatedAt: at, seq: m.db.nextSeq() });
        }
      },
    });
  }, count);
}

/**
 * Open the list of one of the app's selects (ui/Select.tsx), a button with
 * the role combobox, and return it. Escape puts it away again.
 */
export async function openList(select: Locator): Promise<Locator> {
  await select.click();
  const id = await select.getAttribute('aria-controls');
  const list = select.page().locator(`[id="${id}"]`);
  await list.waitFor();
  return list;
}

/** Choose an option in one of the app's selects as a pointer does: open its list and click the option with that name. */
export async function choose(select: Locator, option: string | RegExp): Promise<void> {
  const list = await openList(select);
  await list.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
}

/** Rough text the mock drafts as Two Sum. */
export const TWO_SUM_TEXT = 'two sum — array of ints and a target, return the two indices that add up to it. O(n)?';

/** The library row of the item titled `title`. */
export const row = (page: Page, title: string): Locator => page.locator('li.item-row').filter({ has: page.getByRole('link', { name: title, exact: true }) });

/** Replace the code in the solving editor. */
export async function writeCode(page: Page, source: string): Promise<void> {
  await page.getByRole('textbox', { name: /solution code/i }).click();
  await page.keyboard.press('ControlOrMeta+A');
  // Inserted as one piece of text, so that bracket closing and completion do not reshape it.
  await page.keyboard.insertText(source);
}

/** Call the mock's API from the page, as a script would, and read the JSON answer (`null` for none). */
export async function mockApi<T = unknown>(page: Page, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  // The mock is installed as the app starts.
  await page.waitForFunction(() => '__codeatrophyMock' in window);
  return page.evaluate(
    async ({ path, init }) => {
      const mock = (window as unknown as { __codeatrophyMock: { fetch: (p: string, i?: RequestInit) => Promise<Response> } }).__codeatrophyMock;
      const res = await mock.fetch(`/api/v1${path}`, init ? { method: init.method, body: init.body === undefined ? undefined : JSON.stringify(init.body) } : undefined);
      if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
      return res.status === 204 ? null : res.json();
    },
    { path, init },
  ) as Promise<T>;
}

/** The seeded item titled `title`, as the mock's API lists it. */
export async function mockItem(page: Page, title: string): Promise<{ id: string; title: string; tags: string[]; revision: number }> {
  const { items } = await mockApi<{ items: { id: string; title: string; tags: string[]; revision: number }[] }>(page, `/items?limit=200&q=${encodeURIComponent(title)}`);
  const item = items.find((i) => i.title === title);
  if (!item) throw new Error(`no item titled ${title}`);
  return item;
}
