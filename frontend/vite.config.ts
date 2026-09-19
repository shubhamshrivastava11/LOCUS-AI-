import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  appType: 'spa',
  build: {
    rollupOptions: {
      output: {
        // Split the dependencies that never change away from the app code
        // that changes on every deploy. This does not make a first visit
        // smaller - the same bytes still arrive - but it means a returning
        // visitor re-downloads only the app chunk instead of React and
        // Supabase again, and it puts the remaining app chunk back under
        // the 500 kB warning line rather than silencing the warning.
        // Rolldown, which Vite 8 builds with, takes only the function form
        // here. An object map typechecks under Rollup and fails here with
        // TS2769.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('@supabase')) return 'supabase'
          // `scheduler` is React's own dependency, so it belongs in the same
          // chunk. Matched on the path segment rather than a bare substring:
          // plenty of unrelated packages have "react" somewhere in their
          // name and would otherwise be dragged in.
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react'
          }
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
