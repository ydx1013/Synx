import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: 'browser-*.spec.mjs',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'http-server . -a 127.0.0.1 -p 4173 -c-1',
    port: 4173,
    reuseExistingServer: true,
  },
});
