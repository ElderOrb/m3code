import type { ReactNode } from "react";

export type T3ConnectAccountPageUrl = "mobile-clients" | "t3-connect" | "t3-chat";

export function useT3ConnectAccountPage(): {
  readonly open: ((page?: T3ConnectAccountPageUrl) => void) | null;
  readonly portals: ReactNode;
} {
  return { open: null, portals: null };
}
