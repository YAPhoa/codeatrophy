import { createContext, useContext, useLayoutEffect } from 'react';
import { readJson, writeJson } from '../lib/storage';

export interface ShellLayout {
  /** Whether the navigation sidebar is currently minimised to a rail. */
  navMinimised: boolean;
  toggleNav: () => void;
  /**
   * Pages under `/items/:id` say whether they are a problem workspace (where
   * the navigation is a rail unless the user expanded it) or not. `null`
   * withdraws the statement and leaves it to the route.
   */
  declareWorkspace: (workspace: boolean | null) => void;
}

export const ShellLayoutContext = createContext<ShellLayout>({
  navMinimised: false,
  toggleNav: () => {},
  declareWorkspace: () => {},
});

export function useShellLayout(): ShellLayout {
  return useContext(ShellLayoutContext);
}

/** Tell the application frame whether the current page is a problem workspace. */
export function useDeclareWorkspace(workspace: boolean | null): void {
  const { declareWorkspace } = useShellLayout();
  // A layout effect, so the frame settles before the page is painted.
  useLayoutEffect(() => {
    declareWorkspace(workspace);
    return () => declareWorkspace(null);
  }, [declareWorkspace, workspace]);
}

const READINGS_KEY = 'layout:readings';
const READINGS_KEPT = 200;

function rememberedReadings(): string[] {
  const ids = readJson<unknown>(READINGS_KEY, []);
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Remember whether an item is a reading. An item route is taken to be a
 * workspace until its item loads, so a reload of a reading would start with
 * the rail and then open the navigation; remembered, it starts open.
 */
export function rememberItemKind(id: string, reading: boolean): void {
  const ids = rememberedReadings();
  if (ids.includes(id) === reading) return;
  writeJson(READINGS_KEY, reading ? [...ids, id].slice(-READINGS_KEPT) : ids.filter((x) => x !== id));
}

export function isRememberedReading(id: string): boolean {
  return rememberedReadings().includes(id);
}
