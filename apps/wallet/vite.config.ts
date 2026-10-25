import { defineConfig } from 'vite';

const headers = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 1421, strictPort: true, cors: false, headers },
  preview: { host: '127.0.0.1', port: 1421, strictPort: true, headers },
  build: { sourcemap: false },
});
