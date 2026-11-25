import { createContext, useContext } from 'react';
import { ReportTargetType } from '../types';

/** App-wide actions used deep in the tree (rich text, messages, posts). */
export interface AppActions {
  openProfileByUsername: (username: string) => void;
  openHashtag: (tag: string) => void;
  report: (targetType: ReportTargetType, targetId: string) => void;
  /** Accounts the signed-in user has blocked. */
  blockedIds: Set<string>;
  setBlocked: (userId: string, blocked: boolean) => Promise<string | null>;
}

export const AppContext = createContext<AppActions>({
  openProfileByUsername: () => {},
  openHashtag: () => {},
  report: () => {},
  blockedIds: new Set(),
  setBlocked: async () => null,
});

export const useAppActions = () => useContext(AppContext);
