# Hippo Maze — Landing Page

Redirect + share page for Hippo Maze challenge links.

Handles URLs of the form:

```
https://<host>/?c=<payload>
https://<host>/c/<payload>
```

On mobile it auto-opens the `hippomaze://challenge?c=<payload>` deeplink. On desktop it shows a QR code so you can scan the same URL with your phone. Falls back to App Store / Play Store buttons if the app isn't installed.

## Payload format

`<payload>` is either:

- A raw HM1 level code (e.g. `HM1-H4sIAAA...`), or
- `base64url(gzip(JSON))` where the JSON has:
  ```json
  {
    "c":  "HM1-...",     // level code (required)
    "s":  150,           // score target (optional)
    "n":  "Alice",       // sender nickname (optional, may be empty)
    "id": "ab12cd"       // challenge id (optional)
  }
  ```

The app understands the same format.

## Deployment

### Cloudflare Pages (recommended — free, unlimited bandwidth)

1. Push this folder to a GitHub repo.
2. In Cloudflare dashboard → Pages → Create project → Connect to Git.
3. Pick the repo. Build settings: **none** (static site).
4. Done. Gets `https://<project>.pages.dev` for free.
5. `_redirects` file handles `/c/*` routing automatically.

### GitHub Pages

1. Push to a GitHub repo (name it whatever).
2. Repo → Settings → Pages → Source: `Deploy from a branch` → `main` / `/ (root)`.
3. Wait ~1 min. Gets `https://<user>.github.io/<repo>/`.
4. `/c/*` routing is handled by `404.html` (GitHub Pages serves it on unknown paths; it redirects back to `/?c=`).

### Custom domain (optional)

Buy a domain (~$10/yr) and point it at Cloudflare Pages or GitHub Pages via a `CNAME` record. Update the `APP_STORE_URL` / `PLAY_STORE_URL` constants in `index.html` once the app has real store URLs.

## Android App Links (autoVerify)

`/.well-known/assetlinks.json` tells Android to open `https://<host>/c/*` URLs
directly in the app instead of the browser. The file ships with a placeholder
SHA256 — replace it before deploying:

```bash
# Release keystore fingerprint:
keytool -list -v -keystore release.keystore -alias <alias> | grep SHA256
# Copy the colon-separated hex (e.g. AB:CD:…) into assetlinks.json.
```

Verify after deploy:

```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<host>&relation=delegate_permission/common.handle_all_urls
```

Must be served as `application/json` — Cloudflare Pages and GitHub Pages do this
automatically for `.json` files.

## Development

Just open `index.html` in a browser. No build step, no dependencies.

Test a challenge URL locally:

```
file:///path/to/index.html?c=HM1-EXAMPLE
```

Or with a compressed payload (base64url of gzipped JSON):

```
file:///path/to/index.html?c=eJyrVspOzSvJTFHSUcouLS5OTbGysFIKLc...
```
