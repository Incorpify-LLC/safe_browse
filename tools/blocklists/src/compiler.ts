import { createHash, createPrivateKey, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { normalizeDomain, type Category } from "@safe-browse/contracts";

export type Source = { category: Category; name: string; url?: string; path?: string; license: string; minimumEntries: number; maximumEntries: number };
export type CompiledArtifact = { category: Category; filename: string; gzip: Buffer; sha256: string; count: number; sources: { name: string; url?: string | undefined; path?: string | undefined; license: string }[] };

export function parseDomains(input: string): string[] {
  const domains = new Set<string>();
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("[")) continue;
    const candidate = line.startsWith("||") ? line.slice(2).split("^")[0] : line.split(/\s+/).at(-1);
    if (!candidate || candidate === "localhost" || candidate.endsWith(".local")) continue;
    try { domains.add(normalizeDomain(candidate.replace(/^\*\./, ""))); } catch { /* Ignore feed comments and invalid hosts. */ }
  }
  return [...domains].sort();
}

export async function compileSources(sources: Source[], root: string): Promise<CompiledArtifact[]> {
  const grouped = new Map<Category, { source: Source; body: string }[]>();
  for (const source of sources) {
    const body = source.url ? await fetchBounded(source.url) : await readFile(new URL(source.path!, `file://${root.replace(/\/$/, "")}/`), "utf8");
    const entries = parseDomains(body);
    if (entries.length < source.minimumEntries || entries.length > source.maximumEntries) {
      throw new Error(`${source.name}: unexpected entry count ${entries.length}`);
    }
    const existing = grouped.get(source.category) ?? [];
    existing.push({ source, body }); grouped.set(source.category, existing);
  }
  return [...grouped].map(([category, inputs]) => {
    const domains = [...new Set(inputs.flatMap(({ body }) => parseDomains(body)))].sort();
    const gzip = gzipSync(`${domains.join("\n")}\n`, { level: 9 });
    return { category, filename: `${category}.txt.gz`, gzip, sha256: createHash("sha256").update(gzip).digest("hex"), count: domains.length, sources: inputs.map(({ source }) => ({ name: source.name, url: source.url, path: source.path, license: source.license })) };
  }).sort((a, b) => a.category.localeCompare(b.category));
}

export function signManifest(manifest: object, privateKeyPem: string): { payload: string; signature: string; algorithm: "ES256" } {
  const payload = Buffer.from(JSON.stringify(manifest));
  const signature = sign("sha256", payload, { key: createPrivateKey(privateKeyPem), dsaEncoding: "ieee-p1363" });
  return { payload: payload.toString("base64url"), signature: signature.toString("base64url"), algorithm: "ES256" };
}

async function fetchBounded(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "safe-browse-blocklist-compiler/0.1" } });
  if (!response.ok) throw new Error(`Feed ${url} returned ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 100_000_000) throw new Error(`Feed ${url} exceeds 100 MB`);
  const body = await response.text();
  if (body.length > 100_000_000) throw new Error(`Feed ${url} exceeds 100 MB`);
  return body;
}
