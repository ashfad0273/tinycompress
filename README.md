# TinyCompress

Bulk image compressor and converter using your TinyPNG API keys. Run it on your own computer, or publish it on Cloudflare.

## Run locally

Double-click `start.bat`, or run `npm start` and open http://127.0.0.1:4711. Requires Node 22.2 or newer. There is nothing to install.

1. Paste your API keys. Get them at https://tinify.com/developers.
2. Pick the output formats: AVIF (the default), WebP, PNG or same as source.
3. Drop images or whole folders, then press Start.

Results go to `output/<date_time>/` with your folder structure kept.

## Publish on Cloudflare

In the Cloudflare dashboard, go to Workers & Pages → Create application, connect this GitHub repository, and keep the suggested settings: an empty build command and `npx wrangler deploy` as the deploy command. Every push to the main branch redeploys automatically.

It also works as a Cloudflare Pages project: leave the build command empty and set the build output directory to `public`.

There is nothing else to configure. Each visitor adds their own keys, which stay in their own browser.

How it differs from the local version:

- **Keys:** saved in the browser's local storage rather than `data/keys.json`.
- **Results:** kept in the tab until you download the ZIP. In Chrome and Edge you can choose to save straight to a folder instead, which is better for very large batches.
- **Privacy:** images and keys pass through a Cloudflare function on the way to TinyPNG. It only forwards them and stores nothing.
- **Limits on the free plan:** 100 MB per image and 100,000 function requests a day, shared by everyone using your site. Each TinyPNG call is one request, so AVIF from a PNG or JPEG uses about 2 per image.

To try it locally with Cloudflare's runtime:

```bash
npx wrangler dev
```

## No limits

The local app doesn't cap how many images you queue or how big they are, and ZIP downloads have no size or file-count cap. Up to 5 images are worked on at the same moment, because browsers allow only about 6 connections to a site, and the rest wait their turn.

## How keys are used

- Keys are used in the order you added them. When one reaches its limit, the app moves to the next automatically, even in the middle of an image.
- If every key runs out, the batch pauses. Add a key and it continues by itself.
- Limits reset each calendar month, and the app picks exhausted keys back up on its own.

## Compression costs

Each image costs 1 compression, plus 1 for each conversion to a different format. A PNG exported as PNG, WebP and AVIF costs 3.

## Privacy (local version)

The server listens only on this computer and refuses requests from other websites. Keys are saved unencrypted in `data/keys.json`. Images are sent only to TinyPNG (`api.tinify.com`), which does the compression.

## Settings

Set these as environment variables: `PORT`, `OUTPUT_DIR`, `DATA_DIR`.

## Tests

`npm test` runs the app against a fake TinyPNG API, so no compressions are used.
