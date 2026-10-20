# TypeMyFile

Upload a `.txt`, `.pdf`, `.docx` or `.doc` file and practise typing its text. Tracks net WPM, raw WPM, accuracy, errors and time.

## How it's built (and why it's safe)

It's a **static, client-side site**: no server code, no database, no accounts. Files are read inside the visitor's browser and are never uploaded. That removes the biggest risks a file-upload site has (stored malware, leaked files, server breaches) and keeps privacy-law obligations minimal.

| Protection | Where |
|---|---|
| Strict Content Security Policy (only this site's own scripts can run; no inline or third-party code) | `index.html` `<meta>` + `site/_headers` |
| Document text shown with `textContent`, never `innerHTML` (an HTML/script-laden file can't execute) | `app.js` `renderPassage` |
| File type checked by magic bytes, 10 MB size cap, 2-million-character text cap, 3,000-page PDF cap; only the text near the cursor is drawn on the page | `app.js` `handleFile` |
| PDF.js run with `isEvalSupported: false` in a Web Worker (blocks the CVE-2024-4367 class of attack) | `app.js` `readPdf` |
| Libraries self-hosted, installed with `--ignore-scripts` | `setup-vendor.ps1` |
| HSTS, clickjacking protection (`frame-ancestors`/`X-Frame-Options`), `nosniff`, no referrer, Permissions-Policy | `site/_headers` |

## Setup

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. Run `setup-vendor.ps1` once to put PDF.js and Mammoth into `site/vendor/`.
3. Preview locally: `npx serve site` (or any static server), then open the URL it prints. Opening `index.html` directly from disk won't work, because browsers block ES modules on `file://`.

## Deploying

Upload the `site/` folder to a static host that serves HTTPS, such as **Netlify** or **Cloudflare Pages** (both read `_headers` automatically). On GitHub Pages you can't set headers, so the `<meta>` CSP still applies but HSTS and frame-blocking won't.

## Before going live: legal checklist

- [ ] Replace every `[PLACEHOLDER]` in `privacy.html` and `terms.html` (your name, contact email, host, governing law).
- [ ] If you add analytics, ads, or a login later, **update the privacy policy**. In the EU/UK you'd also need a cookie consent banner.
- [ ] Keep the license files in `site/vendor/` (required by the PDF.js and Mammoth licenses).
- [ ] Update the libraries now and then (re-run the setup script with newer versions) to pick up security fixes.
- [ ] This is a sensible starting point, not legal advice. If you plan to make money from the site or serve a particular country, have a lawyer review it.

## Known limits

- Scanned PDFs (images with no text layer) contain no text to extract.
- Old binary `.doc` files are read on a best-effort basis. Saving them as `.docx` gives cleaner text.
