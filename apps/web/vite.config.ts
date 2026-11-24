import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiPort = process.env.WEB_API_PORT ?? '4000';
if (!/^[1-9]\d{0,4}$/.test(apiPort) || Number(apiPort) > 65535)
  throw new Error('Invalid WEB_API_PORT');
const target = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': target, '/health': target },
  },
  preview: { proxy: { '/api': target, '/health': target } },
});
