import { spawn, ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { type BrowserInfo } from "./detectBrowsers.js";
import { type BrowserError } from "./types.js";
import { logger } from "./logger.js";

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
  
  return path.join(home, `.${browserName}`);
}

/**
 * Validates whether the user's native profile is currently hijacked by a non-CDP instance.
 */
export async function isProfileLocked(userDataDir: string): Promise<boolean> {
  const lock1 = path.join(userDataDir, "SingletonLock");
  const lock2 = path.join(userDataDir, "lockfile");
  
  try {
    return fs.existsSync(lock1) || fs.existsSync(lock2);
  } catch (e) {
    return true; // fail securely
  }
}

export type LaunchResult = {
  process?: ChildProcess;
  error?: BrowserError;
}

/**
 * Safely spawns the browser. Does not throw raw node exceptions on locks, 
 * returning typed UI-renderable BrowserErrors instead.
 */
export async function launchBrowserSafe(
  browserInfo: BrowserInfo, 
  port: number
): Promise<LaunchResult> {
  const userDataDir = getDefaultUserDataDir(browserInfo.name);

  if (await isProfileLocked(userDataDir)) {
    logger.error("profile.locked", { path: userDataDir });
    return {
      error: {
        type: "PROFILE_LOCKED",
        message: `${browserInfo.name} is already running without automation enabled. Please restart ${browserInfo.name} via Autoapply or close it and retry.`,
      }
    };
  }

  // Removed --remote-allow-origins. CDP safely bounds to localhost generically unless explicitly bound otherwise.
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--restore-last-session"
  ];

  logger.info("browser.launch.started", { port, browser: browserInfo.name });
  
  const processHandle = spawn(browserInfo.path, args, {
    detached: true,
    stdio: "ignore",
  });
  
  processHandle.unref();

  // Allow time for IPC delegation exits or hard crashes
  await new Promise((resolve) => setTimeout(resolve, 2000));
  
  if (processHandle.exitCode !== null) {
      logger.error("browser.launch.failed", { exitCode: processHandle.exitCode });
      return {
        error: {
          type: "LAUNCH_FAILED",
          message: "Browser process exited immediately. Another hidden instance may be blocking execution.",
        }
      };
  }

  return { process: processHandle };
}
