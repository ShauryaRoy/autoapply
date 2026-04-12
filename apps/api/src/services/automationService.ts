/**
 * automationService.ts
 *
 * Automation Engine Controller. Launches Playwright, drives platform/form
 * detection, maps fields, fills the form, and manages submission/logs.
 */

import { chromium } from "playwright";
import { detectPlatform } from "../utils/platformDetector.js";
import { detectFormFields } from "../utils/formDetector.js";
import { mapFields, AutomationPayload } from "../utils/fieldMapper.js";
import { fillForm } from "../utils/fillEngine.js";

export interface AutomationResult {
  status: "SUCCESS" | "FAILED";
  logs: string[];
  errors: string[];
  platform_detected: string;
  screenshot_path?: string;
}

const APPLY_BTN_PATTERNS = [
  /submit application/i,
  /apply/i,
  /postuler/i,
  /submit/i
];

export async function runAutomation(
  jobUrl: string, 
  payload: AutomationPayload
): Promise<AutomationResult> {
  const result: AutomationResult = {
    status: "FAILED",
    logs: [],
    errors: [],
    platform_detected: "unknown"
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    result.logs.push(`Navigating to ${jobUrl}...`);
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Advanced Hydration (Replaces fixed timeout)
    try {
      await page.waitForSelector("form, input, textarea", { timeout: 8000 });
    } catch {
      result.logs.push("[Hydration] Form elements not immediately found. Waiting for network idle.");
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
    }
    
    // 1. Detect Platform
    const platform = detectPlatform(page.url());
    result.platform_detected = platform;
    result.logs.push(`[Detection] Platform detected: ${platform}`);

    // 2. Apply Button Handler (NEW LAYER)
    // Scan for apply buttons before looking for the form
    const INITIAL_APPLY_PATTERNS = /apply now|apply|submit application/i;
    const applyBtn = page.locator('button, a, [role="button"], [role="link"]')
                         .filter({ hasText: INITIAL_APPLY_PATTERNS }).first();
    
    if (await applyBtn.isVisible().catch(() => false)) {
      result.logs.push("[Apply Handler] Clicking 'Apply' button to expose form...");
      await applyBtn.click({ timeout: 5000 }).catch(() => null);
      // Wait for form to appear
      try {
        await page.waitForSelector("form, input, textarea", { state: "visible", timeout: 8000 });
      } catch {
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
      }
    }

    // 2. Detect Form Fields
    result.logs.push("Detecting form fields...");
    const fields = await detectFormFields(page);
    if (fields.length === 0) {
      throw new Error("No form fields detected. Form may be in an iframe or requires login.");
    }
    result.logs.push(`Detected ${fields.length} inputs.`);

    // 3. Map Fields
    result.logs.push("Mapping fields to intelligence payload...");
    const mapped = mapFields(fields, payload);

    // 4. Fill Form
    result.logs.push("Filling form...");
    const fillLogs = await fillForm(page, mapped);
    result.logs.push(...fillLogs);

    // 4.5. Form Completeness Check
    result.logs.push("[Validation] Checking form completeness...");
    const missingRequired = mapped.filter(m => m.field.required && !m.value);
    if (missingRequired.length > 0) {
      result.logs.push(`[Validation] WARNING: ${missingRequired.length} required fields are missing data:`);
      missingRequired.forEach(m => result.logs.push(`   - ${m.field.label || m.field.name}`));
      // We will still attempt submit, as ATS forms often have hidden or incorrectly marked required fields.
    }

    // 5. Submit Handler
    result.logs.push("[Submit] Looking for submit confirmation button...");
    
    let clickedSubmit = false;
    let submitSuccess = false;
    const initialUrl = page.url();

    for (const pattern of APPLY_BTN_PATTERNS) {
      const submitBtn = page.locator('button, input[type="submit"], input[type="button"]')
                            .filter({ hasText: pattern }).first();
      
      if (await submitBtn.isVisible().catch(() => false)) {
        result.logs.push(`[Submit] Safe clicking submit button matching pattern /${pattern.source}/`);
        
        let attempts = 0;
        while (attempts < 2 && !submitSuccess) {
          attempts++;
          try {
            await submitBtn.click({ timeout: 5000 });
            clickedSubmit = true;
            
            // Wait for success signals: URL change OR success message
            try {
              // Concurrently wait for either navigation or specific success text
              await Promise.race([
                page.waitForURL((url) => url.toString() !== initialUrl, { timeout: 10000 }),
                page.waitForSelector("text=/thank you|application submitted|successfully/i", { state: "visible", timeout: 10000 })
              ]);
              submitSuccess = true;
              result.logs.push("[Submit] Success signals detected.");
            } catch {
              result.logs.push(`[Submit] Attempt ${attempts}: No obvious success signals observed.`);
            }
          } catch (e) {
             result.logs.push(`[Submit] Warning: click attempt ${attempts} failed.`);
             await page.waitForTimeout(1000);
          }
        }
        break; // Only try the first matched button pattern fully
      }
    }

    if (!clickedSubmit) {
      result.logs.push("[Submit] WARNING: Submit button not found or not clickable.");
      throw new Error("Could not find submit button.");
    }
    
    if (clickedSubmit && !submitSuccess) {
       result.logs.push("[Submit] WARNING: Button clicked but no success confirmation detected. Continuing as uncertain.");
       // Not failing outright because some ATS portals lack standard confirmations or URLs
    }

    result.status = "SUCCESS";
    result.logs.push("Application automation completed successfully.");

  } catch (err: any) {
    result.status = "FAILED";
    result.errors.push(err.message);
    result.logs.push(`FATAL: ${err.message}`);
    
    // 8. Screenshot Logging
    try {
      const timestamp = new Date().getTime();
      const path = `/tmp/automation-error-${timestamp}.png`;
      await page.screenshot({ path, fullPage: true });
      result.screenshot_path = path;
      result.logs.push(`Saved failure screenshot to: ${path}`);
    } catch {
      result.logs.push("Could not capture failure screenshot.");
    }
  } finally {
    // Teardown
    await context.close();
    await browser.close();
  }

  return result;
}
