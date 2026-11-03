import { defaultKeys } from '../default-keys.js';

// Tells the interface it is on Cloudflare, where results live in the browser.
export function onRequestGet({ env }) {
  return Response.json({ mode: 'cloud', defaultKeys: defaultKeys(env).length });
}
