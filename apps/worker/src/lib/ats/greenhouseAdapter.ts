import type { Page } from "playwright";
import type { ATSAdapter, ApplicantProfile, FormAnswerSet } from "./baseAdapter.js";
import { humanType } from "../humanizer.js";

export class GreenhouseAdapter implements ATSAdapter {
  name = "greenhouse";

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("greenhouse");
  }

  async login(_page: Page): Promise<"ok" | "needs-user-action"> {
    return "ok";
  }

  async fillApplicationForm(page: Page, profile: ApplicantProfile, answers: FormAnswerSet): Promise<void> {
    await humanType(page, "#first_name", profile.firstName);
    await humanType(page, "#last_name", profile.lastName);
    await humanType(page, "#email", profile.email);

    for (const [field, value] of Object.entries(answers)) {
      const fallback = page.locator(`input[name='${field}'], textarea[name='${field}']`).first();
      if ((await fallback.count()) > 0) {
        await fallback.fill(value);
      }
    }
  }

  async submit(page: Page): Promise<void> {
    await page.click("#submit_app", { delay: 120 });
    await page.waitForLoadState("networkidle");
  }
}
