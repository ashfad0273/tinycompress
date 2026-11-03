// Entry point for Cloudflare Workers. Sends API requests to the same handlers Cloudflare Pages
// picks up from functions/, and everything else to the static files in public/.
import { onRequestGet as config } from './functions/api/config.js';
import { onRequest as tinify } from './functions/api/tinify/[[path]].js';

const TINIFY_PREFIX = '/api/tinify/';

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/config' && request.method === 'GET') return config({ env });
    if (pathname.startsWith(TINIFY_PREFIX)) {
      const path = pathname.slice(TINIFY_PREFIX.length).split('/');
      return tinify({ request, env, params: { path } });
    }
    if (pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
