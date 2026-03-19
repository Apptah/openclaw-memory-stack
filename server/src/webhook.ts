import { Env, jsonResponse, errorResponse, nanoid, LicenseData } from "./utils";

async function verifyStripeSignature(
  request: Request,
  secret: string,
): Promise<{ valid: boolean; payload?: any }> {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature") ?? "";

  const parts = Object.fromEntries(
    sig.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    }),
  );

  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return { valid: false };

  const signedPayload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected !== signature) return { valid: false };

  // Check timestamp freshness (5 min tolerance)
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) return { valid: false };

  return { valid: true, payload: JSON.parse(body) };
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const { valid, payload } = await verifyStripeSignature(request, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return errorResponse("Invalid signature", 400);

  const event = payload;
  if (event.type !== "checkout.session.completed") {
    return jsonResponse({ received: true });
  }

  // Replay protection
  const eventId = event.id as string;
  const existing = await env.KV.get(`webhook:${eventId}`);
  if (existing) return jsonResponse({ received: true, duplicate: true });
  await env.KV.put(`webhook:${eventId}`, "processed", { expirationTtl: 86400 });

  const session = event.data.object;
  const email = session.customer_details?.email ?? session.customer_email ?? "";
  const tier = session.metadata?.tier ?? "starter";
  const version = session.metadata?.version ?? "0.1.0";

  // Guard: email is required to issue a license
  if (!email) {
    console.error("Webhook missing email", { eventId });
    return jsonResponse({ received: true });
  }

  // Generate license key
  const key = `oc-starter-${nanoid(24)}`;

  // Store license
  const license: LicenseData = {
    tier,
    email,
    created_at: new Date().toISOString(),
    active: true,
    version,
    devices: [],
    max_devices: parseInt(env.MAX_DEVICES, 10),
  };
  await env.KV.put(`license:${key}`, JSON.stringify(license));
  console.log("License created", { email, tier, key_prefix: key.slice(0, 12) + "..." });

  // Generate download token
  const downloadToken = nanoid(32);
  await env.KV.put(`dl:${downloadToken}`, JSON.stringify({ version }), {
    expirationTtl: 86400,
  });
  const workerUrl = new URL(request.url).origin;
  const downloadUrl = `${workerUrl}/api/download/${downloadToken}`;

  // Send email via Resend (retry once on failure)
  const emailBody = JSON.stringify({
    from: "OpenClaw Memory Stack <onboarding@resend.dev>",
    to: [email],
    subject: "Your OpenClaw Memory Stack License",
    html: `
        <h2>Welcome to OpenClaw Memory Stack!</h2>
        <p>Your license key: <code>${key}</code></p>
        <p><a href="${downloadUrl}">Download your copy</a> (link expires in 24 hours)</p>
        <h3>Quick Start</h3>
        <ol>
          <li>Download and unzip the file</li>
          <li>Run: <code>./install.sh --key=${key}</code></li>
          <li>In your project: <code>openclaw-memory init</code></li>
          <li>Query: <code>openclaw-memory "find function parseAuth"</code></li>
        </ol>
        <p>If you need to re-download, visit your Manage License page.</p>
      `,
  });
  const emailHeaders = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };

  let emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: emailHeaders,
    body: emailBody,
  });

  if (!emailRes.ok) {
    // Retry once after 2 seconds
    await new Promise((r) => setTimeout(r, 2000));
    emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: emailHeaders,
      body: emailBody,
    });
    if (!emailRes.ok) {
      console.error("Email send failed after retry", { eventId, email });
    }
  }

  if (emailRes.ok) {
    console.log("Email sent", { email });
  }

  return jsonResponse({ received: true });
}
