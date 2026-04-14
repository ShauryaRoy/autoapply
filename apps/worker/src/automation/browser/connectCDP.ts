import { chromium, type Browser } from "playwright-core";
import { findActiveCDPPort } from "./portManager.js";
import { logger } from "./logger.js";

/**
 * Searches configured port ranges for an active CDP endpoint.
 * Secures attachment via Playwright if a hit resolves.
 */
export async function tryAttachAnyCDP(): Promise<{ browser: Browser, port: number } | null> {
  logger.info("cdp.attach.attempt");
  const activePort = await findActiveCDPPort();
  
  if (!activePort) {
    logger.warn("cdp.attach.failed", { reason: "No active CDP endpoints found during port scan." });
    return null;
  }

  const cdpUrl = `http://127.0.0.1:${activePort}`;
  
  try {
    const browser = await chromium.connectOverCDP(cdpUrl);
    logger.info("cdp.attach.success", { port: activePort });
    return { browser, port: activePort };
  } catch (error: any) {
    logger.error("cdp.attach.error", { port: activePort, message: error.message });
    return null;
  }
}
