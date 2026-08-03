import browser from "webextension-polyfill";

export type NativeDecision = { blocked?: boolean; domain?: string; category?: string | null; reason?: string; error?: string; ok?: boolean; requestId?: string };
export async function native(message: object): Promise<NativeDecision> {
  try { return await browser.runtime.sendNativeMessage("com.incorpify.safebrowse", message) as NativeDecision; }
  catch { return { error: "agent_unavailable" }; }
}
