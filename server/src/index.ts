import { Env, errorResponse } from "./utils";
import { handleCheckout } from "./checkout";
import { handleWebhook } from "./webhook";
import { handleActivate } from "./activate";
import { handleVerify } from "./verify";
import { handleResetDevice } from "./reset-device";
import { handleDownloadToken, handleDownload, handleDownloadLatest } from "./download";
import { handleCheckUpdate } from "./check-update";
import { handleRevoke } from "./revoke";
import { handleSessionStatus } from "./session-status";
import { handleInstallScript } from "./install-script";
import { handleClaimFree } from "./claim-free";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    let response: Response;
    try {
      // Route requests
      if (method === "POST" && path === "/api/checkout") {
        response = await handleCheckout(request, env);
      } else if (method === "POST" && path === "/api/webhook") {
        response = await handleWebhook(request, env);
      } else if (method === "POST" && path === "/api/activate") {
        response = await handleActivate(request, env);
      } else if (method === "GET" && path === "/api/verify") {
        response = await handleVerify(request, env);
      } else if (method === "POST" && path === "/api/reset-device") {
        response = await handleResetDevice(request, env);
      } else if (method === "POST" && path === "/api/download-token") {
        response = await handleDownloadToken(request, env);
      } else if (method === "GET" && path === "/api/download/latest") {
        response = await handleDownloadLatest(request, env);
      } else if (method === "GET" && path.startsWith("/api/download/")) {
        response = await handleDownload(request, env);
      } else if (method === "GET" && path === "/api/session-status") {
        response = await handleSessionStatus(request, env);
      } else if (method === "GET" && path === "/api/check-update") {
        response = await handleCheckUpdate(request, env);
      } else if (method === "POST" && path === "/api/revoke") {
        response = await handleRevoke(request, env);
      } else if (method === "GET" && path === "/api/install.sh") {
        response = handleInstallScript(request, env);
      } else if (method === "POST" && path === "/api/claim-free") {
        response = await handleClaimFree(request, env);
      } else {
        response = errorResponse("Not found", 404);
      }
    } catch (err) {
      console.error("Unhandled error:", err);
      response = errorResponse("Internal server error", 500);
    }

    // Add CORS headers to all responses
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  },
} satisfies ExportedHandler<Env>;
