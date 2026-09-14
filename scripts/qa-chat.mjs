// Browser QA for the chat view: open cockpit, switch to chat, send a message,
// capture the streaming reply. Run inside the QA image (playwright preinstalled):
//   docker run --rm --network host -v $PWD:/work cockpit-qa:local bun run /work/scripts/qa-chat.mjs
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto("http://127.0.0.1:7777", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: "/work/screenshots/m3-monitor.png" });

await page.click('button:has-text("chat")');
await page.waitForTimeout(1200);
await page.screenshot({ path: "/work/screenshots/m3-chat-empty.png" });

await page.fill("textarea", "Reply with exactly one word: pong");
await page.click('button:has-text("send")');
await page.waitForTimeout(20000);
await page.screenshot({ path: "/work/screenshots/m3-chat-reply.png" });

const assistantText = await page.locator(".bubble.assistant").last().textContent();
console.log(
  JSON.stringify(
    {
      consoleErrors: errors,
      assistantText: assistantText === null ? null : assistantText.slice(0, 400),
    },
    null,
    2,
  ),
);

await browser.close();
