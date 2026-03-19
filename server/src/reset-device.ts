import { Env, jsonResponse, errorResponse, LicenseData } from "./utils";

export async function handleResetDevice(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    key?: string;
    email?: string;
    device_id?: string;
  };

  if (!body.key || !body.email || !body.device_id) {
    return errorResponse("Missing key, email, or device_id");
  }

  const raw = await env.KV.get(`license:${body.key}`);
  if (!raw) {
    return jsonResponse({ valid: false, reason: "invalid_key" }, 403);
  }

  const license: LicenseData = JSON.parse(raw);

  // Verify email matches
  if (license.email !== body.email) {
    return jsonResponse({ valid: false, reason: "email_mismatch" }, 403);
  }

  // Check monthly reset limit
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const resetKey = `device_reset:${body.key}:${month}`;
  const resetCount = parseInt((await env.KV.get(resetKey)) ?? "0", 10);
  const monthlyLimit = parseInt(env.MONTHLY_RESET_LIMIT, 10);

  if (resetCount >= monthlyLimit) {
    return jsonResponse(
      {
        valid: false,
        reason: "monthly_reset_limit_reached",
        limit: monthlyLimit,
        used: resetCount,
      },
      403,
    );
  }

  // Remove device
  const deviceIndex = license.devices.findIndex((d) => d.id === body.device_id);
  if (deviceIndex === -1) {
    return jsonResponse({ valid: false, reason: "device_not_found" }, 404);
  }

  license.devices.splice(deviceIndex, 1);
  await env.KV.put(`license:${body.key}`, JSON.stringify(license));

  // Increment reset counter
  await env.KV.put(resetKey, String(resetCount + 1), {
    expirationTtl: 2678400, // ~31 days
  });

  return jsonResponse({
    valid: true,
    devices_remaining: license.devices.length,
    resets_remaining: monthlyLimit - resetCount - 1,
  });
}
