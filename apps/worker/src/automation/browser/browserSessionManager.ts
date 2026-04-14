import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { type ChildProcess } from "node:child_process";
import { tryAttachAnyCDP } from "./connectCDP.js";
import { launchBrowserSafe } from "./launchBrowser.js";
import { detectBrowsers, type BrowserName } from "./detectBrowsers.js";
import { getAvailablePort, findActiveCDPPort } from "./portManager.js";
import { type BrowserError, type SessionState } from "./types.js";
import { logger } from "./logger.js";

interface SessionManagerOptions {
  preferredBrowser?: BrowserName;
}

function scorePage(pageUrl: string, targetUrl?: string): number {
  if (!targetUrl) return 0;
  
  let score = 0;
  
  if (pageUrl === targetUrl || pageUrl.startsWith(targetUrl)) {
    score += 100;
  } else {
    try {
      const pageDomain = new URL(pageUrl).hostname;
      const targetDomain = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`).hostname;
      if (pageDomain === targetDomain || pageDomain.endsWith(targetDomain)) {
        score += 50;
      }
    } catch {
      // Ignore URL parsing errors
    }
  }
  return score;
}

export class BrowserSessionManager {
  browser?: Browser;
  context?: BrowserContext;
  process?: ChildProcess;
  port?: number;
  sessionState: SessionState = {};
  
  private preferredBrowser?: BrowserName;
  private isReconnecting = false;

  constructor(options: SessionManagerOptions = {}) {
    this.preferredBrowser = options.preferredBrowser;
  }

  public async connect(): Promise<void> {
    if (this.isAlive()) return;
    
    // ** ATTACH-FIRST STRATEGY **
    const attached = await this.tryAttach();
    if (attached) return; 

    // Attach failed. Launch fallback.
    await this.launchAndConnect();
  }

  public async tryAttach(): Promise<boolean> {
    const result = await tryAttachAnyCDP();
    if (result) {
      this.browser = result.browser;
      this.port = result.port;
      this.setupHandlers();
      return true;
    }
    return false;
  }

  public async launchAndConnect(): Promise<void> {
    const installed = await detectBrowsers();
    if (installed.length === 0) {
      const err: BrowserError = { type: "NO_BROWSER_FOUND", message: "No supported Chromium browsers detected." };
      logger.error("browser.detect.failed");
      throw err;
    }

    const browserInfo = this.preferredBrowser 
      ? installed.find((b) => b.name === this.preferredBrowser) || installed[0]
      : installed[0];

    let allocatedPort: number;
    try {
       allocatedPort = await getAvailablePort(9222);
       this.port = allocatedPort;
    } catch (e: any) {
       const err: BrowserError = { type: "PORT_UNAVAILABLE", message: e.message };
       throw err;
    }

    const launchResult = await launchBrowserSafe(browserInfo, allocatedPort);
    if (launchResult.error) {
       throw launchResult.error;
    }
    this.process = launchResult.process;

    // Connect to the successfully launched instance
    const result = await tryAttachAnyCDP();
    if (!result) {
       throw { type: "LAUNCH_FAILED", message: "Launched browser but CDP attachment timeout." } as BrowserError;
    }

    this.browser = result.browser;
    this.setupHandlers();
  }

  public async getPage(targetUrl?: string): Promise<Page> {
    if (!this.isAlive()) {
      await this.connect();
    }
    if (!this.browser) throw new Error("Fatal: Not connected.");

    this.context = this.browser.contexts()[0] || (await this.browser.newContext());
    const pages = this.context.pages();

    if (targetUrl) {
      let bestPage = null;
      let highestScore = -1;

      for (const p of pages) {
        try {
          const score = scorePage(p.url(), targetUrl);
          if (score > highestScore && score >= 50) {
            highestScore = score;
            bestPage = p;
          }
        } catch { continue; }
      }

      if (bestPage) {
        logger.info("page.resolved.existing", { targetUrl, score: highestScore });
        await bestPage.bringToFront().catch(() => {});
        this.trackPage(bestPage);
        return bestPage;
      }
    }

    logger.info("page.resolved.new", { targetUrl });
    const newPage = await this.context.newPage();
    this.trackPage(newPage);
    return newPage;
  }

  private trackPage(page: Page) {
     // Ideally page tracking anchors to unique properties
     this.sessionState = {
        originUrl: page.url(),
        lastInteractionAt: Date.now()
     };
  }

  public isAlive(): boolean {
    return this.browser ? this.browser.isConnected() : false;
  }

  public async reconnect(): Promise<void> {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    logger.info("session.reconnect.started");

    await this.disconnect();

    // Give the underlying browser process a moment to organically restart if the user closed/opened it
    await new Promise(r => setTimeout(r, 1000));

    try {
      await this.connect();
      logger.info("session.reconnect.success");
    } catch (e: any) {
      logger.error("session.reconnect.failed", { error: e.message || e });
    } finally {
      this.isReconnecting = false;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    this.cleanup();
  }

  private setupHandlers() {
    if (!this.browser) return;
    this.browser.on("disconnected", () => {
      logger.warn("browser.disconnected");
      this.cleanup();
      // Optional: Auto-trigger reconnect here if execution flow isn't handling it manually
    });
  }

  private cleanup() {
    this.browser = undefined;
    this.context = undefined;
    this.process = undefined;
  }
}
