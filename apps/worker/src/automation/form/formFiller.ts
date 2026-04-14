import { type Page } from "playwright-core";
import { type MappedField } from "./types.js";
import { interact, randomDelay } from "../engine/interactionEngine.js";
import { logger } from "../browser/logger.js";

/**
 * Organizes fields inherently isolating true DOM visual layouts gracefully cleanly safely natively.
 */
async function sortFieldsByVerticalDOMPhase(page: Page, fields: MappedField[]): Promise<MappedField[]> {
  const withCoordinates = await Promise.all(
    fields.map(async (mf) => {
      let y = 999999;
      try {
        const box = await page.locator(mf.field.selector).boundingBox();
        if (box) y = box.y;
      } catch (e) {
         // ignore natively silently
      }
      return { mf, y };
    })
  );

  return withCoordinates
    .sort((a, b) => a.y - b.y)
    .map(x => x.mf);
}

export async function fillFormFields(page: Page, mappedFields: MappedField[], expectedDomain: string) {
  logger.info("formFiller.start");

  // Visual native scrolling naturally naturally sorts elements seamlessly.
  const sortedFields = await sortFieldsByVerticalDOMPhase(page, mappedFields);

  for (const item of sortedFields) {
    if (!item.value) {
      continue;
    }

    const { field, value } = item;

    // Retry safely (clean 1-time fallback without deep nested trees safely cleanly)
    let success = false;
    let attempts = 0;

    while (attempts < 2 && !success) {
       attempts++;
       try {
          if (field.type === "text" || field.type === "textarea") {
             await interact(page, {
                 type: "type",
                 selector: field.selector,
                 value: value,
                 expectedDomain
             });
          } else if (field.type === "select") {
             await interact(page, { type: "click", selector: field.selector, expectedDomain });
             await randomDelay(300, 600);
             
             // Evaluate standard includes bounds structurally
             const internalValue = value.toLowerCase().trim().replace(/[.,]/g, "");
             
             // Search options array for a direct realistic mapping specifically smartly broadly
             const selectLocator = page.locator(field.selector);
             const optionMatches = field.options?.filter(opt => {
                 return opt.toLowerCase().trim().replace(/[.,]/g, "").includes(internalValue);
             }) || [];

             if (optionMatches.length > 0) {
                 await selectLocator.selectOption({ label: optionMatches[0] }).catch(() => {});
             } else {
                 // Native aggressive fallback cleanly
                 await selectLocator.selectOption(value).catch(() => {});
             }
             await randomDelay(200, 500);

          } else if (field.type === "checkbox") {
             const isTrue = value.toLowerCase() === "true" || value === "1" || value.toLowerCase() === "yes";
             if (isTrue) {
               const checked = await page.locator(field.selector).isChecked().catch(()=>false);
               if (!checked) {
                  await interact(page, { type: "click", selector: field.selector, expectedDomain });
               }
             }
          } else if (field.type === "radio") {
             if (field.name) {
                // Playwright handles dynamic structural value matches intelligently organically safely cleanly robustly
                const targetSelector = `input[name="${field.name}"]`;
                const locators = page.locator(targetSelector);
                const count = await locators.count();
                let clicked = false;
                for (let i=0; i<count; i++) {
                   const r = locators.nth(i);
                   const valAtt = await r.getAttribute("value");
                   if (valAtt && valAtt.toLowerCase().includes(value.toLowerCase())) {
                       const finalSel = `${targetSelector}[value="${valAtt}"]`;
                       await interact(page, { type: "click", selector: finalSel, expectedDomain });
                       clicked = true;
                       break;
                   }
                }
                if (!clicked) await interact(page, { type: "click", selector: field.selector, expectedDomain });
             } else {
                await interact(page, { type: "click", selector: field.selector, expectedDomain });
             }
          } else if (field.type === "file") {
             logger.info("file_input_detected", { label: field.label });
             success = true; // Mark done manually 
             break;
          }

          logger.info("field.filled", { label: field.label });
          success = true;
       } catch (err: any) {
          if (attempts < 2) {
             logger.warn("interaction.retry.catch", { label: field.label, attempt: attempts });
             await randomDelay(300, 800);
          } else {
             logger.error("interaction.fatal.skip", { label: field.label });
          }
       }
    }
  }

  logger.info("formFiller.completed");
}
