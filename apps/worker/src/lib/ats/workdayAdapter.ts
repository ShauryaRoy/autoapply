import type { Page } from "playwright";
import type { ATSAdapter, ApplicantProfile, FormAnswerSet } from "./baseAdapter.js";
import { humanScroll, humanType } from "../humanizer.js";

export class WorkdayAdapter implements ATSAdapter {
  name = "workday";

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("workday");
  }

  async login(page: Page): Promise<"ok" | "needs-user-action"> {
    const needsCaptcha = await page.locator("iframe[title*='captcha']").count();
    if (needsCaptcha > 0) {
      return "needs-user-action";
    }
    return "ok";
  }

  async fillApplicationForm(page: Page, profile: ApplicantProfile, answers: FormAnswerSet): Promise<void> {
    await humanType(page, "input[name='firstName']", profile.firstName);
    await humanType(page, "input[name='lastName']", profile.lastName);
    await humanType(page, "input[name='email']", profile.email);
    await humanType(page, "input[name='phone']", profile.phone);
    await humanScroll(page);

    for (const [field, value] of Object.entries(answers)) {
      const locator = page.locator(`[data-automation-id='${field}'] input, [data-automation-id='${field}'] textarea`).first();
      if ((await locator.count()) > 0) {
        await locator.fill("");
        await locator.type(value, { delay: 45 });
      }
    }
  }

  async submit(page: Page): Promise<void> {
    await page.click("button:has-text('Submit')", { delay: 120 });
    await page.waitForLoadState("networkidle");
  }
}
