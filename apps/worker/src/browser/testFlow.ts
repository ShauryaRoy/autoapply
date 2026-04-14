import { BrowserSessionManager } from "./browserSessionManager.js";

async function testFlow() {
  console.log("Starting Browser Automation Core Test Flow...");

  const sessionManager = new BrowserSessionManager({
    port: 9222,
    // preferredBrowser: 'chrome'
  });

  try {
    // 1. Open/Connect to browser
    console.log("Connecting to browser session...");
    await sessionManager.connect();

    // 2. Obtain a page context
    console.log("Obtaining page instance...");
    const page = await sessionManager.getPage(true); // Open a new tab for testing

    // 3. Navigate to example.com
    console.log("Navigating to https://example.com ...");
    await page.goto("https://example.com");
    console.log("Page loaded. Title:", await page.title());

    // 4. Click a link
    console.log("Clicking 'More information...' link...");
    await page.click("text=More information...");
    
    // Wait for navigation
    await page.waitForLoadState("networkidle");
    console.log("Navigation successful. New Title:", await page.title());

    console.log("Test flow completed successfully.");

    // Leave the browser running (as it is a real user session), just disconnect the debugger
    await sessionManager.disconnect();
    
  } catch (error) {
    console.error("Test flow failed:", error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testFlow();
}
