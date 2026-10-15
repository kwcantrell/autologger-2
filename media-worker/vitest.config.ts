import { defineConfig } from 'vitest/config';

// Unit tests (`*.test.ts`, fakes for ffmpeg, the database and statfs) and real-ffmpeg tests
// (`*.ffmpeg.test.ts`), which use `MEDIA_WORKER_TEST_FFMPEG` or `ffmpeg` on PATH, else the pinned
// image through docker when it is already pulled, and skip when neither is available (the #107
// convention, see src/test/ffmpegBin.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
