import { defineConfig } from 'vite';

// Relative asset paths so the same build works at the root of a domain and under a
// project path such as https://<user>.github.io/<repo>/.
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 700,   // three.js alone is ~550 kB minified; one chunk is fine for a single page
  },
});
