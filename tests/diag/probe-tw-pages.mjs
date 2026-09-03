// Probe de LEITURA (canário dono, 02/09): baixa páginas do jogo com a sessão da
// PARTIÇÃO COPIADA (nunca a original — o app de produção continua intacto) para
// decifrar a members_troops da própria conta com 1000+ aldeias (paginação) e a
// overview_villages&mode=units paginada. Só GETs de páginas que o próprio app
// coleta rotineiramente; nenhuma mutação. Saída: tests/diag/probe-out/*.html
import { app, session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, 'probe-out');
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
  const looksLogin = /name="password"|id="login"/i.test(body.slice(0, 4000));
  console.log(
    `${name}: HTTP ${res.status}, ${(body.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms` +
      (looksLogin ? '  << PARECE LOGIN (sessão inválida)' : '') +
      (body.includes('id="ds_body"') ? '' : '  << sem ds_body'),
  );
  return body;
}

app.setPath('userData', join(import.meta.dirname, '.probe-ud'));
app
  .whenReady()
  .then(async () => {
    const ses = session.fromPartition('persist:tw');
    try {
      // 1. valida a sessão + pega o nick logado
      const overview = await grab(ses, '00-overview', `${BASE}?screen=overview`);
      const nick = /"player":\{"id":\d+,"name":"([^"]{2,40})"/.exec(overview)?.[1] ?? null;
      console.log(`nick logado: ${nick}`);

      // 2. dropdown de membros (player_id de todos, incluindo o próprio)
      await grab(ses, '01-members-troops-dropdown', `${BASE}?screen=ally&mode=members_troops`);
      await sleep(1500);

      // player_id do próprio nick vem do passo anterior — extrai aqui:
      const dropdown = await ses.fetch(`${BASE}?screen=ally&mode=members_troops`, {
        headers: { Accept: 'text/html' },
      });
      const ddBody = await dropdown.text();
      const ownId =
        nick !== null
          ? new RegExp(`<option[^>]*value="(\\d+)"[^>]*>${nick}</option>`).exec(ddBody)?.[1] ?? null
          : null;
      console.log(`player_id próprio: ${ownId}`);
      if (ownId !== null) {
        await sleep(1500);
        await grab(ses, '02-members-troops-own', `${BASE}?screen=ally&mode=members_troops&player_id=${ownId}`);
        await sleep(1500);
        await grab(ses, '03-members-troops-own-page2', `${BASE}?screen=ally&mode=members_troops&player_id=${ownId}&page=2`);
      }
      await sleep(1500);

      // 3. overview de unidades da própria conta (paginada?)
      await grab(ses, '04-own-units', `${BASE}?screen=overview_villages&mode=units`);
      await sleep(1500);
      await grab(ses, '05-own-units-page2', `${BASE}?screen=overview_villages&mode=units&page=2`);
    } catch (error) {
      console.error('FALHA:', error);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.quit();
  });
