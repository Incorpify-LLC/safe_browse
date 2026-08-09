import type { AppBindings } from "./types";

export type SecurityEventType =
  | "password.created"
  | "password.changed"
  | "password.recovery_used"
  | "login.brute_force_detected"
  | "device.tamper_detected";

export async function sendParentSecurityAlert(
  env: AppBindings,
  parentEmail: string,
  eventType: SecurityEventType,
  details: { ipAddress?: string; userAgent?: string; deviceName?: string; time?: string }
): Promise<boolean> {
  const now = details.time || new Date().toUTCString();
  let subject = "🛡️ Safe Browse Security Alert";
  let bodyText = "";
  let bodyHtml = "";

  switch (eventType) {
    case "password.created":
      subject = "🛡️ Safe Browse: Master Password Created";
      bodyText = `A master password was created for your Safe Browse household on ${now}. IP: ${details.ipAddress || "Unknown"}`;
      bodyHtml = createAlertTemplate(
        "Master Password Created",
        "A master password has been set up for your Safe Browse parent console.",
        details
      );
      break;

    case "password.changed":
      subject = "⚠️ Safe Browse: Master Password Changed";
      bodyText = `Your master password was changed on ${now}. If you did not make this change, please recover your account immediately. IP: ${details.ipAddress || "Unknown"}`;
      bodyHtml = createAlertTemplate(
        "Master Password Changed",
        "Your parent console master password was recently modified.",
        details
      );
      break;

    case "password.recovery_used":
      subject = "🚨 Safe Browse: Password Reset via Recovery Key";
      bodyText = `An Emergency Recovery Key was used to reset your Master Password on ${now}. IP: ${details.ipAddress || "Unknown"}`;
      bodyHtml = createAlertTemplate(
        "Emergency Recovery Key Used",
        "An Emergency Recovery Key was used to reset your parent console password. A new emergency key has been generated.",
        details
      );
      break;

    case "login.brute_force_detected":
      subject = "🚨 Safe Browse SECURITY ALERT: Repeated Failed Login Attempts";
      bodyText = `Multiple failed login attempts were detected targeting your parent console on ${now}. Console access has been temporarily locked to protect your family. IP: ${details.ipAddress || "Unknown"}`;
      bodyHtml = createAlertTemplate(
        "Brute-Force Login Warning",
        "Multiple incorrect password attempts were detected. Login has been temporarily locked to prevent unauthorized access or password cracking tools.",
        details
      );
      break;

    case "device.tamper_detected":
      subject = "⚠️ Safe Browse: Child Device Tamper / Offline Alert";
      bodyText = `Safe Browse protection on ${details.deviceName || "child device"} stopped reporting or was modified on ${now}.`;
      bodyHtml = createAlertTemplate(
        "Device Tamper Alert",
        `Protection agent on device <strong>${details.deviceName || "Child PC"}</strong> went offline or was modified.`,
        details
      );
      break;
  }

  let sent = false;

  try {
    // 1. Send via Telegram Bot Instant Push Alert (Zero Domain, Zero Cost, 100% Mobile Push)
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const telegramMsg = `${subject}\n\n${bodyText}`;
      const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: telegramMsg }),
      });
      if (tgRes.ok) sent = true;
    }

    // 2. Send via ntfy.sh Instant Mobile Push Alert (Zero Domain, Zero Cost)
    if (env.NTFY_TOPIC) {
      const ntfyRes = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
        method: "POST",
        headers: { Title: subject, Priority: "high", Tags: "shield,warning" },
        body: bodyText,
      });
      if (ntfyRes.ok) sent = true;
    }

    // 3. Send via Resend HTTP API (Zero Domain needed using onboarding@resend.dev)
    if (env.RESEND_API_KEY && parentEmail && !parentEmail.endsWith("@family.local")) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || "Safe Browse Alerts <onboarding@resend.dev>",
          to: [parentEmail],
          subject,
          html: bodyHtml,
          text: bodyText,
        }),
      });
      if (res.ok) sent = true;
    }

    // 4. Send via Cloudflare Native Email Binding (Requires custom domain Email Routing)
    // EmailMessage is a Workers runtime global — skip in local Miniflare if missing.
    if (
      env.EMAIL &&
      parentEmail &&
      !parentEmail.endsWith("@family.local") &&
      typeof EmailMessage !== "undefined"
    ) {
      const mime = [
        `From: ${env.EMAIL_FROM || "Safe Browse Alerts <alerts@safebrowse.family>"}`,
        `To: ${parentEmail}`,
        `Subject: ${subject}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        bodyHtml,
      ].join("\r\n");

      const emailMessage = new EmailMessage(
        env.EMAIL_FROM || "alerts@safebrowse.family",
        parentEmail,
        mime,
      );
      await env.EMAIL.send(emailMessage);
      sent = true;
    }
  } catch (err) {
    console.error("Parent security alert error:", err);
  }
  return sent;
}

function createAlertTemplate(title: string, description: string, details: { ipAddress?: string; userAgent?: string; time?: string }): string {
  return `
    <!DOCTYPE html>
    <html>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#091b15;color:#ffffff;padding:24px;margin:0;">
        <div style="max-width:520px;margin:0 auto;background:#112820;border:1px solid #20483a;border-radius:16px;padding:32px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
            <div style="background:#80bd9f;color:#091b15;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:20px;">S</div>
            <h2 style="margin:0;font-size:20px;color:#ffffff;">Safe Browse Alert</h2>
          </div>
          <h3 style="color:#80bd9f;margin-top:0;">${title}</h3>
          <p style="color:#d0e2db;font-size:14px;line-height:1.6;">${description}</p>
          <div style="background:#081813;border:1px solid #285445;border-radius:10px;padding:16px;margin:20px 0;font-size:12px;color:#a8c4ba;">
            <p style="margin:4px 0;"><strong>Time:</strong> ${details.time || new Date().toUTCString()}</p>
            <p style="margin:4px 0;"><strong>IP Address:</strong> ${details.ipAddress || "Unknown"}</p>
            <p style="margin:4px 0;"><strong>Browser/Device:</strong> ${details.userAgent || "Unknown"}</p>
          </div>
          <p style="font-size:11px;color:#709487;margin-top:24px;border-top:1px solid #20483a;padding-top:16px;">
            This security notification was sent automatically by Safe Browse Family Protection.
          </p>
        </div>
      </body>
    </html>
  `;
}
