// Bootstrap da suíte de Automações (extensão Toxic Squad Hub portada).
// Cada plugin se auto-registra no runtime via registerTsh (import side-effect,
// padrão do projeto). A aba "Automações" do painel lista o que registrar.

export { renderTshPanel } from './tsh-panel';
export { startTshHeartbeat, runTshCycle } from './tsh-runtime';

// ── Economia ──
import './plugins/coin-center';
import './plugins/premium-exchange';
import './plugins/resource-balancer';
import './plugins/paladin-training';

// ── Produção / militar ──
import './plugins/recruitment';
import './plugins/mega-builder';
import './plugins/collection';
import './plugins/command-scheduler';

// ── Planejadores (prévia) ──
import './plugins/op-generator';
import './plugins/mass-support';
import './plugins/support-manager';

// ── Farm (leitura/prévia na maturidade da origem) ──
import './plugins/auto-farm';
import './plugins/wall-demolition';
import './plugins/barbarian-cultivator';
import './plugins/map-farm';

// ── Onda 5: fundo (Sentinela registra os 5 dela em tsh-sentinela.ts) ──
import './plugins/conquista-livres';
import './plugins/producao-nobres';
import './plugins/doador-prestigio';
