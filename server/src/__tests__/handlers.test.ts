import { describe, it, expect, mock, beforeEach, type Mock } from "bun:test";
import { handleWebhook } from "../webhook";
import { handleActivate } from "../activate";
import type { Env } from "../utils";
import { isNewer, isValidSemver } from "../download";
import { handleCheckUpdate } from "../check-update";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeKV(overrides: Record<string, string | null> = {}) {
  const store: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== null) store[k] = v;
  }
  return {
    get: mock(async (key: string) => store[key] ?? null),
    put: mock(async (_key: string, _val: string, _opts?: any) => {}),
    delete: mock(async (_key: string) => {}),
  };
}

function makeEnv(kvOverrides: Record<string, string | null> = {}): Env {
  return {
    KV: makeKV(kvOverrides) as unknown as KVNamespace,
    RELEASES: {} as unknown as R2Bucket,
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "test_webhook_secret",
    RESEND_API_KEY: "test_resend_key",
    ADMIN_TOKEN: "test_admin",
    VERIFY_RATE_LIMIT: "10",
    MAX_DEVICES: "3",
    MONTHLY_RESET_LIMIT: "2",
  };
}

function checkoutEvent(
  overrides: {
    id?: string;
    type?: string;
    email?: string;
    tier?: string;
  } = {},
) {
  return {
    id: overrides.id ?? "evt_test_123",
    type: overrides.type ?? "checkout.session.completed",
    data: {
      object: {
        customer_details: { email: overrides.email ?? "user@example.com" },
        customer_email: null,
        metadata: { tier: overrides.tier ?? "starter", version: "0.1.0" },
      },
    },
  };
}

async function signedWebhookRequest(
  body: string,
  secret: string,
  url = "https://worker.test/api/webhook",
): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacSign(secret, `${timestamp}.${body}`);
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${sig}`,
    },
    body,
  });
}

function makeR2(files: Record<string, object> = {}) {
  return {
    get: mock(async (key: string) => {
      const data = files[key];
      if (!data) return null;
      return { json: async () => data };
    }),
  };
}

function checkUpdateRequest(params: Record<string, string>, ip = "1.2.3.4"): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`https://worker.test/api/check-update?${qs}`, {
    method: "GET",
    headers: { "CF-Connecting-IP": ip },
  });
}

function storedLicenseFull(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    tier: "starter",
    email: "user@example.com",
    created_at: "2025-01-01T00:00:00Z",
    active: true,
    version: "0.1.0",
    purchased_minor: "0.1",
    devices: [{ id: "d1", name: "Mac1", added_at: "2025-01-01T00:00:00Z" }],
    max_devices: 3,
    ...overrides,
  });
}

// Save original fetch so we can restore it
const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// handleWebhook
// ---------------------------------------------------------------------------

