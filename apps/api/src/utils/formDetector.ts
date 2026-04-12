/**
 * formDetector.ts
 *
 * Runs inside the Playwright browser context to dynamically extract all
 * interactable application form fields.
 */

import type { Page } from "playwright";

export interface FormField {
  id: string;
  type: string;
  tagName: string;
  label: string;
  placeholder: string;
  name: string;
  required: boolean;
  options?: string[]; // For selects
}

export async function detectFormFields(page: Page): Promise<FormField[]> {
  return await page.evaluate(() => {
    const fields: FormField[] = [];
    // Broad selector covering most ATS inputs
    const inputs = document.querySelectorAll(
      'input:not([type="hidden"]), textarea, select'
    );

    for (const el of Array.from(inputs)) {
      const type = el.getAttribute("type") || "text";
      const tagName = el.tagName.toLowerCase();
      // Skip irrelevant inputs
      if (["submit", "button", "hidden", "image"].includes(type)) continue;

      let label = "";
      const id = el.id;
      
      // Attempt 1: explicitly associated label
      if (id) {
        const matchingLabel = document.querySelector(`label[for="${id}"]`);
        if (matchingLabel) {
          label = (matchingLabel as HTMLElement).innerText || "";
        }
      }
      
      // Attempt 2: wrapping label
      if (!label && el.closest("label")) {
        label = (el.closest("label") as HTMLElement).innerText || "";
      }
      
      // Attempt 3: aria-label
      if (!label) {
        label = el.getAttribute("aria-label") || "";
      }

      // Cleanup label
      label = label.replace(/\s+/g, " ").trim();

      const field: FormField = {
        id,
        tagName,
        type,
        name: el.getAttribute("name") || "",
        placeholder: el.getAttribute("placeholder") || "",
        label,
        required: (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true",
      };

      if (tagName === "select") {
        const options = Array.from(el.querySelectorAll("option")).map(o => o.innerText.trim());
        field.options = options.filter(o => o);
      }

      fields.push(field);
    }

    return fields;
  });
}
