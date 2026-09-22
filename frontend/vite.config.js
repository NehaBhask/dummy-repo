import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev (npm run dev, :5173) API calls are proxied to the backend on :3000.
// In production the backend serves the built app itself (npm run build, then npm start in backend/).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
