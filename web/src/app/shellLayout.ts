import { createContext, useContext, useLayoutEffect } from 'react';

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
