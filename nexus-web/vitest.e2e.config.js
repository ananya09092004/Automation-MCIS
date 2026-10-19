import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Live end-to-end suite: the real Nexus UI against a RUNNING backend.
// Needs NEXUS_E2E_API_URL, NEXUS_E2E_OWNER_TOKEN, NEXUS_E2E_MEMBER_TOKEN (see e2e/README.md).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['e2e/**/*.e2e.test.jsx'],
    setupFiles: ['./src/__tests__/setup.js'],
    globals: true,
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
