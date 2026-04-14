import { type Page } from "playwright-core";
import { type FormField, type FieldType } from "./types.js";
import { resolveLabel, resolveRequired } from "./labelResolver.js";
import { logger } from "../browser/logger.js";

export async function detectFields(page: Page): Promise<FormField[]> {
  logger.info("formDetector.scan.started");

  const hasForm = await page.$("form");
  const scope = hasForm ? page.locator("form").first() : page.locator("body");

  // Explicitly avoid relying on playwright CSS `:visible` pseudo-class for safety
  // Removed hidden/password inherently from locator search. We manually verify later.
  const locators = scope.locator(
    `input:not([type="hidden"]):not([type="password"]), textarea, select`
  );

  const fields: FormField[] = [];
  const count = await locators.count();
  const handledLocators = new Set<string>();

  for (let i = 0; i < count; i++) {
    const el = locators.nth(i);
    const elementHandle = await el.elementHandle();
    if (!elementHandle) continue;

    // Hard explicit state checks natively cleanly stably 
    if (!(await el.isVisible())) continue;
    if (!(await el.isEnabled())) continue;

    const inputType = await elementHandle.getAttribute("type");
    if (inputType === "password" || inputType === "hidden") continue;

    const isDisabledAttr = await elementHandle.getAttribute("disabled");
    if (isDisabledAttr !== null) continue;

    const label = await resolveLabel(page, elementHandle);
    if (!label || label.length === 0) continue;

    const tagName = await elementHandle.evaluate((e: any) => e.tagName.toLowerCase());
    const nameAtt = await elementHandle.getAttribute("name");

    let fieldType: FieldType = "text";
    if (tagName === "textarea") fieldType = "textarea";
    else if (tagName === "select") fieldType = "select";
    else if (inputType === "radio") fieldType = "radio";
    else if (inputType === "checkbox") fieldType = "checkbox";
    else if (inputType === "file") fieldType = "file";

    const required = await resolveRequired(page, elementHandle, label);

    let options: string[] = [];
    if (fieldType === "select") {
       options = await elementHandle.evaluate((sel: any) => {
         return Array.from(sel.querySelectorAll("option"))
           .map((opt: any) => opt.textContent ? opt.textContent.trim() : "")
           .filter(Boolean);
       });
    } else if (fieldType === "radio" || fieldType === "checkbox") {
       const val = await elementHandle.getAttribute("value");
       if (val) options = [val];
    }

    const selector = await buildRobustSelector(elementHandle);
    if (!selector || handledLocators.has(selector)) continue;
    handledLocators.add(selector);

    const formField: FormField = {
      selector,
      label,
      type: fieldType,
      required,
      options: options.length > 0 ? options : undefined,
      name: nameAtt || undefined
    };

    logger.info("field.detected", { label: formField.label, type: formField.type });
    fields.push(formField);
  }

  return groupRadioFields(fields);
}

async function buildRobustSelector(el: any): Promise<string> {
  return await el.evaluate((element: any) => {
    if (element.id) return `#${element.id}`;
    if (element.name) return `[name="${element.name}"]`;
    if (element.placeholder) return `[placeholder="${element.placeholder}"]`;
    
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute("type");
    if (type) {
       return `${tag}[type="${type}"]`;
    }
    return tag;
  });
}

function groupRadioFields(fields: FormField[]): FormField[] {
  const merged: FormField[] = [];
  const radioGroups = new Map<string, FormField>();

  for (const field of fields) {
    if (field.type === "radio" && field.name) {
      if (radioGroups.has(field.name)) {
         const existing = radioGroups.get(field.name)!;
         if (field.options && field.options[0]) {
             existing.options = existing.options || [];
             existing.options.push(field.options[0]);
         }
      } else {
         radioGroups.set(field.name, field);
         merged.push(field);
      }
    } else {
      merged.push(field);
    }
  }

  return merged;
}
