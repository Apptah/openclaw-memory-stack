import { Env, jsonResponse, errorResponse, rateLimitCheck, LicenseData } from "./utils";

export async function handleActivate(request: Request, env: Env): Promise<Response> {
  // Rate limit
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = parseInt(env.VERIFY_RATE_LIMIT, 10);
  const allowed = await rateLimitCheck(env.KV, ip, limit);
  if (!allowed) {
    return errorResponse("Rate limit exceeded", 429);
  }

  const body = (await request.json()) as {
    key?: string;
    device_id?: string;
    device_name?: string;
  };

  if (!body.key || !body.device_id) {
    return errorResponse("Missing key or device_id");
  }

  const raw = await env.KV.get(`license:${body.key}`);
  if (!raw) {
    return jsonResponse({ valid: false, reason: "invalid_key" }, 403);
  }

  const license: LicenseData = JSON.parse(raw);
  if (!license.active) {
    return jsonResponse({ valid: false, reason: "revoked" }, 403);
  }

  // Check if device already activated
  const existing = license.devices.find((d) => d.id === body.device_id);
  if (existing) {
    return jsonResponse({ valid: true, tier: license.tier });
  }

  // Check device limit
  if (license.devices.length >= license.max_devices) {
    return jsonResponse(
      {
        valid: false,
        reason: "activation_limit_reached",
        max: license.max_devices,
        current: license.devices.length,
        reset_url: "/manage",
      },
      403,
    );
  }

  // Add device
  license.devices.push({
    id: body.device_id,
    name: body.device_name ?? "Unknown",
    added_at: new Date().toISOString(),
  });
  await env.KV.put(`license:${body.key}`, JSON.stringify(license));
  console.log("Device activated", { key_prefix: body.key.slice(0, 12) + "...", device_id: body.device_id });

  return jsonResponse({ valid: true, tier: license.tier });
}
