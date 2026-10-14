import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
process.env.TZ = 'Asia/Shanghai';
export default defineConfig({
  resolve: { alias: { obsidian: fileURLToPath(new URL('./tests/obsidian-mock.ts', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
});
