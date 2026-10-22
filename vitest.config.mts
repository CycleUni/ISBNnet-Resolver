import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': path.join(import.meta.dirname, 'test/stubs/cloudflare-workers.ts') },
  },
});
