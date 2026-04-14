import { spawn, ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { type BrowserInfo } from "./detectBrowsers.js";

function getDefaultUserDataDir(browserName: BrowserInfo["name"]): string {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    switch (browserName) {
      case "chrome": return path.join(localAppData, "Google", "Chrome", "User Data");
      case "edge": return path.join(localAppData, "Microsoft", "Edge", "User Data");
      case "brave": return path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data");
    }
  } else if (platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    switch (browserName) {
      case "chrome": return path.join(appSupport, "Google", "Chrome");
      case "edge": return path.join(appSupport, "Microsoft Edge");
      case "brave": return path.join(appSupport, "BraveSoftware", "Brave-Browser");
    }
  }
  
  // Default fallback for linux or unknown
  return path.join(home, `.${browserName}`);
}

/**
 * Launches the selected browser using its actual user profile.
 * Exposes the Chromium DevTools Protocol (CDP) on the specified port.
 */
export async function launchBrowser(
  browserInfo: BrowserInfo, 
  port: number = 9222
): Promise<ChildProcess> {
  const userDataDir = getDefaultUserDataDir(browserInfo.name);

  // If the directory doesn't exist, the browser will create it, but we log it.
  if (!fs.existsSync(userDataDir)) {
    console.warn(`[LaunchBrowser] Expected user data directory does not exist: ${userDataDir}`);
  }

  // To connect properly without launching a fresh anonymous profile, we point to the 
  // real User Data directory.
  // Note: if the browser is ALREADY running without --remote-debugging-port,
  // this spawn command will often just open a new tab in the existing browser 
  // and exit, failing to expose the port. The user must usually close the browser first,
  // or it must have been launched initially with the remote debugging flag.
  
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // These args help stabilize CDP behavior
    "--restore-last-session"
  ];

  console.log(`[LaunchBrowser] Launching ${browserInfo.name} at: ${browserInfo.path}`);
  console.log(`[LaunchBrowser] Arguments:`, args.join(" "));

  const browserProcess = spawn(browserInfo.path, args, {
    detached: true,
    stdio: "ignore", // We detach and ignore stdio to not bind it tightly to the Node process lifecycle
  });

  browserProcess.unref(); // Allow the parent process to exit independently

  // Give the browser a moment to start up and bind the port
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return browserProcess;
}
