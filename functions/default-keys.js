// Keys the site owner stores in the TINIFY_KEYS Cloudflare secret. They stay on the server:
// the browser only learns how many there are and refers to each one by its position.
export function defaultKeys(env) {
  return String(env.TINIFY_KEYS || '').split(/[\s,;]+/).filter(Boolean);
}
