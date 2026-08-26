const fs = require('fs');
const base = 'C:/Users/Usuário/.zcode/workspace/default/staff-hub-toxic-squad';
const read = (p) => fs.readFileSync(`${base}/${p}`, 'utf8');
const write = (p, c) => fs.writeFileSync(`${base}/${p}`, c);
let fixes = [];

// ===== B1: Remover checkbox DRY-RUN das SettingsPage =====
let st = read('src/renderer/src/pages/SettingsPage.tsx');
if (st.includes('DRY-RUN')) {
  st = st.replace(/<label className="checkbox-field">[\s\S]*?DRY-RUN[\s\S]*?<\/label>/g, '');
  st = st.replace(/<p className="muted">Mutações rodam sempre em modo real[^<]*<\/p>/g, '<p className="muted">Mutações rodam sempre em modo real (decisão do dono, 25/08) — confirmação dupla e journal seguem ativos.</p>');
  // Remover dryRun do estado e do save
  st = st.replace(/,\s*dryRun: false/g, '');
  st = st.replace(/,\s*dryRun: true/g, '');
  st = st.replace(/,\s*dryRun/g, '');
  st = st.replace(/dryRun,\s*/g, '');
  st = st.replace(/dryRun:.*?\n/g, '');
  write('src/renderer/src/pages/SettingsPage.tsx', st);
  fixes.push('B1: DRY-RUN checkbox removido');
}

// ===== B3/B4: Cache de mundo/tropas chaveado por mundo =====
let wds = read('src/main/services/world-data-service.ts');
if (!wds.includes('world: string | null')) {
  // interface WorldDataCache — adicionar world
  wds = wds.replace(
    'interface WorldDataCache {',
    'interface WorldDataCache {\n  world: string | null;'
  );
  // refresh: salvar world
  wds = wds.replace(
    "await this.store.save({ fetchedAt: new Date().toISOString(), villages, players, allies });",
    "await this.store.save({ world, fetchedAt: new Date().toISOString(), villages, players, allies });"
  );
  // villages(): validar mundo
  wds = wds.replace(
    "  /** Aldeias do cache; erro claro se o mundo ainda não foi baixado. */\n  async villages(): Promise<WorldVillage[]> {\n    const data = await this.requireCache();\n    return data.villages;\n  }",
    "  /** Aldeias do cache; erro claro se o mundo ainda não foi baixado ou é de outro mundo. */\n  async villages(): Promise<WorldVillage[]> {\n    const data = await this.requireCache();\n    const currentWorld = this.world();\n    if (data.world && data.world !== currentWorld) {\n      throw new Error(`Dados do mundo em cache são de ${data.world} — a sessão atual é ${currentWorld}. Clique em \"Atualizar dados do mundo\".`);\n    }\n    return data.villages;\n  }"
  );
  // players(): mesmo check
  wds = wds.replace(
    "  async players(): Promise<WorldPlayer[]> {\n    const data = await this.requireCache();\n    return data.players;\n  }",
    "  async players(): Promise<WorldPlayer[]> {\n    const data = await this.requireCache();\n    const currentWorld = this.world();\n    if (data.world && data.world !== currentWorld) {\n      throw new Error(`Dados do mundo em cache são de ${data.world} — a sessão atual é ${currentWorld}. Atualize os dados do mundo.`);\n    }\n    return data.players;\n  }"
  );
  // tribes(): mesmo check
  wds = wds.replace(
    "  async tribes(): Promise<WorldAlly[]> {\n    const data = await this.requireCache();\n    return data.allies;\n  }",
    "  async tribes(): Promise<WorldAlly[]> {\n    const data = await this.requireCache();\n    const currentWorld = this.world();\n    if (data.world && data.world !== currentWorld) {\n      throw new Error(`Dados do mundo em cache são de ${data.world} — a sessão atual é ${currentWorld}. Atualize os dados do mundo.`);\n    }\n    return data.allies;\n  }"
  );
  // EMPTY_WORLD_CACHE incluir world: null
  wds = wds.replace(
    /const EMPTY_WORLD_CACHE.*?=.*?\{[^}]*\}/s,
    (m) => m.replace('}', ' world: null }')
  );
  write('src/main/services/world-data-service.ts', wds);
  fixes.push('B3: world-data cache chaveado por mundo');
}

