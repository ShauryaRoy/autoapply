import type { Page } from "playwright";

/**
 * Types into a field with human-like timing.
 * Safely skips if the element doesn't exist or isn't visible/editable.
 */
export async function humanType(page: Page, selector: string, value: string): Promise<void> {
  if (!value) return;
  try {
    const el = page.locator(selector).first();
    if ((await el.count()) === 0) return;
    if (!(await el.isVisible().catch(() => false))) return;
    if (!(await el.isEditable().catch(() => false))) return;

    await el.scrollIntoViewIfNeeded();
    await el.click({ delay: random(80, 200) });
    await el.fill(""); // clear existing value
    for (const char of value) {
      await page.keyboard.type(char, { delay: random(25, 95) });
    }
  } catch {
    // Element not found or not interactable — skip gracefully
  }
}

export async function humanScroll(page: Page): Promise<void> {
  const steps = random(4, 9);
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, random(220, 680));
    await page.waitForTimeout(random(120, 390));
  }
}

export function random(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
