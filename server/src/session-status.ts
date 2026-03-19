import { Env, jsonResponse, errorResponse } from "./utils";

export async function handleSessionStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return errorResponse("Missing session_id", 400);

  const data = await env.KV.get(`session:${sessionId}`);
  if (!data) return jsonResponse({ ready: false });

  const { key, downloadUrl } = JSON.parse(data);
  return jsonResponse({ ready: true, key, downloadUrl });
}
