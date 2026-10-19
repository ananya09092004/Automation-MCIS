import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: /api is proxied to the MCIS backend, so the browser stays same-origin
// (no CORS change needed locally). Production: set VITE_API_URL to the backend
// origin and add this app's origin to the backend's ALLOWED_ORIGINS.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.NEXUS_DEV_API_TARGET || 'http://localhost:5051';
  return {
    plugins: [react()],
    server: { port: 5174, proxy: { '/api': { target, changeOrigin: true } } },
    preview: { port: 4174 },
    build: { sourcemap: false },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{js,jsx}'],
      setupFiles: ['./src/__tests__/setup.js'],
      globals: true,
      css: false,
    },
  };
});
