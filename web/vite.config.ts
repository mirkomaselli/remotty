import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: process.env.REMOTTY_BASE_PATH || '/remotty/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: process.env.REMOTTY_CAPACITOR_BUILD === '1' ? 'dist-android' : 'dist',
  },
  server: {
    proxy: {
      // HTTP + WS verso il server @remotty/server
      '/api': { target: 'http://localhost:7710', ws: true, changeOrigin: false },
      '/remotty/api': { target: 'http://localhost:7710', ws: true, changeOrigin: false },
    },
  },
});
