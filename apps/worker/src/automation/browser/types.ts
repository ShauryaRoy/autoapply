export type BrowserName = "chrome" | "edge" | "brave";

export type BrowserInfo = {
  name: BrowserName;
  path: string;
};

export type BrowserError =
  | { type: "PROFILE_LOCKED"; message: string }
  | { type: "NO_BROWSER_FOUND"; message: string }
  | { type: "PORT_UNAVAILABLE"; message: string }
  | { type: "LAUNCH_FAILED"; message: string };

export type SessionState = {
  controlledPageId?: string;
  originUrl?: string;
  lastInteractionAt?: number;
};
