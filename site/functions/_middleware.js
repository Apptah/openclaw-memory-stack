// Cloudflare Pages middleware — Markdown-for-Agents content negotiation
// If a client sends Accept: text/markdown, serve llms.txt instead of the HTML page

export async function onRequest(context) {
  const { request, next, env } = context;
  const accept = request.headers.get('Accept') || '';
  const url = new URL(request.url);

  // Only intercept the root page for markdown negotiation
  if (
    (url.pathname === '/' || url.pathname === '') &&
    accept.includes('text/markdown')
  ) {
    const mdUrl = new URL('/llms.txt', url.origin);
    const mdRes = await fetch(mdUrl.toString());
    const body = await mdRes.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Vary': 'Accept',
      },
    });
  }

  const response = await next();
  return response;
}
