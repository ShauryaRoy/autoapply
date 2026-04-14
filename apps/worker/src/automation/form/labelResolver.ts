import { type ElementHandle, type Page } from "playwright-core";

export async function resolveLabel(page: Page, el: ElementHandle): Promise<string> {
  let result = await page.evaluate((element: any) => {
    const rawClean = (str: string | null | undefined) => {
      if (!str) return "";
      return str;
    };

    if (element.id) {
      const explicitLabel = document.querySelector(`label[for="${element.id}"]`);
      if (explicitLabel && explicitLabel.textContent) {
        return rawClean(explicitLabel.textContent);
      }
    }

    const parentLabel = element.closest("label");
    if (parentLabel) {
      const textNodes = Array.from(parentLabel.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" ");
      if (textNodes.trim().length > 1) return rawClean(textNodes);
      if (parentLabel.textContent) return rawClean(parentLabel.textContent);
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return rawClean(ariaLabel);

    const ariaLabelledBy = element.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      const targetLabel = document.getElementById(ariaLabelledBy);
      if (targetLabel && targetLabel.textContent) {
        return rawClean(targetLabel.textContent);
      }
    }

    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return rawClean(placeholder);

    const nameAtt = element.getAttribute("name");
    if (nameAtt) return rawClean(nameAtt);

    return "";
  }, el);

  // Normalize securely mapping strict deterministic constraints
  result = result
    .toLowerCase()
    .replace(/[*:]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return result;
}

export async function resolveRequired(page: Page, el: ElementHandle, rawLabel: string): Promise<boolean> {
  const isAttrRequired = await page.evaluate((element: any) => {
    return (
      element.hasAttribute("required") || 
      element.getAttribute("aria-required") === "true"
    );
  }, el);

  if (isAttrRequired) return true;

  // The label might be normalized cleanly above, but if asterisk exists we check original raw string upstream 
  // For safety, assume any generic explicit requirement marker evaluates.
  // We'll trust attributes predominantly now since we scrubbed asterisks inherently.
  return false;
}
