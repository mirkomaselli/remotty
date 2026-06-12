import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // HTTP + WS verso il server @remotty/server
      '/api': { target: 'http://localhost:7710', ws: true, changeOrigin: false },
    },
  },
});
