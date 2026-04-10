import type { Page } from "playwright";
import type { ATSAdapter, ApplicantProfile, FormAnswerSet } from "./baseAdapter.js";

/**
 * Generic adapter: handles any job URL that doesn't match a known ATS.
 * Uses broad CSS selectors to find and fill common form fields.
 * All selector attempts are fully safe — errors are swallowed gracefully.
 */
export class GenericAdapter implements ATSAdapter {
  name = "generic";

  canHandle(_url: string): boolean {
    return true;
  }

  async login(_page: Page): Promise<"ok" | "needs-user-action"> {
    return "ok";
  }

  async fillApplicationForm(page: Page, profile: ApplicantProfile, answers: FormAnswerSet): Promise<void> {
    // Wait for page to settle before looking for form fields
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Fill standard profile fields
    await this.tryFill(page, [
      "input[name='first_name']", "input[name='firstName']",
      "input[id='first_name']", "input[id='firstName']",
      "input[placeholder*='First name' i]", "input[placeholder*='First Name' i]"
    ], profile.firstName);

    await this.tryFill(page, [
      "input[name='last_name']", "input[name='lastName']",
      "input[id='last_name']", "input[id='lastName']",
      "input[placeholder*='Last name' i]", "input[placeholder*='Last Name' i]"
    ], profile.lastName);

    await this.tryFill(page, [
      "input[name='email']", "input[type='email']",
      "input[id='email']", "input[id*='email' i]",
      "input[placeholder*='Email' i]"
    ], profile.email);

    await this.tryFill(page, [
      "input[name='phone']", "input[type='tel']",
      "input[id='phone']", "input[id*='phone' i]",
      "input[placeholder*='Phone' i]"
    ], profile.phone);

    await this.tryFill(page, [
      "input[name='location']", "input[name='city']",
      "input[id='location']", "input[id*='location' i]",
      "input[placeholder*='Location' i]", "input[placeholder*='City' i]"
    ], profile.location);

    if (profile.linkedIn) {
      await this.tryFill(page, [
        "input[name='linkedin']", "input[name='linkedIn']",
        "input[id*='linkedin' i]", "input[placeholder*='LinkedIn' i]"
      ], profile.linkedIn);
    }

    if (profile.portfolio) {
      await this.tryFill(page, [
        "input[name='portfolio']", "input[name='github']", "input[name='website']",
        "input[id*='portfolio' i]", "input[id*='github' i]", "input[id*='website' i]",
        "input[placeholder*='Portfolio' i]", "input[placeholder*='Website' i]"
      ], profile.portfolio);
    }

    // Fill generated/custom answers
    for (const [key, value] of Object.entries(answers)) {
      if (!value) continue;

      // Try common naming patterns for the answer field
      const selectors = [
        `[name='${key}']`,
        `[id='${key}']`,
        `[data-field-id='${key}']`,
        `[data-automation-id='${key}'] input`,
        `[data-automation-id='${key}'] textarea`,
        `[placeholder*='${key}' i]`
      ];

      // For textareas (cover letters, essays)
      const textareaSelectors = selectors.map(s => s.replace("input", "textarea"));
      const found = await this.tryFill(page, [...selectors, ...textareaSelectors], value);

      // If no specific selector worked, look for visible empty textareas (cover letter)
      if (!found && key.toLowerCase().includes("cover") || key.toLowerCase().includes("why")) {
        await this.tryFill(page, ["textarea:visible", "textarea[required]"], value);
      }
    }

    await page.waitForTimeout(800);
  }

  async submit(page: Page): Promise<void> {
    const submitSelectors = [
      "button[type='submit']",
      "input[type='submit']",
      "button:has-text('Submit Application')",
      "button:has-text('Submit')",
      "button:has-text('Apply Now')",
      "button:has-text('Apply')",
      "button:has-text('Send Application')",
      "a:has-text('Submit')",
      "[data-qa='btn-submit']",
      "[data-testid='submit-application']"
    ];

    for (const sel of submitSelectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && await el.isVisible()) {
          await el.scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);
          await el.click({ force: false });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          return;
        }
      } catch { /* try next */ }
    }
  }

  /**
   * Tries each selector in order, fills the first visible & editable one found.
   * Returns true if a field was successfully filled, false otherwise.
   * Never throws.
   */
  private async tryFill(page: Page, selectors: string[], value: string): Promise<boolean> {
    if (!value) return false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        if (!(await el.isEditable().catch(() => false))) continue;

        await el.scrollIntoViewIfNeeded();
        await el.click({ delay: 80 });
        await el.fill(""); // clear first
        // Type char-by-char for human-like behaviour
        for (const char of value) {
          await page.keyboard.type(char, { delay: Math.floor(Math.random() * 50) + 20 });
        }
        return true;
      } catch { /* try next */ }
    }
    return false;
  }
}
