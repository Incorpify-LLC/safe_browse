import { native } from "./native";

const params = new URLSearchParams(location.search); const domain = params.get("domain") ?? "this site"; const category = params.get("category") ?? "policy";
document.querySelector<HTMLElement>("[data-domain]")!.textContent = domain;
document.querySelector<HTMLElement>("[data-category]")!.textContent = category;
document.querySelector<HTMLFormElement>("form")!.addEventListener("submit", async (event) => {
  event.preventDefault(); const button = document.querySelector<HTMLButtonElement>("button")!; const reason = document.querySelector<HTMLInputElement>("input")!.value;
  button.disabled = true; button.textContent = "Sending…";
  const result = await native({ action: "request", domain, category: category === "policy" ? null : category, reason: reason || null });
  button.textContent = result.ok ? "Request sent" : "Could not send request";
});
