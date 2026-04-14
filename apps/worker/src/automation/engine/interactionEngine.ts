import { type Page } from "playwright-core";
import { logger } from "../browser/logger.js";
import os from "node:os";

// ─────────────────────────────────────────────────────────────
// GLOBALS & STATE
// ─────────────────────────────────────────────────────────────

let isPaused = false;
let currentMousePos = { x: 0, y: 0 };
let actionsCount = 0;

export function pause() {
  logger.warn("interaction.paused");
  isPaused = true;
}

export function resume() {
  logger.info("interaction.resumed");
  isPaused = false;
}

async function checkPause() {
  while (isPaused) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─────────────────────────────────────────────────────────────
// RANDOMIZATION (Simplified)
// ─────────────────────────────────────────────────────────────

export function random(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function randomDelay(min: number, max: number): Promise<void> {
  await checkPause();
  const ms = random(min, max);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// MACRO SESSION BREAKS
// ─────────────────────────────────────────────────────────────

async function executeMacroWait() {
  actionsCount++;
  if (actionsCount >= random(3, 4)) {
    actionsCount = 0;
    const pauseDuration = random(1500, 3000);
    logger.info("interaction.macro_pause", { duration: pauseDuration });
    await randomDelay(pauseDuration, pauseDuration + 500);
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE VALIDATION
// ─────────────────────────────────────────────────────────────

export async function validatePage(page: Page, expectedDomain: string): Promise<boolean> {
  const url = page.url();
  if (!url.includes(expectedDomain)) {
    logger.warn("interaction.context_mismatch", { expected: expectedDomain, actual: url });
    pause();
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// SCROLLING (Minimal)
// ─────────────────────────────────────────────────────────────

export async function humanScroll(page: Page): Promise<void> {
  await checkPause();
  logger.info("action.scroll");

  const passes = random(2, 5);
  for (let i = 0; i < passes; i++) {
    const scrollAmount = random(150, 400);
    const direction = Math.random() > 0.9 ? -1 : 1; 

    await page.mouse.wheel(0, scrollAmount * direction);
    await randomDelay(100, 300);

    // Occasional overscroll correction
    if (Math.random() < 0.1) {
      await page.mouse.wheel(0, -(scrollAmount * 0.3 * direction));
      await randomDelay(150, 300);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// ELEMENT VISIBILITY
// ─────────────────────────────────────────────────────────────

export async function ensureVisible(page: Page, selector: string) {
  let box = await page.locator(selector).boundingBox();
  let retries = 0;

  while (!box && retries < 2) {
    await humanScroll(page);
    await randomDelay(300, 600);
    box = await page.locator(selector).boundingBox();
    retries++;
  }

  if (!box) {
    throw new Error(`Selector not visible: ${selector}`);
  }

  const viewport = page.viewportSize();
  if (viewport && (box.y < 0 || box.y > viewport.height)) {
    // Scroll element near center
    const yTarget = box.y - (viewport.height / 2); 
    await page.mouse.wheel(0, yTarget);
    await randomDelay(400, 800);
    box = await page.locator(selector).boundingBox();
  }

  return box!;
}

// ─────────────────────────────────────────────────────────────
// HUMAN MOUSE MOVEMENT (Linear + Jitter)
// ─────────────────────────────────────────────────────────────

export async function humanMoveMouse(page: Page, targetX: number, targetY: number) {
  await checkPause();
  
  if (currentMousePos.x === 0 && currentMousePos.y === 0) {
    const vp = page.viewportSize();
    currentMousePos = { x: (vp?.width || 1200) / 2, y: (vp?.height || 800) / 2 };
  }

  const startX = currentMousePos.x;
  const startY = currentMousePos.y;

  const steps = random(10, 20); // Keep it performant

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Linear interpolation
    let currentX = startX + (targetX - startX) * t;
    let currentY = startY + (targetY - startY) * t;

    // Slight noise
    currentX += random(-2, 2);
    currentY += random(-2, 2);

    await page.mouse.move(currentX, currentY);
    await randomDelay(2, 10);
  }

  currentMousePos = { x: targetX, y: targetY };
}

// ─────────────────────────────────────────────────────────────
// HUMAN CLICK
// ─────────────────────────────────────────────────────────────

export async function humanClick(page: Page, selector: string): Promise<void> {
  await checkPause();
  logger.info("action.click", { selector });

  async function performClick() {
    const box = await ensureVisible(page, selector);
    
    // Add ±10-20px offset from exact center cleanly
    const offsetX = random(-20, 20);
    const offsetY = random(-20, 20);
    const targetX = box.x + (box.width / 2) + offsetX;
    const targetY = box.y + (box.height / 2) + offsetY;

    await humanMoveMouse(page, targetX, targetY);
    
    // Small hesitation before clicking
    await randomDelay(300, 800);

    // Optional 5% micro-correction
    if (Math.random() < 0.05) {
       await page.mouse.move(targetX + random(-5, 5), targetY + random(-5, 5));
       await randomDelay(100, 200);
    }
    
    await page.mouse.down();
    await randomDelay(50, 150);
    await page.mouse.up();
  }

  try {
    await performClick();
  } catch (err: any) {
    logger.warn("interaction.click.retry", { selector });
    // Simple 1-time fallback retry
    await randomDelay(300, 800);
    try {
      await performClick();
    } catch {
      // Fallback natively 
      await page.locator(selector).click({ delay: random(50, 150) }).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────
// HUMAN TYPE
// ─────────────────────────────────────────────────────────────

export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await checkPause();
  logger.info("action.type", { length: text.length, selector });

  await humanClick(page, selector);
  
  // Thinking delay before long text
  if (text.length > 5) {
     await randomDelay(800, 2000);
  }

  const isMac = os.platform() === "darwin";
  const modifier = isMac ? "Meta" : "Control";
  
  await page.keyboard.down(modifier);
  await page.keyboard.press("a");
  await page.keyboard.up(modifier);
  await randomDelay(100, 200);
  await page.keyboard.press("Backspace");
  await randomDelay(150, 300);

  for (let i = 0; i < text.length; i++) {
    await checkPause();
    
    const char = text[i];
    let delay = random(40, 80);

    if (char === " " || char === "." || char === ",") {
      delay += random(100, 200);
    }

    if (i > 0 && i % random(5, 10) === 0) {
      delay += random(200, 400); // 5-10 char periodic burst pause
    }

    await page.keyboard.type(char, { delay });
  }

  await randomDelay(200, 500);
}

// ─────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────

export interface InteractionAction {
  type: "click" | "type" | "read";
  selector: string;
  value?: string;
  expectedDomain?: string;
}

export async function interact(page: Page, action: InteractionAction) {
  if (action.expectedDomain) {
    const isValid = await validatePage(page, action.expectedDomain);
    if (!isValid) await checkPause(); 
  }

  // Before action logic (mandatory breather: pause -> move -> action)
  await randomDelay(300, 800);

  if (action.type === "read") {
    const readDelay = random(1500, 3500);
    logger.info("action.read", { delay: readDelay });
    await randomDelay(readDelay, readDelay + 500);
  } else if (action.type === "click") {
    await humanClick(page, action.selector);
  } else if (action.type === "type" && action.value !== undefined) {
    await humanType(page, action.selector, action.value);
  }

  // After action sequence
  await executeMacroWait();
}
