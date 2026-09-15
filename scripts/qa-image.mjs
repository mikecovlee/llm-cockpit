// Browser QA: attach an image in chat, ask about its content, verify the model
// actually processed the image (not a text-only hallucination).
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1750 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto("http://127.0.0.1:7777", { waitUntil: "load" });
await page.click('nav button:has-text("chat")');
await page.waitForTimeout(1500);

// attach the monitor screenshot (a metrics dashboard with charts)
await page.setInputFiles("input[type=file]", "/work/screenshots/m2-monitor.png");
await page.waitForTimeout(1000);
const thumbCount = await page.locator(".chat-input .thumbs .thumb").count();

await page.fill(
  ".chat-input textarea",
  "What kind of dashboard is shown in this image? One short sentence.",
);
await page.click(".chat-input button:has-text('send')");

const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const stopped = await page.locator(".chat-input .stop").count();
  if (stopped === 0) break;
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(2000);

const userThumbInBubble = await page.locator(".bubble.user .thumbs .thumb").count();
const assistantText = await page.locator(".bubble.assistant").last().textContent();

await page.screenshot({ path: "/work/screenshots/m5-image-chat.png" });
await browser.close();
console.log(
  JSON.stringify(
    {
      consoleErrors: errors,
      pendingThumbs: thumbCount,
      userBubbleThumbs: userThumbInBubble,
      assistantText: assistantText === null ? null : assistantText.slice(0, 400),
    },
    null,
    2,
  ),
);
