import { chromium, type Browser, type BrowserContext } from "playwright";

type SessionHandle = {
  context: BrowserContext;
  browser?: Browser;
  attachedViaCdp: boolean;
};

const contextStore = new Map<string, SessionHandle>();
const DEFAULT_CDP_URLS = [
  "http://127.0.0.1:9333",
  "http://127.0.0.1:9222"
];

function useInAppOnlyMode(): boolean {
  // Default behavior: keep automation inside app preview flow and never open external windows.
  return process.env.PLAYWRIGHT_IN_APP_ONLY !== "false";
}

function shouldAttachExistingBrowser(): boolean {
  if (useInAppOnlyMode()) {
    return false;
  }
  return process.env.PLAYWRIGHT_ATTACH_EXISTING_BROWSER !== "false";
}

function allowIsolatedFallback(): boolean {
  return process.env.PLAYWRIGHT_ALLOW_ISOLATED_FALLBACK !== "false";
}

function shouldRunIsolatedHeadless(): boolean {
  // Default to headless for fallback so users can stay in the in-app preview flow.
  return process.env.PLAYWRIGHT_HEADLESS !== "false";
}

function getCdpUrl(): string {
  return process.env.PLAYWRIGHT_CDP_URL ?? "http://127.0.0.1:9222";
}

function getCandidateCdpUrls(): string[] {
  const explicit = process.env.PLAYWRIGHT_CDP_URL?.trim();
  if (explicit) {
    return [explicit];
  }

  return DEFAULT_CDP_URLS;
}

type CdpEndpointInfo = {
  cdpUrl: string;
  browserIdentity: string;
  userAgent: string;
};

async function inspectSupportedCdpEndpoint(cdpUrl: string): Promise<CdpEndpointInfo> {
  const normalized = cdpUrl.endsWith("/") ? cdpUrl.slice(0, -1) : cdpUrl;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  let response: Response;
  try {
    response = await fetch(`${normalized}/json/version`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }

  const payload = await response.json() as {
    Browser?: string;
    "User-Agent"?: string;
  };

  const browserIdentity = payload.Browser ?? "unknown";
  const userAgent = payload["User-Agent"] ?? "";
  const normalizedBrowser = browserIdentity.toLowerCase();
  const normalizedUserAgent = userAgent.toLowerCase();

  if (normalizedUserAgent.includes("tsenta") || normalizedUserAgent.includes("electron")) {
    throw new Error(`unsupported shell (${browserIdentity})`);
  }

  if (!normalizedBrowser.includes("chrome") && !normalizedBrowser.includes("chromium") && !normalizedBrowser.includes("edge")) {
    throw new Error(`unsupported browser (${browserIdentity})`);
  }

  return {
    cdpUrl: normalized,
    browserIdentity,
    userAgent
  };
}

async function connectSupportedCdpBrowser(): Promise<{ browser: Browser; context: BrowserContext; info: CdpEndpointInfo } | null> {
  const candidates = getCandidateCdpUrls();
  const failures: string[] = [];

  for (const cdpUrl of candidates) {
    try {
      const info = await inspectSupportedCdpEndpoint(cdpUrl);
      const browser = await chromium.connectOverCDP(info.cdpUrl);
      const context = browser.contexts()[0];

      if (!context) {
        throw new Error("no browser context available");
      }

      return { browser, context, info };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${cdpUrl}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`No valid CDP endpoint found. Attempts: ${failures.join(" | ")}`);
  }

  return null;
}

export class PlaywrightManager {
  async getPersistentContext(userId: string): Promise<BrowserContext> {
    const existing = contextStore.get(userId);
    if (existing) {
      return existing.context;
    }

    if (shouldAttachExistingBrowser()) {
      try {
        const connected = await connectSupportedCdpBrowser();
        if (!connected) {
          throw new Error("No CDP browser context found.");
        }

        contextStore.set(userId, {
          context: connected.context,
          browser: connected.browser,
          attachedViaCdp: true
        });
        return connected.context;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!allowIsolatedFallback()) {
          throw new Error(
            `[playwrightManager] CDP attach failed (${message}). ` +
            "By default this worker will not open an isolated unsigned browser. " +
            `Start Chrome with remote debugging on one of: ${getCandidateCdpUrls().join(", ")} and keep one tab open, or set PLAYWRIGHT_ALLOW_ISOLATED_FALLBACK=true.`
          );
        }

        console.warn("[playwrightManager] CDP attach failed, falling back to isolated context", error);
      }
    }

    if (useInAppOnlyMode()) {
      console.info("[playwrightManager] in-app-only mode enabled; running headless isolated automation context");
    }

    const context = await chromium.launchPersistentContext(`./.sessions/${userId}`, {
      headless: useInAppOnlyMode() ? true : shouldRunIsolatedHeadless(),
      viewport: { width: 1440, height: 900 }
    });

    contextStore.set(userId, {
      context,
      attachedViaCdp: false
    });
    return context;
  }

  async closeContext(userId: string): Promise<void> {
    const handle = contextStore.get(userId);
    if (!handle) return;

    if (handle.attachedViaCdp) {
      contextStore.delete(userId);
      return;
    }

    await handle.context.close();
    contextStore.delete(userId);
  }
}
