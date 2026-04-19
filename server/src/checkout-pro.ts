import { Env, jsonResponse, errorResponse, LicenseData } from "./utils";

export async function handleCheckoutPro(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    email?: string;
    success_url?: string;
    cancel_url?: string;
  };

  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return errorResponse("Please enter the email you used to purchase Starter.", 400);
  }

  // Look up license key by email
  const key = await env.KV.get(`email:${email}`);
  if (!key) return errorResponse("No Starter license found for this email. Purchase Starter first.", 404);

  // Verify the license exists and is active
  const raw = await env.KV.get(`license:${key}`);
  if (!raw) return errorResponse("License not found. Contact support.", 404);

  const license: LicenseData = JSON.parse(raw);
  if (!license.active) return errorResponse("License is not active.", 400);
  if (license.tier === "pro") return errorResponse("You're already on Pro!", 400);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "mode": "subscription",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": "OpenClaw Memory Stack — Pro",
      "line_items[0][price_data][unit_amount]": "900",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][quantity]": "1",
      "payment_method_types[0]": "card",
      "customer_email": email,
      "metadata[tier]": "pro",
      "metadata[starter_key]": key,
      "success_url": body.success_url ?? "https://openclaw-memory.apptah.com/thanks?session_id={CHECKOUT_SESSION_ID}&plan=pro",
      "cancel_url": body.cancel_url ?? "https://openclaw-memory.apptah.com",
    }),
  });

  const session = (await response.json()) as { id: string; url: string; error?: { message: string } };
  if (session.error) return errorResponse(session.error.message, 400);
  return jsonResponse({ checkout_url: session.url });
}
