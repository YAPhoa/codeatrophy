import { describe, expect, it } from 'vitest';
import { buildChanged, reloadForNewBuild, type BuildEnv } from './newBuild';

const PAGE = '<script type="module" crossorigin src="/assets/index-AAAA.js"></script>';

function env(over: Partial<BuildEnv> = {}): BuildEnv & { reloads: number[] } {
  const reloads: number[] = [];
  return {
    entry: () => '/assets/index-AAAA.js',
    page: () => Promise.resolve(PAGE.replace('AAAA', 'BBBB')),
    lastReload: () => null,
    reload: (at) => reloads.push(at),
    now: () => 50_000,
    reloads,
    ...over,
  };
}

describe('buildChanged', () => {
  it('is true when the server’s page names another entry script', async () => {
    expect(await buildChanged(env())).toBe(true);
  });

  it('is false for the same build, an unreachable server and a page without an entry script', async () => {
    expect(await buildChanged(env({ page: () => Promise.resolve(PAGE) }))).toBe(false);
    expect(await buildChanged(env({ page: () => Promise.resolve(null) }))).toBe(false);
    expect(await buildChanged(env({ entry: () => null }))).toBe(false);
  });
});

describe('reloadForNewBuild', () => {
  it('reloads once for a new build and remembers when', async () => {
    const e = env();
    expect(await reloadForNewBuild(e)).toBe(true);
    expect(e.reloads).toEqual([50_000]);
  });

  it('leaves the page alone when the build is the same or the server is away', async () => {
    const same = env({ page: () => Promise.resolve(PAGE) });
    const away = env({ page: () => Promise.resolve(null) });
    expect(await reloadForNewBuild(same)).toBe(false);
    expect(await reloadForNewBuild(away)).toBe(false);
    expect([...same.reloads, ...away.reloads]).toEqual([]);
  });

  it('does not reload again straight after a reload, and does later', async () => {
    const soon = env({ lastReload: () => 45_000 });
    expect(await reloadForNewBuild(soon)).toBe(false);
    expect(soon.reloads).toEqual([]);
    const later = env({ lastReload: () => 30_000 });
    expect(await reloadForNewBuild(later)).toBe(true);
  });
});
