import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Custo de hash baixo só nos testes (o padrão de produção está em auth.ts e é verificado em password.test.ts).
    setupFiles: ['./test/setup.ts'],
  },
});