describe("handleWebhook", () => {
  let mockFetch: Mock<typeof fetch>;

  beforeEach(() => {
    mockFetch = mock<typeof fetch>(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    globalThis.fetch = mockFetch;
  });

  // Restore after each test to avoid pollution
  // bun:test doesn't have afterEach built-in the same way, but beforeEach resets it

  it("returns 400 on invalid signature", async () => {
    const req = new Request("https://worker.test/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1234,v1=badsig",
      },
      body: JSON.stringify(checkoutEvent()),
    });
    const env = makeEnv();
    const res = await handleWebhook(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Invalid signature");
  });

  it("returns 200 with duplicate:true on replay event", async () => {
    const event = checkoutEvent({ id: "evt_replay" });
    const body = JSON.stringify(event);
    const env = makeEnv({ "webhook:evt_replay": "processed" });
    const req = await signedWebhookRequest(body, env.STRIPE_WEBHOOK_SECRET);

    const res = await handleWebhook(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.duplicate).toBe(true);
  });

  it("skips non-checkout.session.completed events", async () => {
    const event = checkoutEvent({ type: "payment_intent.succeeded" });
    const body = JSON.stringify(event);
    const env = makeEnv();
    const req = await signedWebhookRequest(body, env.STRIPE_WEBHOOK_SECRET);

    const res = await handleWebhook(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.received).toBe(true);
    // Should not have tried to store a webhook event or license
    expect((env.KV.put as Mock<any>)).not.toHaveBeenCalled();
  });

  it("guards against empty email — returns 200 without creating license", async () => {
    const event = checkoutEvent({ email: "" });
    // Also clear customer_email
    event.data.object.customer_details.email = "";
    event.data.object.customer_email = "";
    const body = JSON.stringify(event);
    const env = makeEnv();
    const req = await signedWebhookRequest(body, env.STRIPE_WEBHOOK_SECRET);

    const res = await handleWebhook(req, env);
    expect(res.status).toBe(200);

    // Should have stored the webhook dedup key but NOT a license key
    const putCalls = (env.KV.put as Mock<any>).mock.calls;
    const licenseKeys = putCalls.filter((c: any[]) =>
      (c[0] as string).startsWith("license:"),
    );
    expect(licenseKeys.length).toBe(0);
  });

  it("creates license in KV on valid checkout event", async () => {
    const event = checkoutEvent();
    const body = JSON.stringify(event);
    const env = makeEnv();
    const req = await signedWebhookRequest(body, env.STRIPE_WEBHOOK_SECRET);

    const res = await handleWebhook(req, env);
    expect(res.status).toBe(200);

    const putCalls = (env.KV.put as Mock<any>).mock.calls;
    const licenseCall = putCalls.find((c: any[]) =>
      (c[0] as string).startsWith("license:"),
    );
    expect(licenseCall).toBeDefined();

    const stored = JSON.parse(licenseCall![1] as string);
    expect(stored.email).toBe("user@example.com");
    expect(stored.tier).toBe("starter");
    expect(stored.active).toBe(true);
    expect(stored.devices).toEqual([]);
  });

  it("does NOT include license key in response body", async () => {
    const event = checkoutEvent();
    const body = JSON.stringify(event);
    const env = makeEnv();
    const req = await signedWebhookRequest(body, env.STRIPE_WEBHOOK_SECRET);

    const res = await handleWebhook(req, env);
    const data = await res.json();
    const text = JSON.stringify(data);
    expect(text).not.toContain("oc-starter-");
  });

  it("retries email on first failure, logs on second failure", async () => {
    const event = checkoutEvent();
    const body = JSON.stringify(event);
    const env = makeEnv();
    const req = await signedWebhookRequest(body, env.STRIPE_WEBHOOK_SECRET);

    // Both calls fail
    mockFetch = mock<typeof fetch>(() =>
      Promise.resolve(new Response("error", { status: 500 })),
    );
    globalThis.fetch = mockFetch;

    const res = await handleWebhook(req, env);
    expect(res.status).toBe(200);
    // fetch should have been called twice (initial + retry)
    expect(mockFetch.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// handleActivate
// ---------------------------------------------------------------------------

describe("handleActivate", () => {
  beforeEach(() => {
    // Restore fetch in case webhook tests polluted it
    globalThis.fetch = originalFetch;
  });

  function activateRequest(
    body: Record<string, unknown>,
    ip = "1.2.3.4",
  ): Request {
    return new Request("https://worker.test/api/activate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": ip,
      },
      body: JSON.stringify(body),
    });
  }

  function storedLicense(overrides: Partial<Record<string, unknown>> = {}) {
    return JSON.stringify({
      tier: "starter",
      email: "user@example.com",
      created_at: "2025-01-01T00:00:00Z",
      active: true,
      version: "0.1.0",
      devices: [],
      max_devices: 3,
      ...overrides,
    });
  }

  it("returns 429 when rate limited", async () => {
    // Simulate rate limit reached by pre-filling the counter
    const env = makeEnv();
    (env.KV.get as Mock<any>).mockImplementation(async (key: string) => {
      if (key.startsWith("ratelimit:")) return "10"; // at limit
      return null;
    });

    const req = activateRequest({ key: "oc-starter-abc", device_id: "d1" });
    const res = await handleActivate(req, env);
    expect(res.status).toBe(429);
  });

  it("returns 400 when missing key or device_id", async () => {
    const env = makeEnv();
    const req = activateRequest({ key: "oc-starter-abc" }); // no device_id
    const res = await handleActivate(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing key or device_id");
  });

  it("returns 403 on invalid key", async () => {
    const env = makeEnv();
    const req = activateRequest({ key: "bad-key", device_id: "d1" });
    const res = await handleActivate(req, env);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.reason).toBe("invalid_key");
  });

  it("returns 403 on revoked license", async () => {
    const env = makeEnv({
      "license:oc-starter-revoked": storedLicense({ active: false }),
    });
    const req = activateRequest({
      key: "oc-starter-revoked",
      device_id: "d1",
    });
    const res = await handleActivate(req, env);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.reason).toBe("revoked");
  });

  it("returns 403 when device limit reached (with reset_url)", async () => {
    const devices = [
      { id: "d1", name: "Mac1", added_at: "2025-01-01T00:00:00Z" },
      { id: "d2", name: "Mac2", added_at: "2025-01-02T00:00:00Z" },
      { id: "d3", name: "Mac3", added_at: "2025-01-03T00:00:00Z" },
    ];
    const env = makeEnv({
      "license:oc-starter-full": storedLicense({ devices, max_devices: 3 }),
    });
    const req = activateRequest({
      key: "oc-starter-full",
      device_id: "d4",
    });
    const res = await handleActivate(req, env);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.reason).toBe("activation_limit_reached");
    expect(data.reset_url).toBe("/manage");
    expect(data.max).toBe(3);
  });

  it("activates device and returns valid:true", async () => {
    const env = makeEnv({
      "license:oc-starter-new": storedLicense(),
    });
    const req = activateRequest({
      key: "oc-starter-new",
      device_id: "device-abc",
      device_name: "My MacBook",
    });
    const res = await handleActivate(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.tier).toBe("starter");

    // Verify license was updated in KV with the new device
    const putCalls = (env.KV.put as Mock<any>).mock.calls;
    const licenseCall = putCalls.find((c: any[]) =>
      (c[0] as string).startsWith("license:"),
    );
    expect(licenseCall).toBeDefined();
    const updated = JSON.parse(licenseCall![1] as string);
    expect(updated.devices.length).toBe(1);
    expect(updated.devices[0].id).toBe("device-abc");
    expect(updated.devices[0].name).toBe("My MacBook");
  });

  it("returns valid:true without re-adding already activated device", async () => {
    const devices = [
      { id: "existing-device", name: "Mac1", added_at: "2025-01-01T00:00:00Z" },
    ];
    const env = makeEnv({
      "license:oc-starter-existing": storedLicense({ devices }),
    });
    const req = activateRequest({
      key: "oc-starter-existing",
      device_id: "existing-device",
    });
    const res = await handleActivate(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(true);

    // KV.put should NOT have been called for the license (no update needed)
    const putCalls = (env.KV.put as Mock<any>).mock.calls;
    const licensePuts = putCalls.filter((c: any[]) =>
      (c[0] as string).startsWith("license:"),
    );
    expect(licensePuts.length).toBe(0);
  });

  it("logs device activation", async () => {
    const env = makeEnv({
      "license:oc-starter-log": storedLicense(),
    });
    const consoleSpy = mock(() => {});
    const origLog = console.log;
    console.log = consoleSpy;

    const req = activateRequest({
      key: "oc-starter-log",
      device_id: "d-log-test",
    });
    await handleActivate(req, env);

    console.log = origLog;

    const logCall = consoleSpy.mock.calls.find(
      (c: any[]) => c[0] === "Device activated",
    );
    expect(logCall).toBeDefined();
    expect(logCall![1].device_id).toBe("d-log-test");
  });
});

describe("isNewer", () => {
  it("returns true when latest is greater (patch)", () => {
    expect(isNewer("0.1.3", "0.1.0")).toBe(true);
  });

  it("returns true when latest is greater (minor)", () => {
    expect(isNewer("0.2.0", "0.1.3")).toBe(true);
  });

  it("returns true when latest is greater (major)", () => {
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });

  it("returns false when equal", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });

  it("returns false when latest is older", () => {
    expect(isNewer("0.1.0", "0.1.3")).toBe(false);
  });
});

describe("isValidSemver", () => {
  it("accepts valid versions", () => {
    expect(isValidSemver("0.1.0")).toBe(true);
    expect(isValidSemver("1.20.300")).toBe(true);
  });

  it("rejects invalid versions", () => {
    expect(isValidSemver("main")).toBe(false);
    expect(isValidSemver("v0.1.0")).toBe(false);
    expect(isValidSemver("1.2")).toBe(false);
    expect(isValidSemver("1.2.3.4")).toBe(false);
    expect(isValidSemver("1.2.3-beta")).toBe(false);
    expect(isValidSemver("")).toBe(false);
  });
});

describe("handleCheckUpdate", () => {
  it("returns 400 when key is missing", async () => {
    const env = makeEnv();
    const req = checkUpdateRequest({ current: "0.1.0" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing key");
  });

  it("returns 400 when current is invalid", async () => {
    const env = makeEnv({ "license:oc-starter-abc": storedLicenseFull() });
    const req = checkUpdateRequest({ key: "oc-starter-abc", current: "main" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe("invalid_version");
  });

  it("returns 403 when key is invalid", async () => {
    const env = makeEnv();
    const req = checkUpdateRequest({ key: "fake", current: "0.1.0" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.reason).toBe("invalid_key");
  });

  it("returns 403 when license is revoked", async () => {
    const env = makeEnv({
      "license:oc-starter-rev": storedLicenseFull({ active: false }),
    });
    const req = checkUpdateRequest({ key: "oc-starter-rev", current: "0.1.0" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.reason).toBe("revoked");
  });

  it("starter gets patch within purchased minor, not global latest", async () => {
    const env = makeEnv({
      "license:oc-starter-s1": storedLicenseFull({ tier: "starter", purchased_minor: "0.1" }),
    });
    env.RELEASES = makeR2({
      "latest.json": { version: "0.2.0" },
      "v0.1/latest-patch.json": { version: "0.1.3" },
    }) as unknown as R2Bucket;

    const req = checkUpdateRequest({ key: "oc-starter-s1", current: "0.1.0" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.update_available).toBe(true);
    expect(data.latest).toBe("0.1.3");
    expect(data.current).toBe("0.1.0");
  });

  it("subscriber gets global latest", async () => {
    const env = makeEnv({
      "license:oc-sub-s1": storedLicenseFull({ tier: "subscriber", purchased_minor: "0.1" }),
    });
    env.RELEASES = makeR2({
      "latest.json": { version: "0.2.0" },
      "v0.1/latest-patch.json": { version: "0.1.3" },
    }) as unknown as R2Bucket;

    const req = checkUpdateRequest({ key: "oc-sub-s1", current: "0.1.0" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.update_available).toBe(true);
    expect(data.latest).toBe("0.2.0");
  });

  it("returns update_available:false when already up to date", async () => {
    const env = makeEnv({
      "license:oc-starter-up": storedLicenseFull({ tier: "starter", purchased_minor: "0.1" }),
    });
    env.RELEASES = makeR2({
      "v0.1/latest-patch.json": { version: "0.1.3" },
    }) as unknown as R2Bucket;

    const req = checkUpdateRequest({ key: "oc-starter-up", current: "0.1.3" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.update_available).toBe(false);
  });

  it("returns update_available:false on fallback (no patch file)", async () => {
    const env = makeEnv({
      "license:oc-starter-fb": storedLicenseFull({ tier: "starter", purchased_minor: "0.1", version: "0.1.0" }),
    });
    env.RELEASES = makeR2({}) as unknown as R2Bucket;

    const req = checkUpdateRequest({ key: "oc-starter-fb", current: "0.1.0" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.update_available).toBe(false);
    expect(data.latest).toBe("0.1.0");
  });

  it("returns 429 when rate limited", async () => {
    const env = makeEnv();
    (env.KV.get as Mock<any>).mockImplementation(async (key: string) => {
      if (key.startsWith("ratelimit:")) return "10";
      return null;
    });

    const req = checkUpdateRequest({ key: "oc-starter-rl", current: "0.1.0" });
    const res = await handleCheckUpdate(req, env);
    expect(res.status).toBe(429);
  });
});
