import { Env, jsonResponse, errorResponse, nanoid, LicenseData } from "./utils";

export async function handleDownloadToken(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { key?: string; email?: string };

  if (!body.key || !body.email) {
    return errorResponse("Missing key or email");
  }

  const raw = await env.KV.get(`license:${body.key}`);
  if (!raw) {
    return jsonResponse({ valid: false, reason: "invalid_key" }, 403);
  }

  const license: LicenseData = JSON.parse(raw);
  if (!license.active) {
    return jsonResponse({ valid: false, reason: "revoked" }, 403);
  }
  if (license.email !== body.email) {
    return jsonResponse({ valid: false, reason: "email_mismatch" }, 403);
  }

  // Generate one-time download token (1hr TTL)
  const token = nanoid(32);
  await env.KV.put(
    `dl:${token}`,
    JSON.stringify({ version: license.version }),
    { expirationTtl: 3600 },
  );

  return jsonResponse({
    download_url: `/api/download/${token}`,
  });
}

export async function handleDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.pathname.replace("/api/download/", "");

  if (!token) {
    return errorResponse("Missing token", 400);
  }

  const raw = await env.KV.get(`dl:${token}`);
  if (!raw) {
    return errorResponse("Invalid or expired download token", 404);
  }

  const { version } = JSON.parse(raw) as { version: string };

  // Let TTL handle expiration — no deletion, so retries work within the TTL window

  // Get artifact from R2
  const objectKey = `v${version}/openclaw-memory-stack-v${version}.tar.gz`;
  const object = await env.RELEASES.get(objectKey);

  if (!object) {
    return errorResponse("Release artifact not found", 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="openclaw-memory-stack-v${version}.tar.gz"`,
    },
  });
}

export async function handleDownloadLatest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key) {
    return errorResponse("Missing license key", 400);
  }

  const raw = await env.KV.get(`license:${key}`);
  if (!raw) {
    return errorResponse("Invalid license key", 403);
  }

  const license: LicenseData = JSON.parse(raw);
  if (!license.active) {
    return errorResponse("License has been revoked", 403);
  }

  const version = license.version;
  const objectKey = `v${version}/openclaw-memory-stack-v${version}.tar.gz`;
  const object = await env.RELEASES.get(objectKey);

  if (!object) {
    return errorResponse("Release artifact not found", 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="openclaw-memory-stack-v${version}.tar.gz"`,
    },
  });
}
