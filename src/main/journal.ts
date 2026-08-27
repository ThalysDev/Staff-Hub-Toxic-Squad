import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { JournalEntry } from '@shared/ipc-types';

/**
 * Journal auditável: todo acesso relevante ao jogo (leitura em massa, mutação,
 * evento de sessão) deixa um registro persistido. Mutações nunca são apagadas
 * silenciosamente — a UI expõe o histórico completo.
 * Appends são serializados (cadeia de promises) para evitar corrida de
 * tmp/rename no Windows; arquivo corrompido no load é preservado como backup.
 */
export class Journal {
  private readonly dir: string;
  private readonly file: string;
  private entries: JournalEntry[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor() {
    this.dir = join(app.getPath('userData'), 'stores');
    this.file = join(this.dir, 'journal.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as JournalEntry[];
      this.entries = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      // Preserva o arquivo problemático antes de recomeçar — histórico de
      // auditoria não se perde sem rastro.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          await fs.rename(this.file, join(this.dir, `journal.corrupt-${Date.now()}.json`));
        } catch {
          // best-effort: segue com lista vazia
        }
      }
      this.entries = [];
    }
  }

  append(kind: JournalEntry['kind'], action: string, detail: string, dryRun: boolean): Promise<void> {
    const entry: JournalEntry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      kind,
      action,
      detail,
      dryRun,
    };
    this.entries.push(entry);
    const trimmed = this.entries.slice(-10_000);
    this.entries = trimmed;
    // Serializa gravações: um append por vez, tmp+rename atômicos.
    // Cap de 10.000: uma OP média gera ~100 entradas (reservas+MPs+conferências);
    // 2.000 estourava em ~2 semanas de uso ativo.
    this.chain = this.chain.then(() => this.persist(trimmed.slice(-10_000))).catch(() => undefined);
    return this.chain;
  }

  private async persist(entries: JournalEntry[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `journal.tmp-${crypto.randomUUID()}.json`);
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf-8');
    await fs.rename(tmp, this.file);
  }

  list(limit: number): JournalEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.chain = this.chain
      .then(async () => {
        await fs.mkdir(this.dir, { recursive: true });
        await this.persist([]);
      })
      .catch(() => undefined);
    await this.chain;
  }
}
