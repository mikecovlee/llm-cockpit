import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1750 } });
await page.goto("http://127.0.0.1:7777", { waitUntil: "load" });
await page.click('nav button:has-text("chat")');
await page.waitForTimeout(1500);
await page.setInputFiles('input[type=file]', "/work/screenshots/m2-monitor.png");
await page.waitForTimeout(1000);
const pending = await page.evaluate(() => {
  const img = document.querySelector(".chat-input .thumbs .thumb");
  if (img === null) return { exists: false };
  const r = img.getBoundingClientRect();
  const cs = getComputedStyle(img);
  return { exists: true, w: r.width, h: r.height, display: cs.display, vis: cs.visibility, op: cs.opacity, naturalWidth: img.naturalWidth, complete: img.complete, srcLen: img.src.length };
});
await page.fill(".chat-input textarea", "ok");
await page.click(".chat-input button:has-text('send')");
await page.waitForTimeout(8000);
const inBubble = await page.evaluate(() => {
  const img = document.querySelector(".bubble.user .thumbs .thumb");
  if (img === null) return { exists: false };
  const r = img.getBoundingClientRect();
  const cs = getComputedStyle(img);
  const thumbs = img.parentElement;
  const tcs = thumbs === null ? null : getComputedStyle(thumbs);
  return {
    exists: true, w: r.width, h: r.height, top: r.top,
    display: cs.display, vis: cs.visibility, op: cs.opacity,
    objectFit: cs.objectFit,
    naturalWidth: img.naturalWidth, complete: img.complete,
    srcPrefix: img.src.slice(0, 30),
    thumbsDisplay: tcs === null ? null : tcs.display,
    thumbsH: thumbs === null ? null : thumbs.getBoundingClientRect().height,
  };
});
await page.screenshot({ path: "/tmp/probe-chat.png", clip: { x: 0, y: 0, width: 1440, height: 900 } });
await browser.close();
console.log(JSON.stringify({ pending, inBubble }, null, 2));
