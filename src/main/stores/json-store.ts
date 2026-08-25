import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Store JSON versionado com gravação atômica (tmp + rename).
 * Um arquivo por domínio de dados sob userData/stores.
 */
export class JsonStore<T> {
  private readonly filePath: string;
  private cache: T | null = null;

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
      this.cache = { ...this.fallback, ...(JSON.parse(raw) as object) } as T;
    } catch {
      this.cache = this.fallback;
    }
    return this.cache;
  }

  async save(value: T): Promise<void> {
    this.cache = value;
    const dir = join(this.filePath, '..');
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
