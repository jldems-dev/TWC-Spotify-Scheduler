import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'development-csp-websocket',
      transformIndexHtml(html, context) {
        if (!context.server) return html;
        return html
          .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
          .replace(
          /(connect-src 'self' https:\/\/api\.spotify\.com https:\/\/accounts\.spotify\.com)(;)/,
          '$1 ws://localhost:5173 ws://127.0.0.1:5173$2',
          );
      },
    },
  ],
  base: './',
  publicDir: 'assets',
  // React DOM 18 exposes its browser entry point as CommonJS. Keep it in
  // Vite's dependency optimizer so named imports (createRoot) are converted
  // to browser-compatible ESM instead of serving client.js as-is.
  optimizeDeps: { noDiscovery: true, include: ['react-dom/client'] },
  server: { port: 5173, strictPort: true },
});
