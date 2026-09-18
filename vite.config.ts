import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
// This UI prototype is static and needs no host or Cloudflare runtime.
export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    watch: { useFsEvents: false, usePolling: true },
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  plugins: [vinext()],
});
