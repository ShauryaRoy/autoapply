import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export type BrowserName = "chrome" | "edge" | "brave";

export type BrowserInfo = {
  name: BrowserName;
  path: string;
};

// Priority maps to key order implicitly, but we'll enforce it explicitly later
const BROWSER_PATHS: Record<NodeJS.Platform, Record<BrowserName, string[]>> = {
  win32: {
    chrome: [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ],
    edge: [
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    ],
    brave: [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ],
  },
  darwin: {
    chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    brave: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  },
  linux: {
    chrome: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome"],
    edge: ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge"],
    brave: ["/opt/brave.com/brave/brave", "/usr/bin/brave-browser"],
  },
} as any;

/**
 * Detects installed Chromium-based browsers on the host machine.
 * Returns an ordered array prioritizing: Chrome > Edge > Brave.
 */
export async function detectBrowsers(): Promise<BrowserInfo[]> {
  const platform = os.platform();
  const pathsForPlatform = BROWSER_PATHS[platform];

  if (!pathsForPlatform) {
    throw new Error(`Unsupported platform for browser detection: ${platform}`);
  }

  const installedBrowsers: BrowserInfo[] = [];
  const priorityOrder: BrowserName[] = ["chrome", "edge", "brave"];

  for (const name of priorityOrder) {
    const paths = pathsForPlatform[name];
    if (!paths) continue;

    for (const executablePath of paths) {
      if (!executablePath) continue;
      
      if (fs.existsSync(executablePath)) {
        installedBrowsers.push({
          name: name,
          path: executablePath,
        });
        break; // Found the preferred installation path for this browser type
      }
    }
  }

  return installedBrowsers;
}
