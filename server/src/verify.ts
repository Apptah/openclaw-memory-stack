import { Env, jsonResponse, errorResponse, rateLimitCheck, LicenseData } from "./utils";

export async function handleVerify(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const deviceId = url.searchParams.get("device_id");

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
