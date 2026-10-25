import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const target = process.env.HEYUNA_API_URL ?? 'http://127.0.0.1:8765';
const localURL = new URL(target);
if (localURL.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(localURL.hostname) || localURL.username || localURL.password) {
  throw new Error('HEYUNA_API_URL must be a loopback HTTP service.');
}

export default defineConfig({
  plugins: [react(), {
    name: 'local-preview-boundary',
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        const host = req.headers.host ?? ''; 
        const origin = req.headers.origin;
        if (!['127.0.0.1:1420', 'localhost:1420'].includes(host) || (origin && !['http://127.0.0.1:1420', 'http://localhost:1420'].includes(origin))) {
          res.statusCode = 403; res.end('Loopback preview only'); return;
        }
        if (!process.env.HEYUNA_LOCAL_TOKEN) {
          res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ detail: '本地服务未配置。请在启动开发预览前设置 HEYUNA_LOCAL_TOKEN；凭据只在代理服务器使用。' })); return;
        }
        next();
      });
    },
  }],
  server: {
    host: '127.0.0.1', port: 1420, strictPort: true,
    proxy: { '/api': { target, changeOrigin: true, headers: { Authorization: `Bearer ${process.env.HEYUNA_LOCAL_TOKEN ?? ''}` } } },
  },
  clearScreen: false,
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], include: ['tests/**/*.test.ts?(x)'] },
});
