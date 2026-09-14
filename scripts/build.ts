// Bundle the server (target bun, zero runtime deps) and the web app (browser).
import { existsSync, mkdirSync } from "node:fs";
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
}

if (!server.success) {
  console.error("server build failed");
  process.exit(1);
}
console.log("dist/ ready");
