import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Store JSON versionado com gravação atômica (tmp + rename).
 * Um arquivo por domínio de dados sob userData/stores.
 * Gravações são serializadas (cadeia de promises, como o Journal) para evitar
 * corrida de tmp/rename no Windows quando dois saves se sobrepõem.
 */
export class JsonStore<T> {
  private readonly filePath: string;
  private cache: T | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    name: string,
    private readonly fallback: T,
  ) {
    this.filePath = join(app.getPath('userData'), 'stores', `${name}.json`);
  }

  async load(): Promise<T> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      // Um save pode ter resolvido ENQUANTO o readFile esperava: o cache dele
      // é mais novo que o arquivo lido — nunca sobrescrever por trás.
      if (this.cache) return this.cache;
      this.cache = { ...this.fallback, ...(JSON.parse(raw) as object) } as T;
    } catch {
      this.cache = this.fallback;
    }
    return this.cache;
  }

  async save(value: T): Promise<void> {
    // Cache atualiza na hora (loads seguintes veem o valor novo); o arquivo
    // sai em fila — um save por vez, cada um com tmp próprio. A promise
    // devolvida REJEITA em falha de disco (o caller precisa saber que não
    // persistiu — ex.: settings com pacing antigo após reiniciar); a cadeia
    // interna engole o erro para não travar os saves seguintes.
    this.cache = value;
    const attempt = this.chain.then(() => this.write(value));
    this.chain = attempt.catch(() => undefined);
    return attempt;
  }

  private async write(value: T): Promise<void> {
    const dir = join(this.filePath, '..');
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
