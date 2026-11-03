// Passes requests from the page to the TinyPNG API, which doesn't accept calls from web pages.
// Nothing is stored: keys come from the visitor's browser on each request, and bodies are
// streamed straight through. Only the two TinyPNG paths the app uses can be reached.
const ALLOWED_PATH = /^(shrink|output\/[\w-]+)$/;
const FORWARDED_HEADERS = ['content-type', 'content-length', 'compression-count', 'image-width', 'image-height'];

function error(status, message) {
  return Response.json({ error: 'Proxy', message }, { status });
}

export async function onRequest({ request, env, params }) {
  const url = new URL(request.url);
  const path = (params.path || []).join('/');
  const method = request.method;

  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return error(403, 'Requests must come from this site');
  if (!ALLOWED_PATH.test(path)) return error(404, 'Not found');
  if (method !== 'POST' && !(method === 'GET' && path !== 'shrink')) return error(405, 'Method not allowed');

  const authorization = request.headers.get('authorization');
  if (!authorization) return error(401, 'Missing API key');

  const headers = { Authorization: authorization };
  const contentType = request.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;

  const base = env.TINIFY_API_URL || 'https://api.tinify.com';
  const upstream = await fetch(`${base}/${path}`, {
    method,
    headers,
    body: method === 'POST' ? request.body : undefined,
    duplex: 'half',
  });

  const responseHeaders = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // The next request for this image has to come back through this function too.
  const location = upstream.headers.get('location');
  if (location) responseHeaders.set('Location', `/api/tinify${new URL(location).pathname}`);

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
