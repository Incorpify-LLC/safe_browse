import browser from "webextension-polyfill";
import { native } from "./native";

function hostname(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : null; } catch { return null; }
}
function browserName(): string { const agent = navigator.userAgent.toLowerCase(); return agent.includes("firefox") ? "firefox" : agent.includes("edg/") ? "edge" : "chrome"; }

browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const domain = hostname(details.url); if (domain) void native({ action: "navigation", domain, browser: browserName() });
});

browser.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  const domain = hostname(details.url); if (!domain) return;
  void native({ action: "recent", domain }).then(async (decision) => {
    if (!decision.blocked) return;
    const params = new URLSearchParams({ domain, category: decision.category ?? "policy", reason: decision.reason ?? "blocked" });
    await browser.tabs.update(details.tabId, { url: browser.runtime.getURL(`blocked.html?${params}`) });
  });
});
