import { BrowserSessionManager } from "../browser/browserSessionManager.js";
import { detectFields } from "./formDetector.js";
import { mapFieldsToAnswers } from "./formMapper.js";
import { fillFormFields } from "./formFiller.js";
import { logger } from "../browser/logger.js";

async function run() {
  logger.info("testFormFlow.started");
  
  const manager = new BrowserSessionManager();

  try {
    await manager.connect();

    // Wikipedia doesn't have a good robust form. 
    // We'll target an open example form safely gracefully natively.
    const targetUrl = "https://httpbin.org/forms/post";
    const page = await manager.getPage(targetUrl);

    if (!page.url().includes("httpbin.org")) {
       logger.info("testFormFlow.navigating", { url: targetUrl });
       await page.goto(targetUrl, { waitUntil: "networkidle" });
    }

    logger.info("testFormFlow.page_ready");

    // 1. Detect Fields
    const fields = await detectFields(page);
    logger.info("testFormFlow.detected", { count: fields.length });

    // 2. Map Answers
    const dummyAnswers = {
       "Customer name": "Jane Doe",
       "telephone": "555-0199",
       "E-mail address": "jane@example.com",
       "Pizza Size": "large",
       "Pizza Toppings": "mushroom", // Target a checkbox/radio logically organically
       "Delivery time": "18:30"
    };

    const mapped = mapFieldsToAnswers(fields, dummyAnswers);

    // 3. Fill Form explicitly natively
    await fillFormFields(page, mapped, "httpbin.org");

    logger.info("testFormFlow.completed_successfully");

    await manager.disconnect();
    process.exit(0);
  } catch (err: any) {
    logger.error("testFormFlow.fatal", { error: err.message });
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
