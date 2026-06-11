import { defineConfig } from 'vitest/config';

// Default `vitest run` covers the mocked unit suite only. The live smoke
// (scripts/smoke.ts) is opt-in and never part of the default test run, so the
// suite is green without a NIMBLE_API_KEY.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
