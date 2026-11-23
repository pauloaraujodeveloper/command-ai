import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Testes com Git e Docker reais: com a suíte inteira rodando em paralelo (e o Docker frio) passam dos 5 s padrão.
    testTimeout: 30_000,
  },
});
