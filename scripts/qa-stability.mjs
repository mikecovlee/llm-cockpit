// Layout-stability soak: the page must not grow (or shrink) while polling.
// Guards against flex/ResizeObserver feedback loops (canvas px written back
// into content height). Fails (exit 1) on any drift beyond tolerance.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1.5 },
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 150)));
await page.goto("http://127.0.0.1:7777", { waitUntil: "load" });
await page.waitForTimeout(4000);

const probe = () =>
  page.evaluate(() => {
    const wrap = document.querySelector(".wrap");
    const on = document.querySelector(".nav button.on");
    return {
      tab: on === null ? "?" : (on.textContent ?? "?"),
      vw: window.innerWidth,
      doc: document.documentElement.scrollHeight,
      body: document.body.scrollHeight,
      wrapH: wrap === null ? -1 : Math.round(wrap.getBoundingClientRect().height),
      nodes: document.getElementsByTagName("*").length,
    };
  });

const marks = [await probe()];
for (let round = 0; round < 12; round++) {
  if (round === 4) {
    await page.click('nav button:has-text("chat")');
  }
  if (round === 6) {
    await page.click('nav button:has-text("monitor")');
  }
  if (round === 8) {
    await page.setViewportSize({ width: 1100, height: 750 });
  }
  if (round === 10) {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  await page.waitForTimeout(8000);
  marks.push(await probe());
}
await browser.close();

const base = marks[0];
const groups = new Map();
for (const m of marks) {
  const key = `${m.vw}:${m.tab}`;
  const g = groups.get(key) ?? [];
  g.push(m);
  groups.set(key, g);
}
let drift = 0;
for (const g of groups.values()) {
  for (const m of g) {
    drift = Math.max(
      drift,
      Math.abs(m.doc - g[0].doc),
      Math.abs(m.body - g[0].body),
      Math.abs(m.wrapH - g[0].wrapH),
    );
  }
}
const growth = marks[marks.length - 1].doc - base.doc;
const nodeGrowth = marks[marks.length - 1].nodes - base.nodes;
console.log(
  JSON.stringify(
    {
      samples: marks.length,
      base,
      last: marks[marks.length - 1],
      drift_px: drift,
      growth_px: growth,
      node_growth: nodeGrowth,
      errors,
    },
    null,
    2,
  ),
);
if (drift > 4 || nodeGrowth > 10 || errors.length > 0) {
  console.error("STABILITY FAIL");
  process.exit(1);
}
console.log("STABILITY OK");
