// Webhook delivery — used by index.ts
export async function dispatchWebhook(url: string, secret: string, event: string, payload: object): Promise<void> {
  try {
    const body = JSON.stringify(payload);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-FleetOS-Event": event },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { console.error("[Webhook]", e); }
}
