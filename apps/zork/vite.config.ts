import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  // The interpreter is consumed as TypeScript source from the workspace rather
  // than as a build artefact, so there is no build step to keep in sync.
  optimizeDeps: { exclude: ['@deuce/zmachine'] },
});
