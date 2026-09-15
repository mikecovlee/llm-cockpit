const t = process.env.GITHUB_REF_NAME ?? "";
const repo = process.env.GITHUB_REPOSITORY ?? "";
const ghToken = process.env.GH_TOKEN ?? "";
if (t === "" || repo === "" || ghToken === "") {
  console.error("release.mjs requires GITHUB_REF_NAME, GITHUB_REPOSITORY, GH_TOKEN");
  process.exit(1);
}
const body = await Bun.file("release-notes.md").text();
const api = `https://api.github.com/repos/${repo}`;
const headers = {
  authorization: `Bearer ${ghToken}`,
  "user-agent": "llm-cockpit-ci",
  accept: "application/vnd.github+json",
};

const rel = await fetch(`${api}/releases`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ tag_name: t, name: t, body, prerelease: false }),
});
if (!rel.ok && rel.status !== 422) {
  console.error("release create:", rel.status, await rel.text());
  process.exit(1);
}
console.log("release ready:", rel.status === 422 ? "(already existed)" : "created");

const tagRel = await fetch(`${api}/releases/tags/${t}`, { headers });
if (!tagRel.ok) {
  console.error("release lookup:", tagRel.status, await tagRel.text());
  process.exit(1);
}
const up = String((await tagRel.json()).upload_url).split("{")[0];
if (up === "") {
  console.error("no upload_url");
  process.exit(1);
}

const asset = async (file, type) => {
  const r = await fetch(`${up}?name=${encodeURIComponent(file)}`, {
    method: "POST",
    headers: { ...headers, "content-type": type },
    body: Bun.file(file),
  });
  if (!r.ok) {
    console.error("upload:", file, r.status, await r.text());
    process.exit(1);
  }
  console.log("asset:", (await r.json()).browser_download_url);
};

await asset("llm-cockpit-linux-x64.tar.gz", "application/gzip");
await asset("llm-cockpit-linux-x64.tar.gz.sha256", "text/plain");
console.log("release assets uploaded");
