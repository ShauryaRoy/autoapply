import { BrowserSessionManager } from "./browserSessionManager.js";
import { logger } from "./logger.js";

async function run() {
  logger.info("testFlow.started");
  
  const manager = new BrowserSessionManager();

  try {
    await manager.connect();

    const targetUrl = "https://example.com";
    const page = await manager.getPage(targetUrl);

    if (!page.url().includes("example.com")) {
      logger.info("testFlow.navigating", { url: targetUrl });
      await page.goto(targetUrl, { waitUntil: "networkidle" });
    }

    logger.info("testFlow.page_ready", { title: await page.title() });

    const linkLocator = page.locator("text=More information");
    if ((await linkLocator.count()) > 0) {
       await linkLocator.first().click();
       await page.waitForLoadState("networkidle");
       logger.info("testFlow.click.success", { currentUrl: page.url() });
    } else {
       logger.warn("testFlow.click.failed", { reason: "Link not found" });
    }

    await manager.disconnect();
    logger.info("testFlow.completed");
    process.exit(0);

  } catch (e: any) {
    if (e.type && e.message) {
       // Typed BrowserError mapping
       logger.error(`testFlow.fatal.${e.type.toLowerCase()}`, { message: e.message });
    } else {
       logger.error("testFlow.fatal.unknown", { message: e.message });
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
