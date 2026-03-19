export interface Env {
  KV: KVNamespace;
  RELEASES: R2Bucket;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  ADMIN_TOKEN: string;
  VERIFY_RATE_LIMIT: string;
  MAX_DEVICES: string;
  MONTHLY_RESET_LIMIT: string;
}

export interface LicenseData {
  tier: string;
  email: string;
  created_at: string;
  active: boolean;
  version: string;
  devices: { id: string; name: string; added_at: string }[];
  max_devices: number;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function nanoid(length = 24): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export async function rateLimitCheck(
  kv: KVNamespace,
  ip: string,
  limit: number,
): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60000);
  const key = `ratelimit:${ip}:${minute}`;
  const current = parseInt((await kv.get(key)) ?? "0", 10);
  if (current >= limit) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 60 });
  return true;
}
