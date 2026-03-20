import { Env, jsonResponse, errorResponse, nanoid, LicenseData, toMinor } from "./utils";

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
    purchased_minor: toMinor(version),
    devices: [],
    max_devices: parseInt(env.MAX_DEVICES, 10),
  };
  await env.KV.put(`license:${key}`, JSON.stringify(license));
  console.log("License created", { email, tier, key_prefix: key.slice(0, 12) + "..." });

  // Store session → license mapping so /thanks page can display the key
  const sessionId = session.id as string;
  await env.KV.put(`session:${sessionId}`, JSON.stringify({ key, downloadUrl: "" }), {
    expirationTtl: 86400,
  });

  // Generate download token
  const downloadToken = nanoid(32);
  await env.KV.put(`dl:${downloadToken}`, JSON.stringify({ version }), {
    expirationTtl: 86400,
  });
  const workerUrl = new URL(request.url).origin;
  const downloadUrl = `${workerUrl}/api/download/${downloadToken}`;

  // Update session KV with download URL
  await env.KV.put(`session:${sessionId}`, JSON.stringify({ key, downloadUrl }), {
    expirationTtl: 86400,
  });

  // Send email via Resend (retry once on failure)
  const siteUrl = "https://openclaw.apptah.com";
  const emailBody = JSON.stringify({
    from: "OpenClaw Memory Stack <noreply@apptah.com>",
    to: [email],
    subject: "🎉 Your OpenClaw Memory Stack is ready!",
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:32px 40px;text-align:center">
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px">🦀 OpenClaw Memory Stack</h1>
          <p style="margin:8px 0 0;color:#a0aec0;font-size:14px">Thank you for your purchase!</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 40px">

          <!-- Greeting -->
          <p style="margin:0 0 20px;font-size:16px;color:#2d3748;line-height:1.6">
            Hey there! 👋<br>
            Your copy of OpenClaw Memory Stack is ready to download. Here's everything you need to get started.
          </p>

          <!-- License Key -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px">
            <tr><td style="padding:16px 20px">
              <p style="margin:0 0 4px;font-size:12px;color:#718096;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">🔑 Your License Key</p>
              <code style="font-size:14px;color:#1a202c;word-break:break-all">${key}</code>
            </td></tr>
          </table>

          <!-- Download Button -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px">
            <tr><td align="center">
              <a href="${downloadUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:16px;font-weight:600;letter-spacing:-0.2px">
                ⬇️ Download Now
              </a>
            </td></tr>
          </table>
          <p style="margin:0 0 28px;text-align:center;font-size:13px;color:#a0aec0">
            ⏳ This link expires in <strong style="color:#718096">24 hours</strong>
          </p>

          <!-- Divider -->
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 24px">

          <!-- How to Use -->
          <h2 style="margin:0 0 6px;font-size:16px;color:#1a202c;font-weight:700">🚀 How to use</h2>
          <p style="margin:0 0 16px;font-size:13px;color:#718096;line-height:1.5">
            Psst — you can also just paste this email into OpenClaw and it'll set everything up for you. Magic! 🪄
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
            <tr>
              <td style="padding:10px 0;vertical-align:top;width:32px">
                <span style="display:inline-block;width:24px;height:24px;background:#ebf5ff;color:#2563eb;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700">1</span>
              </td>
              <td style="padding:10px 0 10px 12px;font-size:14px;color:#4a5568;line-height:1.5">
                Download and unzip the file
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0;vertical-align:top;width:32px">
                <span style="display:inline-block;width:24px;height:24px;background:#ebf5ff;color:#2563eb;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700">2</span>
              </td>
              <td style="padding:10px 0 10px 12px;font-size:14px;color:#4a5568;line-height:1.5">
                Run the installer:<br>
                <code style="display:inline-block;margin-top:4px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:4px;padding:4px 10px;font-size:13px;color:#2d3748">./install.sh --key=${key}</code>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0;vertical-align:top;width:32px">
                <span style="display:inline-block;width:24px;height:24px;background:#ebf5ff;color:#2563eb;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700">3</span>
              </td>
              <td style="padding:10px 0 10px 12px;font-size:14px;color:#4a5568;line-height:1.5">
                Restart OpenClaw:<br>
                <code style="display:inline-block;margin-top:4px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:4px;padding:4px 10px;font-size:13px;color:#2d3748">openclaw gateway restart</code>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0;vertical-align:top;width:32px">
                <span style="display:inline-block;width:24px;height:24px;background:#ebf5ff;color:#2563eb;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700">4</span>
              </td>
              <td style="padding:10px 0 10px 12px;font-size:14px;color:#4a5568;line-height:1.5">
                That's it — just chat with OpenClaw as usual. Memory Stack works behind the scenes automatically. ✨
              </td>
            </tr>
          </table>

          <!-- Updates note -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
            <tr><td style="padding:14px 20px">
              <p style="margin:0 0 4px;font-size:12px;color:#15803d;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">🔄 Automatic Updates</p>
              <p style="margin:0;font-size:13px;color:#166534;line-height:1.5">
                Memory Stack checks for new versions automatically. When an update is available, you'll see a prompt with a single command to run. Bug fixes within your version are always free.
              </p>
            </td></tr>
          </table>

          <!-- Divider -->
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 24px">

          <!-- Help links -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:8px 0;font-size:14px;color:#4a5568">
                📖 <a href="${siteUrl}/docs/quickstart" style="color:#2563eb;text-decoration:none;font-weight:500">Full documentation</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;font-size:14px;color:#4a5568">
                🔄 Need to re-download? Visit the <a href="${siteUrl}/manage" style="color:#2563eb;text-decoration:none;font-weight:500">Manage License</a> page
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;font-size:14px;color:#4a5568">
                💬 Questions? Reply to this email — we read every message
              </td>
            </tr>
          </table>

        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f7fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0">
          <p style="margin:0;font-size:12px;color:#a0aec0;line-height:1.5">
            © ${new Date().getFullYear()} OpenClaw · Made with 🤍 for developers
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
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
