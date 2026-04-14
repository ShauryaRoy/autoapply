import { BrowserSessionManager } from "../browser/browserSessionManager.js";
import { interact, humanScroll, pause, resume } from "./interactionEngine.js";
import { logger } from "../browser/logger.js";

async function run() {
  logger.info("testInteraction.started");

  const manager = new BrowserSessionManager();
  
  try {
    await manager.connect();

    const targetUrl = "https://en.wikipedia.org";
    const page = await manager.getPage(targetUrl);

    if (!page.url().includes("wikipedia.org")) {
      logger.info("testInteraction.navigating", { url: targetUrl });
      await page.goto(targetUrl, { waitUntil: "networkidle" });
    }

    logger.info("testInteraction.page_ready", { title: await page.title() });

    await humanScroll(page);

    await interact(page, {
      type: "type",
      selector: "input[name='search']",
      value: "Browser Automation",
      expectedDomain: "wikipedia.org"
    });

    pause();
    setTimeout(() => resume(), 2000);

    await interact(page, {
      type: "click",
      selector: "button:has-text('Search')",
      expectedDomain: "wikipedia.org"
    });

    await page.waitForLoadState("networkidle");
    logger.info("testInteraction.completed", { currentUrl: page.url() });

    await manager.disconnect();
    process.exit(0);
  } catch (error: any) {
    logger.error("testInteraction.fatal", { error: error.message });
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
