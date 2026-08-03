import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDomains, signManifest } from "./compiler";

describe("parseDomains", () => {
  it("accepts domain, hosts, and adblock formats deterministically", () => {
    expect(parseDomains("Example.com\n0.0.0.0 tracker.test\n||adult.test^\n# comment\nexample.com"))
      .toEqual(["adult.test", "example.com", "tracker.test"]);
  });
});

describe("signManifest", () => {
  it("creates a verifiable P-256 signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const envelope = signManifest({ version: "test" }, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    expect(verify("sha256", Buffer.from(envelope.payload, "base64url"), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(envelope.signature, "base64url"))).toBe(true);
  });
});
