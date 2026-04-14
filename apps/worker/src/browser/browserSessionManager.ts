import { type Browser, type Page } from "playwright-core";
import { connectOverCDP } from "./connectCDP.js";
import { launchBrowser } from "./launchBrowser.js";
import { detectBrowsers, type BrowserInfo, type BrowserName } from "./detectBrowsers.js";

interface SessionManagerOptions {
  port?: number;
  preferredBrowser?: BrowserName;
}

export class BrowserSessionManager {
  private browser: Browser | null = null;
  private port: number;
  private preferredBrowser?: BrowserName;
  private browserInfo: BrowserInfo | null = null;

  constructor(options: SessionManagerOptions = {}) {
    this.port = options.port || 9222;
    this.preferredBrowser = options.preferredBrowser;
  }

  /**
   * Main entry point to get a connected session.
   * Attempts to connect, and if it fails, launches the browser and retries.
   */
  public async connect(): Promise<void> {
    if (this.browser?.isConnected()) {
      return;
    }

    try {
      // First, attempt to connect to an already running instance
      this.browser = await connectOverCDP(this.port);
      this.setupEventHandlers();
      console.log("[BrowserSessionManager] Attached to existing browser session.");
    } catch (e) {
      console.log("[BrowserSessionManager] Could not attach. Attempting to launch browser natively.");
      await this.launchAndConnect();
    }
  }

  /**
   * Gets a usable page from the browser context. 
   * Opens a new page if none exist, or if requested.
   */
  public async getPage(openNewTab: boolean = false): Promise<Page> {
    if (!this.browser || !this.browser.isConnected()) {
      await this.connect();
    }

    if (!this.browser) {
      throw new Error("[BrowserSessionManager] Fatal: Could not establish browser connection.");
    }

    const contexts = this.browser.contexts();
    const defaultContext = contexts[0] || (await this.browser.newContext());

    if (openNewTab) {
      return await defaultContext.newPage();
    }

    const pages = defaultContext.pages();
    if (pages.length > 0) {
      // Try to return the most recently active page (usually the last in the array or the first depending on state)
      // Usually the active tab in CDP is contexts[0].pages()[0] 
      return pages[0];
    }

    return await defaultContext.newPage();
  }

  /**
   * Explicitly attempts to reconnect if the connection dropped.
   */
  public async reconnect(): Promise<void> {
    console.log("[BrowserSessionManager] Forcing reconnect...");
    this.cleanup();
    await this.connect();
  }

  /**
   * Shuts down the CDP connection (does not kill the actual browser process)
   */
  public async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close(); // When using connectOverCDP, this disconnects rather than closing the browser natively.
      this.cleanup();
    }
  }

  private async launchAndConnect(): Promise<void> {
    const installed = await detectBrowsers();
    if (installed.length === 0) {
      throw new Error("No supported Chromium-based browsers detected on the system.");
    }

    // Pick preferred or default to first installed
    if (this.preferredBrowser) {
      this.browserInfo = installed.find((b) => b.name === this.preferredBrowser) || installed[0];
    } else {
      this.browserInfo = installed[0];
    }

    console.log(`[BrowserSessionManager] Selected browser to launch: ${this.browserInfo.name}`);

    // Spawn the process
    await launchBrowser(this.browserInfo, this.port);

    // Try connecting
    this.browser = await connectOverCDP(this.port);
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    if (!this.browser) return;
    
    this.browser.on("disconnected", () => {
      console.warn("[BrowserSessionManager] Warning: Browser disconnected from CDP.");
      this.cleanup();
    });
  }

  private cleanup() {
    this.browser = null;
  }
}
