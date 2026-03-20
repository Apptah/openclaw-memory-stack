import { Env, jsonResponse, errorResponse, nanoid, LicenseData, toMinor } from "./utils";

/**
 * Resolve the download version for a license.
 *
 * - subscriber → global latest (from R2 latest.json)
 * - starter    → latest patch within purchased_minor (from R2 v{minor}/latest-patch.json)
 *                Falls back to license.version if no latest-patch.json exists yet.
 */
export async function resolveVersion(license: LicenseData, env: Env): Promise<string> {
  if (license.tier === "subscriber") {
    // Subscribers get the global latest
    const obj = await env.RELEASES.get("latest.json");
    if (obj) {
      const data = await obj.json<{ version: string }>();
      return data.version;
    }
  }

  // Starter: latest patch within their purchased minor
  const minor = license.purchased_minor ?? toMinor(license.version);
  const patchObj = await env.RELEASES.get(`v${minor}/latest-patch.json`);
  if (patchObj) {
    const data = await patchObj.json<{ version: string }>();
    return data.version;
  }

  // Fallback: exact version at purchase
  return license.version;
}

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

  const version = await resolveVersion(license, env);

  // Generate one-time download token (1hr TTL)
  const token = nanoid(32);
  await env.KV.put(
    `dl:${token}`,
    JSON.stringify({ version }),
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

  const version = await resolveVersion(license, env);
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

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function isValidSemver(v: string): boolean {
  return SEMVER_RE.test(v);
}

export function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}
