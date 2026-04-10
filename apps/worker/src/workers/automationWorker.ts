import type { Job } from "bullmq";
import { PlaywrightManager } from "../lib/playwrightManager.js";
import { workerAdvanceStep, workerLogEvent, workerUpdateStep } from "../lib/apiClient.js";
import { captureAutomationPreview, startLivePreviewPolling } from "../lib/automationPreview.js";
import { intelligentlyFillPage, clickApplyOrNextButton } from "../lib/intelligentFormFiller.js";

const manager = new PlaywrightManager();

export async function runAutomation(job: Job): Promise<void> {
  const { applicationId, userId, step, jobUrl, metadata } = job.data as {
    applicationId: string;
    userId: string;
    step: string;
    jobUrl?: string;
    metadata?: Record<string, unknown>;
  };

  console.log(`\n🤖 [automationWorker] step="${step}" appId=${applicationId} url=${jobUrl}`);

  const context = await manager.getPersistentContext(userId);
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }
  console.log(`   Browser page ready (${context.pages().length} pages open)`);

  // ── STEP: browser_started ──────────────────────────────────────────────
  if (step === "browser_started") {
    console.log("   → Navigating to job URL...");
    try {
      await page.goto(jobUrl ?? "about:blank", { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (error) {
      console.error("   ✖ Navigation failed:", error instanceof Error ? error.message : error);
      const failedPreview = await captureAutomationPreview(page, applicationId, "navigation_failed");
      await workerLogEvent({
        applicationId,
        step: "browser_started",
        message: `Navigation failed: ${error instanceof Error ? error.message : "Unknown"}`,
        payloadJson: {
          screenshotPath: failedPreview?.screenshotPath,
          screenshotUrl: failedPreview?.screenshotUrl
        }
      }).catch(() => {});
      throw error;
    }

    // Wait for page to fully render
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const title = await page.title().catch(() => "Unknown");
    console.log(`   ✓ Page loaded: "${title}" (${page.url()})`);

    const loadedPreview = await captureAutomationPreview(page, applicationId, "page_loaded");
    await workerLogEvent({
      applicationId,
      step: "browser_started",
      message: `Page loaded: "${title}"`,
      payloadJson: {
        url: page.url(),
        screenshotPath: loadedPreview?.screenshotPath,
        screenshotUrl: loadedPreview?.screenshotUrl
      }
    }).catch(() => {});

    // Try clicking an "Apply Now" / "Start Application" button
    console.log("   → Looking for Apply/Start button...");
    const clickedApply = await clickApplyOrNextButton(page);
    if (clickedApply) {
      console.log("   ✓ Clicked Apply/Start button");
      const afterApply = await captureAutomationPreview(page, applicationId, "apply_clicked");
      await workerLogEvent({
        applicationId,
        step: "browser_started",
        message: "Clicked Apply/Start button — entering application form",
        payloadJson: {
          screenshotPath: afterApply?.screenshotPath,
          screenshotUrl: afterApply?.screenshotUrl
        }
      }).catch(() => {});
    } else {
      console.log("   – No Apply button found (might already be on the form)");
    }

    console.log("   → Advancing to logged_in...");
    try {
      await workerAdvanceStep({ applicationId, nextStep: "logged_in" });
      console.log("   ✓ Advanced to logged_in");
    } catch (err) {
      console.error("   ✖ Failed to advance:", err instanceof Error ? err.message : err);
      throw err;
    }
    return;
  }

  // ── STEP: logged_in ────────────────────────────────────────────────────
  if (step === "logged_in") {
    console.log("   → Checking for CAPTCHA/login walls...");
    const hasCaptcha = await page.locator("iframe[title*='captcha' i], iframe[src*='captcha' i], [class*='captcha' i]").count();
    const hasLoginForm = await page.locator("form[action*='login'], form[action*='sign'], input[type='password']").count();

    if (hasCaptcha > 0 || hasLoginForm > 0) {
      console.log(`   ⚠ Detected: captcha=${hasCaptcha} login=${hasLoginForm}`);
      await workerUpdateStep({
        applicationId,
        currentStep: "logged_in",
        status: "waiting_user_action",
        checkpointJson: { needsCaptcha: hasCaptcha > 0, needsLogin: hasLoginForm > 0 }
      });
      await workerLogEvent({
        applicationId,
        step: "logged_in",
        message: hasCaptcha > 0 ? "CAPTCHA detected — solve it manually" : "Login required — sign in manually",
        payloadJson: {}
      }).catch(() => {});
      return;
    }

    console.log("   ✓ No login wall detected");
    console.log("   → Advancing to form_filled...");
    try {
      await workerAdvanceStep({ applicationId, nextStep: "form_filled" });
      console.log("   ✓ Advanced to form_filled");
    } catch (err) {
      console.error("   ✖ Failed to advance:", err instanceof Error ? err.message : err);
      throw err;
    }
    return;
  }

  // ── STEP: form_filled ──────────────────────────────────────────────────
  if (step === "form_filled") {
    const profile = (metadata?.profile as Record<string, string> | undefined) ?? {};
    const answers = (metadata?.answers as Record<string, string> | undefined) ?? {};
    const resumeText = String(metadata?.resumeText ?? "");

    console.log(`   → Starting AI form fill for ${profile.firstName} ${profile.lastName} (${profile.email})`);
    console.log(`     Resume: ${resumeText.length} chars, Answers: ${Object.keys(answers).length}`);

    await workerLogEvent({
      applicationId,
      step: "form_filled",
      message: `Starting AI-powered form fill for ${profile.firstName ?? "Applicant"} ${profile.lastName ?? ""}`,
      payloadJson: { name: `${profile.firstName} ${profile.lastName}`, email: profile.email }
    }).catch(() => {});

    // Start live preview polling so the user can watch in real-time
    const stopPolling = startLivePreviewPolling(page, applicationId);

    try {
      // Scroll to top
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(500);

      // ★ Use the intelligent form filler
      const result = await intelligentlyFillPage(
        page,
        {
          firstName: profile.firstName ?? "",
          lastName: profile.lastName ?? "",
          email: profile.email ?? "",
          phone: profile.phone ?? "",
          location: profile.location ?? "",
          linkedIn: profile.linkedIn,
          portfolio: profile.portfolio,
          resumeText,
          yearsExperience: answers["years-experience"],
          coverLetter: answers["cover-letter"],
          answers
        },
        async (msg: string) => {
          console.log(`     📝 ${msg}`);
          const preview = await captureAutomationPreview(page, applicationId, "filling");
          await workerLogEvent({
            applicationId,
            step: "form_filled",
            message: msg,
            payloadJson: {
              screenshotPath: preview?.screenshotPath,
              screenshotUrl: preview?.screenshotUrl
            }
          }).catch(() => {});
        }
      );

      console.log(`   ✓ Form fill done: filled=${result.totalFilled} skipped=${result.totalSkipped} failed=${result.totalFailed} pages=${result.pagesProcessed}`);

      const formDonePreview = await captureAutomationPreview(page, applicationId, "form_filled");
      await workerLogEvent({
        applicationId,
        step: "form_filled",
        message: `Form fill complete — ${result.totalFilled} fields filled across ${result.pagesProcessed} page(s)`,
        payloadJson: {
          ...result,
          screenshotPath: formDonePreview?.screenshotPath,
          screenshotUrl: formDonePreview?.screenshotUrl
        }
      }).catch(() => {});
    } catch (err) {
      console.error("   ✖ Form fill error:", err instanceof Error ? err.message : err);
      throw err;
    } finally {
      stopPolling();
    }

    console.log("   → Advancing to submitted...");
    try {
      await workerAdvanceStep({ applicationId, nextStep: "submitted" });
      console.log("   ✓ Advanced to submitted");
    } catch (err) {
      console.error("   ✖ Failed to advance:", err instanceof Error ? err.message : err);
      throw err;
    }
    return;
  }

  // ── STEP: submitted ────────────────────────────────────────────────────
  console.log("   → Looking for submit button...");

  const submitSelectors = [
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Submit Application')",
    "button:has-text('Submit')",
    "button:has-text('Apply')",
    "button:has-text('Send')",
    "button:has-text('Complete Application')",
    "button:has-text('Finish')",
    "a:has-text('Submit Application')",
    "[data-qa='btn-submit']"
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        console.log(`   → Clicking: ${sel}`);
        await btn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await btn.click();
        submitted = true;
        break;
      }
    } catch { /* try next */ }
  }

  await page.waitForTimeout(3000);
  console.log(`   ${submitted ? "✓" : "–"} Submit: ${submitted ? "clicked" : "no button found"}`);

  const submittedPreview = await captureAutomationPreview(page, applicationId, "submitted");
  await workerLogEvent({
    applicationId,
    step: "submitted",
    message: submitted ? "✓ Application submitted!" : "Could not find submit button — may need manual review",
    payloadJson: {
      submitted,
      screenshotPath: submittedPreview?.screenshotPath,
      screenshotUrl: submittedPreview?.screenshotUrl
    }
  }).catch(() => {});

  console.log("   → Advancing to completed...");
  try {
    await workerAdvanceStep({ applicationId, nextStep: "completed" });
    console.log("   ✓ DONE — Application completed!");
  } catch (err) {
    console.error("   ✖ Failed to advance:", err instanceof Error ? err.message : err);
    throw err;
  }
}
