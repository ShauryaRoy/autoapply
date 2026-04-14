import { chromium, type Browser } from "playwright-core";

/**
 * Connects to a running Chromium-based browser over CDP using Playwright.
 * 
 * @param port The debug port to connect to (default: 9222)
 * @returns Playwright Browser instance
 */
export async function connectOverCDP(port: number = 9222): Promise<Browser> {
  const cdpUrl = `http://localhost:${port}`;
  
  console.log(`[ConnectCDP] Attempting to connect Playwright over CDP to ${cdpUrl}`);
  
  try {
    const browser = await chromium.connectOverCDP(cdpUrl);
    console.log(`[ConnectCDP] Successfully connected to browser via CDP.`);
    return browser;
  } catch (error: any) {
    console.error(`[ConnectCDP] Failed to connect to CDP at ${cdpUrl}`);
    console.error(`[ConnectCDP] Make sure the browser is running with --remote-debugging-port=${port}`);
    throw error;
  }
}
