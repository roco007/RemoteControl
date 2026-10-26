import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['shared/**/*.test.ts', 'transmitter/**/*.test.ts'], environment: 'node' } });
