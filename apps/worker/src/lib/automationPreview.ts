import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { workerLogEvent } from "./apiClient.js";

/**
 * Captures a screenshot and returns the HTTP URL so the desktop can display it.
 * Screenshots are stored in the worker's `runtime/automation-previews/` folder
 * and served via the API's /api/previews/:applicationId/:file route.
 */
export async function captureAutomationPreview(
  page: Page,
  applicationId: string,
  step: string
): Promise<{ screenshotPath: string; screenshotUrl: string } | undefined> {
  try {
    const baseDir = path.resolve(process.cwd(), "runtime", "automation-previews", applicationId);
    await fs.mkdir(baseDir, { recursive: true });

    const fileName = `${Date.now()}-${step}.png`;
    const fullPath = path.join(baseDir, fileName);
    await page.screenshot({ path: fullPath, fullPage: false, timeout: 8000 });

    const apiBase = process.env.API_BASE_URL ?? "http://localhost:4000";
    const screenshotUrl = `${apiBase}/api/previews/${applicationId}/${fileName}`;

    return { screenshotPath: fullPath, screenshotUrl };
  } catch {
    return undefined;
  }
}

/**
 * Starts a background interval that takes screenshots and emits them as events
 * so the user sees live browser activity. Returns a stop function.
 */
export function startLivePreviewPolling(
  page: Page,
  applicationId: string
): () => void {
  let stopped = false;
  let frameCount = 0;

  const poll = async () => {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (stopped) break;
      frameCount++;
      const preview = await captureAutomationPreview(page, applicationId, `live-${frameCount}`);
      if (preview) {
        await workerLogEvent({
          applicationId,
          step: "form_filled",
          message: `Live preview frame ${frameCount}`,
          payloadJson: {
            screenshotPath: preview.screenshotPath,
            screenshotUrl: preview.screenshotUrl,
            liveFrame: true
          }
        }).catch(() => {});
      }
    }
  };

  void poll();

  return () => { stopped = true; };
}
