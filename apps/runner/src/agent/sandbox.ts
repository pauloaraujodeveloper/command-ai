import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SandboxRunOptions {
  command: string;
  /** Pasta do workspace, montada em /workspace. */
  root: string;
  /** Monta o workspace com escrita. Padrão do agente: somente leitura. */
  writable: boolean;
  /** Dá rede ao contêiner. Padrão: nenhuma. */
  network: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  /** Limite por fluxo (stdout e stderr). */
  maxOutputBytes?: number;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface Sandbox {
  run(opts: SandboxRunOptions): Promise<SandboxResult>;
}

export interface DockerSandboxOptions {
  /** Imagem com `sh`. Nunca é baixada automaticamente: quem decide é a pessoa (`docker pull`). */
  image: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  docker?: string;
}

/** Variáveis que o cliente do Docker precisa. O ambiente do Runner (chaves de API etc.) NÃO entra no contêiner. */
function dockerCliEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'TEMP', 'TMP'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/** O Docker está de pé e a imagem existe localmente? Não baixa nada. */
export async function probeDocker(image: string, docker = 'docker'): Promise<{ available: boolean; reason?: string }> {
  try {
    await execFileAsync(docker, ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000, windowsHide: true, env: dockerCliEnv() });
  } catch {
    return { available: false, reason: 'Docker indisponível (não instalado ou parado)' };
  }
  try {
    await execFileAsync(docker, ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 10_000, windowsHide: true, env: dockerCliEnv() });
  } catch {
    return { available: false, reason: `imagem ${image} não encontrada localmente (rode: docker pull ${image})` };
  }
  return { available: true };
}

/**
 * Executa comandos do agente num contêiner descartável e restrito. Nunca no host.
 * Restrições: sem rede, sem privilégios (cap-drop ALL, no-new-privileges), usuário comum, raiz somente leitura,
 * /tmp pequeno em memória, limites de memória/CPU/processos, tempo máximo, saída limitada, nenhuma variável do host.
 */
export class DockerSandbox implements Sandbox {
  private readonly o: Required<DockerSandboxOptions>;

  constructor(opts: DockerSandboxOptions) {
    // Valores ausentes (undefined, vindos de variáveis de ambiente não definidas) não podem apagar os padrões seguros.
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    this.o = { memory: '512m', cpus: '1', pidsLimit: 128, docker: 'docker', ...given } as Required<DockerSandboxOptions>;
  }

  /** Argumentos do `docker run` (exposto para teste). */
  buildArgs(name: string, opts: Pick<SandboxRunOptions, 'command' | 'root' | 'writable' | 'network'>): string[] {
    // --mount usa vírgula como separador: um caminho com vírgula (ou quebra de linha) seria injeção de opção.
    if (/[,\r\n]/.test(opts.root)) throw new Error('caminho do workspace contém caracteres não suportados pelo sandbox');
    return [
      'run', '--rm', '--init', '--name', name,
      '--network', opts.network ? 'bridge' : 'none',
      '--memory', this.o.memory, '--memory-swap', this.o.memory,
      '--cpus', this.o.cpus,
      '--pids-limit', String(this.o.pidsLimit),
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,size=64m',
      '--user', '1000:1000',
      '-e', 'HOME=/tmp',
      '--mount', `type=bind,source=${opts.root},target=/workspace${opts.writable ? '' : ',readonly'}`,
      '--workdir', '/workspace',
      // Ignora o ENTRYPOINT da imagem: o que roda é sempre `sh -c <comando>`.
      '--entrypoint', 'sh',
      this.o.image,
      '-c', opts.command,
    ];
  }

  async run(opts: SandboxRunOptions): Promise<SandboxResult> {
    const name = `ca-sbx-${randomBytes(6).toString('hex')}`;
    const cap = opts.maxOutputBytes ?? 32_768;
    const args = this.buildArgs(name, opts);
    const started = Date.now();

    return new Promise<SandboxResult>((resolve) => {
      const child = spawn(this.o.docker, args, { windowsHide: true, env: dockerCliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let aborted = false;

      const take = (current: string, chunk: Buffer): string => {
        if (current.length >= cap) {
          truncated = true;
          return current; // continua lendo (para não travar o pipe), mas descarta
        }
        const next = current + chunk.toString('utf8');
        if (next.length > cap) {
          truncated = true;
          return next.slice(0, cap);
        }
        return next;
      };
      child.stdout.on('data', (c: Buffer) => (stdout = take(stdout, c)));
      child.stderr.on('data', (c: Buffer) => (stderr = take(stderr, c)));

      const kill = () => {
        // Mata o contêiner (o `docker run` do cliente sozinho não garante parar o processo lá dentro).
        execFile(this.o.docker, ['kill', name], { windowsHide: true, env: dockerCliEnv() }, () => undefined);
        setTimeout(() => child.kill(), 1500).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
      const onAbort = () => {
        aborted = true;
        kill();
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number | null) => {
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', onAbort);
        if (timedOut || aborted) execFile(this.o.docker, ['rm', '-f', name], { windowsHide: true, env: dockerCliEnv() }, () => undefined);
        resolve({ exitCode, stdout, stderr, timedOut, aborted, truncated, durationMs: Date.now() - started });
      };
      child.on('error', (err) => {
        stderr += `\n[sandbox] falha ao iniciar o Docker: ${err.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }
}
