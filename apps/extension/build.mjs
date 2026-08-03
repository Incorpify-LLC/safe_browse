import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist/chromium", { recursive: true }); await mkdir("dist/firefox", { recursive: true });
for (const target of ["chromium", "firefox"]) {
  await build({ entryPoints: ["src/background.ts", "src/blocked.ts"], bundle: true, format: "iife", outdir: `dist/${target}`, minify: true });
  await cp("src/blocked.html", `dist/${target}/blocked.html`); await cp("src/blocked.css", `dist/${target}/blocked.css`);
  await cp(`manifests/${target}.json`, `dist/${target}/manifest.json`);
}
