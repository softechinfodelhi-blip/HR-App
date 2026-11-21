import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // In development the API runs on its own port. Proxying keeps the browser on one origin, so no CORS.
  server: { proxy: { '/api': { target: `http://localhost:${process.env.PORT ?? 3000}`, changeOrigin: false } } },
  test: { environment: 'jsdom', css: false, exclude: ['server/**', 'node_modules/**', 'dist/**'] },
});
