// Janela de login do jogo para o CANÁRIO do dono (autorizado 02/09: "abrir o
// browser que eu logo nela"). Partição ISOLADA do probe (.probe-ud) — a sessão
// do jogo cai aqui e alimenta o probe de leitura; nada toca o app de produção.
// Ao detectar URL de jogo (login concluído pelo próprio dono), valida, espera o
// flush dos cookies e fecha graciosamente (commit de session cookies).
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

const PORTAL = 'https://www.tribalwars.com.br/';
const GAME = /^https:\/\/(br[a-z]?\d+)\.tribalwars\.com\.br\/game\.php/;

app.setPath('userData', join(import.meta.dirname, '.probe-ud'));
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 620,
    height: 820,
    title: 'Canário Staff Hub — entre no jogo aqui (BR142)',
    webPreferences: { partition: 'persist:tw', contextIsolation: true, nodeIntegration: false },
  });
  let done = false;
  win.on('closed', () => {
    if (!done) console.log('janela fechada sem login.');
    setTimeout(() => app.quit(), 1500);
  });
  win.webContents.on('did-navigate', (_e, url) => check(url));
  win.webContents.on('did-navigate-in-page', (_e, url) => check(url));
  async function check(url) {
    if (done || !GAME.test(url)) return;
    done = true;
    console.log(`LOGIN DETECTADO: ${url}`);
    // dá 4s para o jogo assentar/cookies e então fecha graciosamente (commit)
    setTimeout(() => {
      console.log('fechando para liberar o probe…');
      win.close();
      setTimeout(() => app.quit(), 800);
    }, 4000);
  }
  void win.loadURL(PORTAL);
  console.log('janela de login aberta — esperando o dono entrar no jogo…');
});
