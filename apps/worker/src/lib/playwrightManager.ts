import { chromium, type BrowserContext } from "playwright";

const contextStore = new Map<string, BrowserContext>();

export class PlaywrightManager {
  async getPersistentContext(userId: string): Promise<BrowserContext> {
    const existing = contextStore.get(userId);
    if (existing) {
      return existing;
    }

    const context = await chromium.launchPersistentContext(`./.sessions/${userId}`, {
      headless: process.env.PLAYWRIGHT_HEADLESS === "true",
      viewport: { width: 1440, height: 900 }
    });

    contextStore.set(userId, context);
    return context;
  }

  async closeContext(userId: string): Promise<void> {
    const context = contextStore.get(userId);
    if (!context) return;
    await context.close();
    contextStore.delete(userId);
  }
}
