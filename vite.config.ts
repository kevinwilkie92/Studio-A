import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` runs Vite and `wrangler dev` side by side; API calls are
    // proxied to the Worker so cookies and relative fetches just work.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/webhooks': 'http://127.0.0.1:8787',
    },
  },
  resolve: {
    alias: { '@shared': new URL('./src/shared', import.meta.url).pathname },
  },
})
