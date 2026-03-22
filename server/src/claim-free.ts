import { Env, jsonResponse, errorResponse, nanoid, LicenseData, toMinor } from "./utils";

const PROMO_DEADLINE = new Date("2026-03-29T23:59:59Z");

export async function handleClaimFree(request: Request, env: Env): Promise<Response> {
  // Check promo still active
  if (new Date() > PROMO_DEADLINE) {
    return errorResponse("Early bird promotion has ended. Purchase at https://openclaw-memory.apptah.com", 410);
  }

  const body = (await request.json()) as { email?: string };
  if (!body.email || !body.email.includes("@")) {
    return errorResponse("Valid email is required");
  }

  const email = body.email.trim().toLowerCase();

  // Prevent duplicate claims
  const existingClaim = await env.KV.get(`claim:${email}`);
  if (existingClaim) {
    return jsonResponse({ already_claimed: true, message: "You already claimed your free license. Check your email." });
  }

  // Generate license key
  const key = `oc-starter-${nanoid(24)}`;
  const version = "0.1.5";

  // Store license (same as paid starter — permanent)
  const license: LicenseData = {
    tier: "starter",
    email,
    created_at: new Date().toISOString(),
    active: true,
    version,
    purchased_minor: toMinor(version),
    devices: [],
    max_devices: parseInt(env.MAX_DEVICES, 10),
  };
  await env.KV.put(`license:${key}`, JSON.stringify(license));

  // Mark email as claimed
  await env.KV.put(`claim:${email}`, key);

  // Send email with install command
  const installCmd = `curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | bash -s -- --key=${key}`;

  const emailBody = JSON.stringify({
    from: "OpenClaw Memory Stack <noreply@apptah.com>",
    to: [email],
    subject: "🎉 Your free OpenClaw Memory Stack is ready!",
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
        <tr><td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:32px 40px;text-align:center">
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700">🦀 OpenClaw Memory Stack</h1>
          <p style="margin:8px 0 0;color:#00e676;font-size:14px;font-weight:600">🎁 Early Bird — Free Forever</p>
        </td></tr>
        <tr><td style="padding:32px 40px">
          <p style="margin:0 0 20px;font-size:16px;color:#2d3748;line-height:1.6">
            Hey there! 👋<br>
            You claimed your free copy of OpenClaw Memory Stack. Here's your license key and install command.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px">
            <tr><td style="padding:16px 20px">
              <p style="margin:0 0 4px;font-size:12px;color:#718096;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">🔑 Your License Key</p>
              <code style="font-size:14px;color:#1a202c;word-break:break-all">${key}</code>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#1a1a2e;border-radius:8px;overflow:hidden">
            <tr><td style="padding:16px 20px">
              <p style="margin:0 0 8px;font-size:12px;color:#a0aec0;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">📋 Install Command (copy & paste into terminal)</p>
              <code style="font-size:13px;color:#00e676;word-break:break-all;line-height:1.6">${installCmd}</code>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
            <tr>
              <td style="padding:10px 0;vertical-align:top;width:32px">
                <span style="display:inline-block;width:24px;height:24px;background:#ebf5ff;color:#2563eb;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700">1</span>
              </td>
              <td style="padding:10px 0 10px 12px;font-size:14px;color:#4a5568;line-height:1.5">
                Open your terminal and paste the install command above
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0;vertical-align:top;width:32px">
                <span style="display:inline-block;width:24px;height:24px;background:#ebf5ff;color:#2563eb;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700">2</span>
              </td>
              <td style="padding:10px 0 10px 12px;font-size:14px;color:#4a5568;line-height:1.5">
                That's it — OpenClaw restarts automatically. Memory Stack works behind the scenes. ✨
              </td>
            </tr>
          </table>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 24px">
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
            <tr><td style="padding:14px 20px">
              <p style="margin:0 0 4px;font-size:12px;color:#15803d;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">🔄 Automatic Updates</p>
              <p style="margin:0;font-size:13px;color:#166534;line-height:1.5">
                Memory Stack checks for new versions automatically. Updates install in the background — no action needed.
              </p>
            </td></tr>
          </table>
          <p style="margin:0;font-size:14px;color:#4a5568">💬 Questions? Reply to this email — we read every message</p>
        </td></tr>
        <tr><td style="background:#f7fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0">
          <p style="margin:0;font-size:12px;color:#a0aec0">© 2026 OpenClaw · Made with 🤍 for developers</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
    `,
  });

  let emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: emailBody,
  });

  if (!emailRes.ok) {
    await new Promise((r) => setTimeout(r, 2000));
    emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: emailBody,
    });
  }

  console.log("Free license claimed", { email, key_prefix: key.slice(0, 12) + "..." });

  return jsonResponse({
    success: true,
    message: "License key sent to your email! Check your inbox.",
  });
}
