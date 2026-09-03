// CANÁRIO do dono (02/09) — login + captura NO MESMO PROCESSO: o sid do TW é um
// cookie de SESSÃO (morre ao fechar), então as páginas são baixadas com a
// partição VIVA logo depois do login do próprio dono. Só GETs de leitura das
// páginas que o app já coleta rotineiramente; nada é clicado/enviado no jogo.
import { app, BrowserWindow, session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, 'canary-out');
mkdirSync(OUT, { recursive: true });
const WORLD = 'br142';
const BASE = `https://${WORLD}.tribalwars.com.br/game.php`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function grab(ses, name, url) {
  const t0 = Date.now();
  const res = await ses.fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  const body = await res.text();
  writeFileSync(join(OUT, `${name}.html`), body, 'utf-8');
  const isGame = body.includes('id="ds_body"');
  console.log(
    `${name}: HTTP ${res.status}, ${(body.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms` +
      (isGame ? '  [página de jogo ✓]' : '  [SEM ds_body — não é página logada]'),
  );
  return body;
}

app.setPath('userData', join(import.meta.dirname, '.probe-ud'));
app.whenReady().then(() => {
  const ses = session.fromPartition('persist:tw');
  const win = new BrowserWindow({
    width: 620,
    height: 820,
    title: 'Canário Staff Hub — entre no jogo aqui (BR142)',
    webPreferences: { partition: 'persist:tw', contextIsolation: true, nodeIntegration: false },
  });
  let done = false;
  win.on('closed', () => {
    if (!done) {
      console.log('janela fechada sem login — encerrando.');
      app.quit();
    }
  });
  win.webContents.on('did-navigate', (_e, url) => void check(url));
  win.webContents.on('did-navigate-in-page', (_e, url) => void check(url));

  async function check(url) {
    if (done || !/^https:\/\/br[a-z]?\d+\.tribalwars\.com\.br\/game\.php/.test(url)) return;
    done = true;
    console.log('LOGIN DETECTADO — capturando páginas (não feche o app, a janelinha do jogo vai fechar sozinha)…');
    try {
      await sleep(2500);
      // 1. overview: valida sessão + extrai nick e player_id do próprio
      const overview = await grab(ses, '00-overview', `${BASE}?screen=overview`);
      const playerMatch = /"player":\{"id":(\d+),"name":"([^"]{2,40})"/.exec(overview);
      const nick = playerMatch?.[2] ?? null;
      const ownId = playerMatch?.[1] ?? null;
      console.log(`jogador logado: ${nick} (id ${ownId})`);
      await sleep(1600);

      // 2. dropdown de membros + páginas de TROPAS do próprio (paginadas?)
      const dd = await grab(ses, '01-members-troops-dropdown', `${BASE}?screen=ally&mode=members_troops`);
      if (ownId !== null) {
        const idNoDd = new RegExp(`value="${ownId}"`).test(dd);
        console.log(`player_id ${ownId} presente no dropdown: ${idNoDd}`);
        await sleep(1600);
        await grab(ses, '02-members-troops-own', `${BASE}?screen=ally&mode=members_troops&player_id=${ownId}`);
        await sleep(1600);
        await grab(ses, '03-members-troops-own-page2', `${BASE}?screen=ally&mode=members_troops&player_id=${ownId}&page=2`);
      }
      await sleep(1600);

      // 3. overview de unidades da própria conta (fonte do fallback — paginada?)
      await grab(ses, '04-own-units', `${BASE}?screen=overview_villages&mode=units`);
      await sleep(1600);
      await grab(ses, '05-own-units-page2', `${BASE}?screen=overview_villages&mode=units&page=2`);
      console.log('CAPTURA CONCLUÍDA ✓');
    } catch (error) {
      console.error('FALHA NA CAPTURA:', error);
      process.exitCode = 1;
    } finally {
      win.close();
      setTimeout(() => app.quit(), 600);
    }
  }
  void win.loadURL('https://www.tribalwars.com.br/');
  console.log('janela de login aberta — esperando o dono entrar no jogo…');
});
