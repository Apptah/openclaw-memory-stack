import { Env, jsonResponse, errorResponse } from "./utils";

export async function handleCheckout(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { success_url?: string; cancel_url?: string };

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "mode": "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": "OpenClaw Memory Stack — Starter",
      "line_items[0][price_data][unit_amount]": "4900",
      "line_items[0][quantity]": "1",
      "payment_method_types[0]": "card",
      "metadata[tier]": "starter",
      "metadata[version]": "0.1.0",
      "success_url": body.success_url ?? "https://openclaw-site-53r.pages.dev/thanks",
      "cancel_url": body.cancel_url ?? "https://openclaw-site-53r.pages.dev",
    }),
  });

  const session = (await response.json()) as { id: string; url: string };
  return jsonResponse({ checkout_url: session.url });
}
