import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandbox, probeDocker } from '../src/agent/sandbox.ts';

const run = promisify(execFile);
const IMAGE = process.env.RUNNER_SANDBOX_TEST_IMAGE ?? 'redis:7-alpine'; // já existe localmente; nada é baixado

describe('DockerSandbox: argumentos (sem Docker)', () => {
  const sb = new DockerSandbox({ image: 'img:1' });
  const args = sb.buildArgs('n1', { command: 'echo oi', root: '/w', writable: false, network: false });
  const joined = args.join(' ');

  it('aplica todas as restrições por padrão', () => {
    expect(joined).toContain('--network none');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('no-new-privileges');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--user 1000:1000');
    expect(joined).toContain('--pids-limit');
    expect(joined).toContain('--memory 512m');
    expect(args).not.toContain('--privileged');
    expect(args.some((a) => /docker\.sock/.test(a))).toBe(false);
  });
  it('workspace somente leitura por padrão; escrita e rede só quando pedidas', () => {
    expect(joined).toMatch(/target=\/workspace,readonly/);
    const w = sb.buildArgs('n2', { command: 'x', root: '/w', writable: true, network: true }).join(' ');
    expect(w).not.toMatch(/readonly/);
    expect(w).toContain('--network bridge');
  });
  it('o comando vai como um único argumento (sem interpolação no host)', () => {
    const a = sb.buildArgs('n3', { command: 'echo "$(whoami)"; rm -rf /', root: '/w', writable: false, network: false });
    expect(a.at(-1)).toBe('echo "$(whoami)"; rm -rf /');
    expect(a.at(-2)).toBe('-c');
  });
  it('opções indefinidas não apagam os limites padrão', () => {
    const s = new DockerSandbox({ image: 'i', memory: undefined, cpus: undefined, pidsLimit: undefined });
    const a = s.buildArgs('n', { command: 'x', root: '/w', writable: false, network: false }).join(' ');
    expect(a).toContain('--memory 512m');
    expect(a).toContain('--cpus 1');
    expect(a).toContain('--pids-limit 128');
    expect(a).not.toContain('undefined');
  });
  it('recusa caminho com vírgula ou quebra de linha (injeção de opção do --mount)', () => {
    expect(() => sb.buildArgs('n4', { command: 'x', root: '/w,readonly=false,source=/', writable: false, network: false })).toThrow(/caracteres/);
    expect(() => sb.buildArgs('n5', { command: 'x', root: '/w\n', writable: false, network: false })).toThrow();
  });
});

describe('DockerSandbox: contêiner real', async () => {
  const probe = await probeDocker(IMAGE);
  const d = probe.available ? describe : describe.skip;
  if (!probe.available) console.warn(`[sandbox] testes com Docker ignorados: ${probe.reason}`);

  d('com Docker', () => {
    let dir: string;
    const sb = new DockerSandbox({ image: IMAGE, pidsLimit: 64, memory: '256m' });
    const signal = () => new AbortController().signal;
    const go = (command: string, o: Partial<{ writable: boolean; network: boolean; timeoutMs: number; signal: AbortSignal; maxOutputBytes: number }> = {}) =>
      sb.run({ command, root: dir, writable: false, network: false, timeoutMs: 30_000, signal: signal(), ...o });

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ca-sbx-test-'));
      await writeFile(join(dir, 'a.txt'), 'conteudo', 'utf8');
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('executa e devolve stdout e código de saída', async () => {
      const r = await go('cat /workspace/a.txt; exit 3');
      expect(r.stdout.trim()).toBe('conteudo');
      expect(r.exitCode).toBe(3);
    });

    it('roda como usuário comum', async () => {
      expect((await go('id -u')).stdout.trim()).toBe('1000');
    });

    it('não tem rede', async () => {
      const r = await go('wget -T 3 -q -O- http://1.1.1.1/ 2>&1; echo code=$?');
      expect(r.stdout).not.toMatch(/code=0/);
      expect((await go('ls /sys/class/net')).stdout.trim()).toBe('lo');
    });

    it('workspace é somente leitura por padrão: escrever falha e o arquivo não aparece no host', async () => {
      const r = await go('echo x > /workspace/novo.txt');
      expect(r.exitCode).not.toBe(0);
      await expect(readFile(join(dir, 'novo.txt'))).rejects.toThrow();
    });

    it('com writable=true a escrita chega ao host', async () => {
      const r = await go('echo ola > /workspace/gravado.txt', { writable: true });
      expect(r.exitCode).toBe(0);
      expect((await readFile(join(dir, 'gravado.txt'), 'utf8')).trim()).toBe('ola');
    });

    it('sistema de arquivos raiz é somente leitura', async () => {
      expect((await go('touch /etc/x')).exitCode).not.toBe(0);
    });

    it('variáveis do host (segredos) não existem lá dentro', async () => {
      process.env.CA_SEGREDO_TESTE = 'nao-pode-vazar';
      try {
        const r = await go('env');
        expect(r.stdout).not.toContain('nao-pode-vazar');
        expect(r.stdout).not.toContain('CA_SEGREDO_TESTE');
      } finally {
        delete process.env.CA_SEGREDO_TESTE;
      }
    });

    it('interrompe por tempo, devolve timedOut e remove o contêiner', async () => {
      const r = await go('sleep 60', { timeoutMs: 2000 });
      expect(r.timedOut).toBe(true);
      expect(r.durationMs).toBeLessThan(15_000);
      // O contêiner é removido de forma assíncrona: espera por condição (até 20 s) em vez de um tempo fixo, que falhava com o Docker ocupado.
      let leftover = 'x';
      for (let i = 0; i < 40 && leftover !== ''; i++) {
        leftover = (await run('docker', ['ps', '-a', '--filter', 'name=ca-sbx-', '--format', '{{.Names}}'], { windowsHide: true })).stdout.trim();
        if (leftover !== '') await new Promise((res) => setTimeout(res, 500));
      }
      expect(leftover).toBe('');
    }, 40_000);

    it('cancelamento pelo signal interrompe o comando', async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 1500);
      const r = await go('sleep 60', { signal: ac.signal });
      expect(r.aborted).toBe(true);
      expect(r.durationMs).toBeLessThan(15_000);
    }, 40_000);

    it('limita a saída e avisa que cortou', async () => {
      const r = await go('yes aaaaaaaaaa | head -c 500000', { maxOutputBytes: 2000 });
      expect(r.truncated).toBe(true);
      expect(r.stdout.length).toBeLessThanOrEqual(2000);
    });

    it('limite de processos e de memória estão ativos no cgroup do contêiner', async () => {
      const r = await go('cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.max');
      expect(r.stdout.trim().split(/\s+/)).toEqual(['64', String(256 * 1024 * 1024)]);
    });

    it('uma bomba de fork não derruba nada: o contêiner termina e some', async () => {
      const r = await go('while :; do sleep 30 & done', { timeoutMs: 6000 });
      expect(r.timedOut || r.exitCode !== 0).toBe(true);
      expect(r.durationMs).toBeLessThan(30_000);
      // O contêiner é removido de forma assíncrona: espera por condição (até 20 s) em vez de um tempo fixo, que falhava com o Docker ocupado.
      let leftover = 'x';
      for (let i = 0; i < 40 && leftover !== ''; i++) {
        leftover = (await run('docker', ['ps', '-a', '--filter', 'name=ca-sbx-', '--format', '{{.Names}}'], { windowsHide: true })).stdout.trim();
        if (leftover !== '') await new Promise((res) => setTimeout(res, 500));
      }
      expect(leftover).toBe('');
    }, 60_000);
  });
});
