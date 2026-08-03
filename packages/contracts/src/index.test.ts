import { describe, expect, it } from "vitest";
import { normalizeDomain, presetCategories } from "./index";

describe("normalizeDomain", () => {
  it("normalizes case, trailing dots, and IDNs", () => {
    expect(normalizeDomain("BÜCHER.example.")).toBe("xn--bcher-kva.example");
  });
  it("rejects URLs and empty labels", () => {
    expect(() => normalizeDomain("https://example.com/a")).toThrow();
    expect(() => normalizeDomain("bad..example")).toThrow();
  });
});

describe("presets", () => {
  it("keeps threats enabled for every age", () => {
    expect(Object.values(presetCategories).every((categories) => categories.includes("threats"))).toBe(true);
  });
});
