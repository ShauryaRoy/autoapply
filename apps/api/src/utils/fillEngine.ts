/**
 * fillEngine.ts
 *
 * Executes Playwright instructions to fill the form safely.
 */

import type { Page } from "playwright";
import type { MappedField } from "./fieldMapper.js";

export async function fillForm(page: Page, mappedFields: MappedField[]): Promise<string[]> {
  const logs: string[] = [];

  for (const mapping of mappedFields) {
    if (mapping.action === "skip") {
      logs.push(`[ACTION: skip] [FIELD: ${mapping.field.name || mapping.field.label}] [RESULT: skipped] — No mapped data`);
      continue;
    }

    // Build the safest selector
    let selector = "";
    if (mapping.field.id) {
      selector = `#${mapping.field.id}`;
    } else if (mapping.field.name) {
      selector = `[name="${mapping.field.name}"]`;
    } else {
      logs.push(`[ACTION: ${mapping.action}] [FIELD: ${mapping.field.label}] [RESULT: failed] — No safe selector`);
      continue;
    }

    // Anti-bot brief random delay
    await page.waitForTimeout(Math.floor(Math.random() * 200) + 100);

    let success = false;
    let lastErr = "";
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const el = page.locator(selector).first();
        await el.waitFor({ state: "visible", timeout: 3000 });

        if (mapping.action === "upload") {
          await el.setInputFiles(mapping.value);
          logs.push(`[ACTION: upload] [FIELD: ${mapping.field.label}] [RESULT: success]`);
          success = true;
          break;
        } 
        else if (mapping.action === "type") {
          // Anti-bot: clear then type iteratively
          await el.clear();
          // Use type instead of fill for anti-bot realism
          await el.type(mapping.value, { delay: 20 });
          // Verify
          const setVal = await el.inputValue().catch(() => "");
          if (setVal.trim().length === 0 && mapping.value.trim().length > 0) {
             throw new Error("Value not set");
          }
          logs.push(`[ACTION: type] [FIELD: ${mapping.field.label}] [RESULT: success]`);
          success = true;
          break;
        }
        else if (mapping.action === "select") {
          const isSelected = await el.selectOption({ label: mapping.value }, { timeout: 2000 }).catch(() => null);
          if (isSelected && isSelected.length > 0) {
            logs.push(`[ACTION: select] [FIELD: ${mapping.field.label}] [RESULT: success]`);
            success = true;
            break;
          } else {
             throw new Error(`Option "${mapping.value}" not found or selectable`);
          }
        }
      } catch (err: any) {
        lastErr = err.message.split('\n')[0];
        // Wait slightly before retry
        await page.waitForTimeout(500);
      }
    }

    if (!success) {
      logs.push(`[ACTION: ${mapping.action}] [FIELD: ${mapping.field.label}] [RESULT: failed] — ${lastErr}`);
    }
  }

  return logs;
}
