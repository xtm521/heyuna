# Local Inter font provenance

Source: `@fontsource-variable/inter` 5.3.0, pinned in pnpm-lock.yaml. Upstream Inter: https://github.com/rsms/inter (SIL Open Font License 1.1).

The Latin variable WOFF2 (`files/inter-latin-wght-normal.woff2`) is copied byte-for-byte to each app's `public/fonts/InterVariable-latin.woff2`, with the package's `LICENSE` copied as `OFL.txt`. Each app serves its own asset at `/fonts/` so development and packaged builds need no external font request or broad Vite filesystem allowance. Chinese text uses the user's installed system font fallback. Original font names and licensing are retained; no font modification is made.
