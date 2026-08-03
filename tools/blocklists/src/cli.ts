import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileSources, signManifest, type Source } from "./compiler";

const toolRoot = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(toolRoot, "sources.json"), "utf8")) as { transformationVersion: string; sources: Source[] };
const version = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const output = resolve(process.argv[2] ?? "artifacts/lists", version);
await mkdir(output, { recursive: true });
const artifacts = await compileSources(config.sources, toolRoot);
for (const artifact of artifacts) await writeFile(resolve(output, artifact.filename), artifact.gzip);

const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  transformationVersion: config.transformationVersion,
  artifacts: artifacts.map(({ gzip: _gzip, ...artifact }) => artifact),
};
const keyPath = process.env.SAFE_BROWSE_SIGNING_KEY;
if (!keyPath) throw new Error("SAFE_BROWSE_SIGNING_KEY must point to an ECDSA P-256 private PEM file");
const envelope = { version, ...signManifest(manifest, await readFile(keyPath, "utf8")) };
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(envelope, null, 2)}\n`);
await writeFile(resolve(output, "manifest.payload.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ message: "blocklists_compiled", output, version, counts: Object.fromEntries(artifacts.map((item) => [item.category, item.count])) }));