// troops-service: adicionar world ao store
let ts = read('src/main/services/troops-service.ts');
if (!ts.includes('world: string | null')) {
  ts = ts.replace(
    'interface TroopsSnapshotsStore {',
    'interface TroopsSnapshotsStore {\n  world: string | null;'
  );
  ts = ts.replace(
    "const EMPTY_TROOPS_STORE: TroopsSnapshotsStore = { troops: null, defense: null, defenseVillages: null };",
    "const EMPTY_TROOPS_STORE: TroopsSnapshotsStore = { troops: null, defense: null, defenseVillages: null, world: null };"
  );
  // get(): validar mundo
  ts = ts.replace(
    "  async get(kind: TroopKind): Promise<TroopSnapshot | null> {\n    assertKind(kind);\n    const data = await this.store.load();\n    return data[kind];\n  }",
    "  async get(kind: TroopKind): Promise<TroopSnapshot | null> {\n    assertKind(kind);\n    const data = await this.store.load();\n    const currentWorld = this.world();\n    if (data.world && data.world !== currentWorld) {\n      return null; // dados de outro mundo = como se não tivesse coletado\n    }\n    return data[kind];\n  }"
  );
  // saveSnapshot: salvar world
  ts = ts.replace(
    "  private async saveSnapshot(snapshot: TroopSnapshot, defenseVillages?: DefenseSnapshot | null): Promise<void> {\n    const current = await this.store.load();\n    const next: TroopsSnapshotsStore = { ...current };",
    "  private async saveSnapshot(snapshot: TroopSnapshot, defenseVillages?: DefenseSnapshot | null): Promise<void> {\n    const current = await this.store.load();\n    const next: TroopsSnapshotsStore = { ...current, world: this.world() };"
  );
  // getDefenseVillages: validar
  ts = ts.replace(
    "  async getDefenseVillages(): Promise<DefenseSnapshot | null> {\n    const data = await this.store.load();\n    return data.defenseVillages;\n  }",
    "  async getDefenseVillages(): Promise<DefenseSnapshot | null> {\n    const data = await this.store.load();\n    const currentWorld = this.world();\n    if (data.world && data.world !== currentWorld) return null;\n    return data.defenseVillages;\n  }"
  );
  write('src/main/services/troops-service.ts', ts);
  fixes.push('B4: troops-snapshots chaveado por mundo');
}

// ===== I5: Restore de sessão aceita domain .tribalwars.com.br =====
let ses = read('src/main/tw/session.ts');
if (!ses.includes('.tribalwars.com.br$')) {
  ses = ses.replace(
    "/^br\\d{1,4}\\.tribalwars\\.com\\.br$/.test(cookie.domain)",
    "/(br\\d{1,4}\\.)?tribalwars\\.com\\.br$/.test(cookie.domain)"
  );
  // extrair mundo do domain ou do cookie name
  ses = ses.replace(
    "const world = /^br\\d{1,4}/.exec(sidCookie.domain ?? '')?.[0] ?? null;",
    "const world = /br(\\d{1,4})/.exec(sidCookie.domain ?? '')?.[0] ?? null;"
  );
  write('src/main/tw/session.ts', ses);
  fixes.push('I5: restore aceita domain .tribalwars.com.br');
}

// ===== I7: SG7 valida host da URL =====
let s7 = read('src/main/mutations/sg7-service.ts');
if (!s7.includes('threadUrl deve apontar')) {
  s7 = s7.replace(
    "const path = threadUrl.replace(/^https?:\\/\\/[^/]+\\//, '');",
    "const world = this.world();\n    if (!threadUrl.includes(`${world}.tribalwars.com.br`)) {\n      throw new Error(`A URL do tópico deve apontar para ${world}.tribalwars.com.br — a sessão atual é do mundo ${world}.`);\n    }\n    const path = threadUrl.replace(/^https?:\\/\\/[^/]+\\//, '');"
  );
  write('src/main/mutations/sg7-service.ts', s7);
  fixes.push('I7: SG7 valida host da URL');
}

// ===== I10: Journal race fix =====
let ix = read('src/main/index.ts');
ix = ix.replace(
  "app.whenReady().then(() => {\n  void twSession.restoreFromPartition();",
  "app.whenReady().then(async () => {\n  await journal.load();\n  void twSession.restoreFromPartition();"
);
ix = ix.replace("  void journal.load();\n  ", "");
write('src/main/index.ts', ix);
fixes.push('I10: journal.load() await');

// ===== I11: SG4 TTL 6h =====
let s4 = read('src/renderer/src/pages/sg4/Sg4Page.tsx');
s4 = s4.replace(
  "if (worldStatus.villageCount === 0)",
  "if (worldStatus.villageCount === 0 || (worldStatus.fetchedAt !== null && Date.now() - Date.parse(worldStatus.fetchedAt) > 6 * 60 * 60 * 1000))"
);
write('src/renderer/src/pages/sg4/Sg4Page.tsx', s4);
fixes.push('I11: SG4 TTL 6h');

// ===== N12: Remover br142 hardcoding =====
let app = read('src/renderer/src/App.tsx');
app = app.replace("'Capturas BR142'", "'Capturas de tela'");
write('src/renderer/src/App.tsx', app);

let dash = read('src/renderer/src/pages/DashboardPage.tsx');
dash = dash.replace("Capturas BR142 — fixtures para os parsers", "Capturas de tela — fixtures para os parsers");
dash = dash.replace("Canário de desenvolvimento", "Desenvolvimento");
write('src/renderer/src/pages/DashboardPage.tsx', dash);

let cap = read('src/renderer/src/pages/CapturesPage.tsx');
cap = cap.replace(/BR142/g, 'do mundo');
cap = cap.replace('Capturas de tela (do mundo)', 'Capturas de tela (fixtures)');
write('src/renderer/src/pages/CapturesPage.tsx', cap);

// ===== N15: Regex de mundo consistente =====
let sp = read('src/renderer/src/pages/SessionPage.tsx');
sp = sp.replace(/br\\d\{2,4\}/g, 'br\\\\d{1,4}');
write('src/renderer/src/pages/SessionPage.tsx', sp);
fixes.push('N15: regex mundo consistente');

console.log(fixes.join('\n'));
console.log(`\nTotal: ${fixes.length} correções`);
