import { defineConfig } from 'vite';

// Public read-only genesis endpoint. Do not broaden the renderer to arbitrary URLs.
const cosmosOrigin = new URL(process.env.HEYUNA_COSMOS_RPC_ORIGIN ?? 'http://127.0.0.1:27657');
if (cosmosOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(cosmosOrigin.hostname)
    || cosmosOrigin.username || cosmosOrigin.password || cosmosOrigin.search || cosmosOrigin.hash || cosmosOrigin.pathname !== '/') {
  throw new Error('HEYUNA_COSMOS_RPC_ORIGIN must be a loopback HTTP origin.');
}
const headers = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
export default defineConfig({
  plugins: [{ name: 'public-genesis-csp', transformIndexHtml: { order: 'pre', handler: html => html.replace('__HEYUNA_COSMOS_ORIGIN__', cosmosOrigin.origin) } }],
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 1421, strictPort: true, cors: false, headers },
  preview: { host: '127.0.0.1', port: 1421, strictPort: true, headers },
  build: { sourcemap: false },
});
