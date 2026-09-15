// Matrix QA for theme + language prefs: {dark,light} x {en,zh} x {1150,1440}.
// Asserts pre-paint attrs, localized labels, WCAG contrast, sticky-header gap,
// toggle clicks, and absence of raw "undefined" render leaks. Evidence PNGs go
// to /work/screenshots/qa-theme/.
//   docker run --rm --network host -v $PWD:/work cockpit-qa:local bun run /work/scripts/qa-theme.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

mkdirSync("/work/screenshots/qa-theme", { recursive: true });

const contrastEval = `
  (() => {
    const parse = (s) => s.match(/[0-9.]+/g).slice(0, 3).map(Number);
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (fg, bg) => {
      const [l1, l2] = [lum(parse(fg)), lum(parse(bg))].sort((a, b) => b - a);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const cs = (el) => getComputedStyle(el);
    return {
      body: ratio(cs(document.body).color, cs(document.body).backgroundColor),
      cardTitle: ratio(cs(document.querySelector(".card-title")).color, cs(document.querySelector(".card")).backgroundColor),
      statValue: ratio(cs(document.querySelector(".stat-value")).color, cs(document.querySelector(".card")).backgroundColor),
      rowText: ratio(cs(document.querySelector(".row")).color, cs(document.querySelector(".card")).backgroundColor),
    };
  })()
`;

const browser = await chromium.launch();
const failures = [];
const consoleErrors = [];

const check = (name, cond, detail) => {
  if (!cond) failures.push(`${name}: ${JSON.stringify(detail)}`);
};

for (const theme of ["dark", "light"]) {
  for (const lang of ["en", "zh"]) {
    for (const width of [1150, 1440]) {
      const tag = `${theme}-${lang}-${width}`;
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (e) => consoleErrors.push(`${tag}: ${String(e)}`));
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(`${tag}: ${m.text()}`);
      });
      try {
        await page.addInitScript(
          ([t, l]) =>
            localStorage.setItem("llm-cockpit.prefs.v1", JSON.stringify({ theme: t, lang: l })),
          [theme, lang],
        );
        await page.goto("http://127.0.0.1:7777", { waitUntil: "networkidle" });
        await page.waitForSelector(".card-title", { timeout: 15000 });
        await page.waitForTimeout(2600);

        const a = await page.evaluate(() => ({
          themeAttr: document.documentElement.getAttribute("data-theme"),
          langAttr: document.documentElement.lang,
          firstTitle: document.querySelector(".card-title")?.textContent?.trim(),
          navSecond: document.querySelectorAll(".nav button")[1]?.textContent?.trim(),
          hdrBottom: document.querySelector(".hdr").getBoundingClientRect().bottom,
          gridTop: document.querySelector(".grid4").getBoundingClientRect().top,
          hasUndefined: document.body.innerText.includes("undefined"),
          overflowX:
            document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }));
        check(`${tag} data-theme`, a.themeAttr === theme, a.themeAttr);
        check(`${tag} html lang`, a.langAttr === lang, a.langAttr);
        check(
          `${tag} first title`,
          a.firstTitle === (lang === "zh" ? "请求" : "requests"),
          a.firstTitle,
        );
        check(`${tag} nav label`, a.navSecond === (lang === "zh" ? "对话" : "chat"), a.navSecond);
        check(
          `${tag} header gap >= 12px`,
          a.gridTop - a.hdrBottom >= 11.5,
          a.gridTop - a.hdrBottom,
        );
        check(`${tag} no undefined leak`, !a.hasUndefined, true);
        check(`${tag} no h-overflow`, !a.overflowX, true);

        const cr = await page.evaluate(contrastEval);
        for (const [k, v] of Object.entries(cr)) {
          check(`${tag} contrast ${k} >= 4.5`, v >= 4.5, Number(v.toFixed(2)));
        }

        await page.screenshot({ path: `/work/screenshots/qa-theme/${tag}-monitor.png` });

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
        const scrolled = await page.evaluate(() => ({
          top: document.querySelector(".hdr").getBoundingClientRect().top,
        }));
        check(`${tag} sticky top while scrolled`, scrolled.top >= -0.5, scrolled.top);
        await page.screenshot({ path: `/work/screenshots/qa-theme/${tag}-scrolled.png` });
        await page.evaluate(() => window.scrollTo(0, 0));

        const flips = page.locator("button.icon-btn");
        await flips.nth(0).click();
        await flips.nth(1).click();
        await page.waitForTimeout(500);
        const flipped = await page.evaluate(() => ({
          theme: document.documentElement.getAttribute("data-theme"),
          title: document.querySelector(".card-title")?.textContent?.trim(),
          saved: JSON.parse(localStorage.getItem("llm-cockpit.prefs.v1") || "null"),
        }));
        check(
          `${tag} toggle flip theme`,
          flipped.theme === (theme === "dark" ? "light" : "dark"),
          flipped.theme,
        );
        check(
          `${tag} toggle flip labels`,
          flipped.title === (lang === "zh" ? "requests" : "请求"),
          flipped.title,
        );
        check(
          `${tag} toggle persists prefs`,
          flipped.saved?.theme === flipped.theme &&
            flipped.saved?.lang === (lang === "zh" ? "en" : "zh"),
          flipped.saved,
        );
        await page.screenshot({ path: `/work/screenshots/qa-theme/${tag}-flipped.png` });
      } catch (e) {
        failures.push(`${tag}: EXCEPTION ${String(e)}`);
      } finally {
        await page.close();
      }
    }
  }
}

await browser.close();
console.log(JSON.stringify({ fail: failures.length, failures, consoleErrors }, null, 2));
process.exit(failures.length === 0 && consoleErrors.length === 0 ? 0 : 1);
