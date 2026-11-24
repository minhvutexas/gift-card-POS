import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // One shared throwaway database → run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test', JOBS_ENABLED: 'false', DEFAULT_BUSINESS: 'amazing-salon', PLATFORM_ADMIN_PASSWORD: 'platform-test-pw', SIGNUP_PER_HOUR: '100' },
  },
});
