// Bundle the server (target bun, zero runtime deps) and the web app (browser).

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { build } from "bun";

mkdirSync("dist", { recursive: true });

const server = await build({
  entrypoints: ["src/server.ts"],
  outdir: "dist",
  target: "bun",
  minify: true,
});

if (existsSync("web/main.tsx")) {
  const web = await build({
    entrypoints: ["web/main.tsx"],
    outdir: "dist/web",
    target: "browser",
    minify: true,
  });
  if (!web.success) {
    console.error("web build failed");
    process.exit(1);
  }
  const js = readFileSync("dist/web/main.js");
  const hash = createHash("sha256").update(js).digest("hex").slice(0, 10);
  const asset = `main-${hash}.js`;
  writeFileSync(`dist/web/${asset}`, js);
  for (const f of readdirSync("dist/web")) {
    if (/^(main\.js|main-[0-9a-f]+\.js)$/.test(f) && f !== asset) {
      unlinkSync(`dist/web/${f}`);
    }
  }
  const html = readFileSync("web/index.html", "utf8").replace("/web/main.js", `/web/${asset}`);
  writeFileSync("dist/web/index.html", html);
}

if (!server.success) {
  console.error("server build failed");
  process.exit(1);
}
console.log("dist/ ready");
