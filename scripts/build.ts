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
import { brotliCompressSync, gzipSync } from "node:zlib";
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
  writeFileSync(`dist/web/${asset}.br`, brotliCompressSync(js));
  writeFileSync(`dist/web/${asset}.gz`, gzipSync(js, { level: 9 }));
  const keep = new Set(["index.html", asset, `${asset}.br`, `${asset}.gz`]);
  for (const f of readdirSync("dist/web")) {
    if (keep.has(f)) continue;
    if (/^(main\.js|main-[0-9a-f]+\.js(\.br|\.gz)?)$/.test(f)) {
      unlinkSync(`dist/web/${f}`);
    }
  }
  const html = readFileSync("web/index.html", "utf8").replace("/web/main.js", `/web/${asset}`);
  writeFileSync("dist/web/index.html", html);
  writeFileSync("dist/web/index.html.br", brotliCompressSync(Buffer.from(html)));
  writeFileSync("dist/web/index.html.gz", gzipSync(Buffer.from(html), { level: 9 }));
}

if (!server.success) {
  console.error("server build failed");
  process.exit(1);
}
console.log("dist/ ready");
