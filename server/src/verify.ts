import { Env, jsonResponse, errorResponse, rateLimitCheck, LicenseData } from "./utils";

export async function handleVerify(request: Request, env: Env): Promise<Response> {
  // Support both GET (query params) and POST (JSON body)
  let key: string | null = null;
  let deviceId: string | null = null;

  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { key?: string; device_id?: string };
      key = body.key ?? null;
      deviceId = body.device_id ?? null;
    } catch {
      return errorResponse("Invalid JSON body");
    }
  } else {
    const url = new URL(request.url);
    key = url.searchParams.get("key");
    deviceId = url.searchParams.get("device_id");
  }

  if (!key || !deviceId) {
    return errorResponse("Missing key or device_id");
  }

  // Rate limit
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = parseInt(env.VERIFY_RATE_LIMIT, 10);
  const allowed = await rateLimitCheck(env.KV, ip, limit);
  if (!allowed) {
    return errorResponse("Rate limit exceeded", 429);
  }

  const raw = await env.KV.get(`license:${key}`);
  if (!raw) {
    return jsonResponse({ valid: false, reason: "invalid_key" }, 403);
  }

  const license: LicenseData = JSON.parse(raw);
  if (!license.active) {
    return jsonResponse({ valid: false, reason: "revoked" }, 403);
  }

  const deviceMatch = license.devices.some((d) => d.id === deviceId);
  if (!deviceMatch) {
    return jsonResponse({ valid: false, reason: "device_not_activated" }, 403);
  }

  return jsonResponse({ valid: true, tier: license.tier });
}
