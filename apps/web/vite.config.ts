import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // O Neon grava NEON_AUTH_BASE_URL em .env.local na raiz do monorepo. Essa URL é pública (o navegador a usa),
  // então só ela é exposta ao código web, com o nome VITE_NEON_AUTH_URL. Nenhum outro segredo passa por aqui.
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  return {
    plugins: [react(), tailwindcss()],
    define: { 'import.meta.env.VITE_NEON_AUTH_URL': JSON.stringify(env.NEON_AUTH_BASE_URL ?? '') },
    server: {
      port: 5173,
      proxy: {
        // Mesma origem para o navegador: cookie de sessão SameSite=Strict e SSE funcionam sem CORS.
        '/api': { target: 'http://127.0.0.1:3011', changeOrigin: false },
      },
    },
  };
});
