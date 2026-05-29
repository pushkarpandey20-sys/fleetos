import crypto from "crypto";

export function signPayload(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export async function dispatchWebhook(opts: { webhookUrl: string; secret: string; event: string; payload: object }) {
  const body = JSON.stringify(opts.payload);
  try {
    await fetch(opts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-FleetOS-Event": opts.event, "X-FleetOS-Signature": "sha256=" + signPayload(body, opts.secret) },
      body,
    });
  } catch (e) { console.error("[webhook] failed:", e); }
}
