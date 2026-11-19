import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { license?: string }

export default defineConfig({
  server: {
    watch: {
      usePolling: true,
      interval: 150,
    },
    // In dev the API runs separately (npm run dev:server on PORT 3000);
    // proxy /api to it so the client only ever talks to its own origin.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  define: {
    // Injected at build time. Locally (vite dev) these fall back to dev
    // values; the Docker/CI build can pass them as env vars.
    __BUILD_SHA__: JSON.stringify(process.env.COMMIT_SHA || 'dev'),
    __BUILD_TIME__: JSON.stringify(process.env.BUILD_TIME || ''),
    __REPO__: JSON.stringify(process.env.GITHUB_REPOSITORY || 'ackervekenbm/skin-hq'),
    // package.json's `license`; empty ("not chosen yet" in Settings) while none is chosen.
    __LICENSE__: JSON.stringify(pkg.license ?? ''),
  },
  plugins: [react()],
})