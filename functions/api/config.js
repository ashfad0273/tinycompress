// Tells the interface it is on Cloudflare, where keys and results live in the browser.
export function onRequestGet() {
  return Response.json({ mode: 'cloud' });
}
