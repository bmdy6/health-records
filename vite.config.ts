import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/api/ai': 'http://127.0.0.1:18740' } },
  test: { setupFiles: ['./tests/setup.ts'], exclude: ['node_modules/**', 'scripts/**', 'dist/**'] },
});
