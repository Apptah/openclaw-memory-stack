import { Env, jsonResponse, errorResponse, LicenseData } from "./utils";

export async function handleRevoke(request: Request, env: Env): Promise<Response> {
  // Admin only — check bearer token
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return errorResponse("Unauthorized", 401);
  }

  const body = (await request.json()) as { key?: string };
  if (!body.key) {
    return errorResponse("Missing key");
  }

  const raw = await env.KV.get(`license:${body.key}`);
  if (!raw) {
    return errorResponse("License not found", 404);
  }

  const license: LicenseData = JSON.parse(raw);
  license.active = false;
  await env.KV.put(`license:${body.key}`, JSON.stringify(license));

  return jsonResponse({ revoked: true, key: body.key });
}
