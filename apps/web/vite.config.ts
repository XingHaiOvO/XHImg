import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3801,
    proxy: {
      '/api': 'http://localhost:9521',
      '/i/': 'http://localhost:9521',
      '/t/': 'http://localhost:9521',
      '/health': 'http://localhost:9521',
    },
  },
});
