// Rede da Suite Vanta: porta os acessos diretos do TW Vanta para o modelo do
// Toxic Squad Hub — MESMA ORIGEM, serializados pelo `enqueue` (≥200ms entre
// chamadas, compartilhando a fila com o resto do script), com as sentinelas
// de captcha/sessão do core. Mutações via POST direto com header
// TribalWars-Ajax (padrão dos endpoints que o Vanta usava), 1 tentativa.

import { pageWindow } from '../../core/page';
import { csrfToken, enqueue, pacedGet } from '../../core/net';

export { pacedGet };

/** game_data da página (id de aldeia, csrf etc.). */
export function gameData(): Record<string, unknown> {
  return (pageWindow().game_data ?? {}) as Record<string, unknown>;
}

/** Aldeia atual selecionada no jogo. */
export function currentVillageId(): string {
  const gd = gameData() as { village?: { id?: number | string } };
  return String(gd.village?.id ?? '');
}

/**
 * CSRF: preferindo o da página; fallback pro input h do documento. Lança se
 * ambos faltarem — melhor erro claro na origem do que POST mutante com h= vazio
 * (P3 da revisão da Onda 2; todos os chamadores estão em handlers com catch).
 */
export function currentCsrf(): string {
  const gd = gameData() as { csrf?: string };
  if (typeof gd.csrf === 'string' && gd.csrf !== '') return gd.csrf;
  try {
    return csrfToken();
  } catch {
    throw new Error('CSRF do jogo indisponível — recarregue a página.');
  }
}

export interface VantaPostResult {
  json: Record<string, unknown>;
  /** csrf atualizado pela resposta (json.csrf/json.response.csrf), se houver. */
  csrf: string;
}

/**
 * POST ajax do jogo (ajaxaction) com header TribalWars-Ajax. Corpo como
 * pares chave/valor (form-urlencoded). Serializado pela fila global de rede.
 */
export async function vantaPostJson(path: string, body: Record<string, string>): Promise<VantaPostResult> {
  const params = new URLSearchParams(body);
  return enqueue(async () => {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'TribalWars-Ajax': '1',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: params.toString(),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${path}`);
    const json = (await response.json()) as Record<string, unknown>;
    const resp = json.response as Record<string, unknown> | undefined;
    const newCsrf =
      typeof json.csrf === 'string'
        ? json.csrf
        : resp !== undefined && typeof resp.csrf === 'string'
          ? resp.csrf
          : '';
    return { json, csrf: newCsrf !== '' ? newCsrf : currentCsrf() };
  });
}

/**
 * Renomeia um comando (ataque/apoio) — porta do renameCommand do Vanta.
 * O rótulo é o "outro comentário" do comando (edit_other_comment).
 */
export async function renameCommand(
  commandId: string,
  newText: string,
  csrfIn?: string,
): Promise<{ csrf: string }> {
  const h = csrfIn ?? currentCsrf();
  const vid = currentVillageId();
  const path = `/game.php?village=${vid}&screen=info_command&ajaxaction=edit_other_comment&id=${commandId}&h=${h}`;
  const result = await vantaPostJson(path, { text: newText });
  return { csrf: result.csrf };
}

/**
 * Página HTML via pacedGet já parseada em Document (DOMParser).
 * `fresh` ignora o cache de 60s (ex.: simulador após mudança de stack).
 */
export async function pacedDoc(path: string, opts?: { fresh?: boolean }): Promise<Document> {
  const body = await pacedGet(path, opts);
  return new DOMParser().parseFromString(body, 'text/html');
}
