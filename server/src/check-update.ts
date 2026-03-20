import { Env, jsonResponse, errorResponse, rateLimitCheck, LicenseData } from "./utils";
import { resolveVersion, isNewer, isValidSemver } from "./download";

export async function handleCheckUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const current = url.searchParams.get("current");

  if (!key) {
    return errorResponse("Missing key");
  }

  // Rate limit
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = parseInt(env.VERIFY_RATE_LIMIT, 10);
  const allowed = await rateLimitCheck(env.KV, ip, limit);
  if (!allowed) {
    return errorResponse("Rate limit exceeded", 429);
  }

  if (!current || !isValidSemver(current)) {
    return jsonResponse({ valid: false, reason: "invalid_version" }, 400);
  }

  const raw = await env.KV.get(`license:${key}`);
  if (!raw) {
    return jsonResponse({ valid: false, reason: "invalid_key" }, 403);
  }

  const license: LicenseData = JSON.parse(raw);
  if (!license.active) {
    return jsonResponse({ valid: false, reason: "revoked" }, 403);
  }

  const latest = await resolveVersion(license, env);

  if (!isValidSemver(latest)) {
    return errorResponse("Internal error", 500);
  }

  return jsonResponse({
    update_available: isNewer(latest, current),
    latest,
    current,
  });
}
