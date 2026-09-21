# Staff Hub Toxic Squad — regras do repo

App desktop Electron para a **liderança de tribo** no Tribal Wars BR. Projeto INDEPENDENTE do
Toxic Squad Hub (extensão) e do reidasmultistw (backend) — podem servir de referência de
padrões, nunca de dependência.

## Stack
- Electron 43 + electron-vite 5 + React 19 + TypeScript strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).
- Vitest para testes (libertárias compartilhadas puras + futuros parsers contra fixtures em
  `tests/fixtures/br142/`).
- UI 100% PT-BR, tema Toxic Squad (tokens em `src/renderer/styles/tokens.css`).

## Gates (antes de considerar qualquer entrega)
```bash
cd staff-hub-toxic-squad
pnpm typecheck && pnpm test && pnpm build
```

## Política de segurança (PERMANENTE, sem exceções)
- **NUNCA** implementar captcha-solver, bypass de fingerprint, rotação de sid ou qualquer
  camada de evasão — de qualquer fornecedor. A linha é a função, não o vendor.
- Sessão do jogo, duas formas AUTORIZADAS PELO DONO (24/08/2026), ambas com sessão resolvida
  pelo próprio usuário (captcha/2FA no navegador dele, nunca automatizado):
  1. Janela de login real na partição `persist:tw` (fluxo padrão);
  2. **Import de sid** colado pelo dono (fluxo EditThisCookie, igual ao reidasmultistw):
     o usuário copia o cookie `sid` da PRÓPRIA conta logada no navegador e cola no app.
     Sid importado é dado de sessão do usuário — nunca gerar, renovar ou rotacionar sid
     automaticamente.
- Todas as requisições via `session.fetch` da partição (cookie jar do Chromium).
- Padrão detect-pause-notify: sentinela de sessão/captcha interrompe a operação e avisa.
- Leituras: até 3 tentativas em falha transitória. Mutações: 1 tentativa, confirmação dupla
  na UI, journal obrigatório. **DRY-RUN DESATIVADO PERMANENTEMENTE pelo dono em
  25/08/2026** ("tudo sempre com dados reais") — mutações executam de verdade;
  journal e confirmação dupla seguem obrigatórios.
- Pacing humano mínimo (default 350ms + jitter), teto por operação.

## Padrões de código
- Parsers e regras de negócio em `src/shared` (puros, testáveis, determinísticos).
- Acesso ao jogo só no processo main (`src/main/tw`), via `RequestQueue`.
- Contrato IPC evolui primeiro em `src/shared/ipc-types.ts`.
- Erro de parser = fail-closed com mensagem clara. Nunca retornar dado errado silencioso.
- Strings de UI PT-BR com os rótulos ORIGINAIS da ferramenta transcrita (ver
  `docs/MODULOS-SG.md`).
- **Gate central de IPC**: canal novo de produto precisa do prefixo em `CANAIS_PROTEGIDOS`
  (`src/main/index.ts`) — e o `registerIpc()` só pode rodar DEPOIS do wrapper do gate
  (registrá-lo antes deixou 5 canais ungated na v0.35).

## Mundo/canário
- Desenvolvimento contra **BR142** (conta de líder/fundador do dono).
- Mutações testadas apenas na tribo do dono: reservas reversíveis, tópico-teste no fórum
  interno (deletável), MP para si mesmo.
- Fixtures HTML reais obrigatórias antes de escrever parser de qualquer tela nova
  (usar a página de capturas do app ou salvar via sessão).
- Evidência de OP real (capturas, zips de prova, cookies) vive em `tests/diag/` e **NUNCA
  vai ao git** (ver `.gitignore`).

## Empacotamento
- O `@electron/packager` JÁ entrega `resources/app.asar` por padrão. **NUNCA reempacotar
  o asar manualmente**: sobrescreve o asar bom por um VAZIO e mata o app (incidente real
  pego no E2E do atualizador). Detalhes em `docs/MODULOS-SG.md`, seção
  "Sistema — Login e proteção de acesso".

## Versionamento (política praticada)
- **patch (X.Y.Z+1)** = fix pontual, hotfix ou frente pequena — ex.: 0.32.1/0.32.2/0.32.3
  (revisão dupla + hotfix da OP de mundo inteiro), 0.35.1 (hint do SG_2), 0.35.2 (banner).
- **minor (X.Y+1.0)** = conjunto grande de frentes ou feature nova — ex.: 0.34.0 (SG_2 em
  abas), 0.33.0 (mega atualização da Sala de Guerra), 0.36.0 (hardening do atualizador +
  ondas 0.36).
- O bump acontece no corte, via `scripts/release.mjs <versão> "<notas>"` — ele roda os
  gates, bumpa o `package.json`, empacota e publica no canal. Notas de release têm teto
  (`MAX_NOTES_LENGTH` = 600 em `src/shared/updater-core.ts`).

## Release (regras aprendidas na prática — OBRIGATÓRIAS)
1. **REVISÃO DUPLA completa antes de toda release.** Duas revisões independentes (código +
   produto/UX) com achados corrigidos ANTES do corte — não vale "revisar depois" (toda
   revisão pós-release desta casa virou patch de emergência: 0.32.1, 0.33.1, 0.35.0-ondas).
2. **Bug-class de prefixo/case de canal exige auditoria holística da lista
   `CANAIS_PROTEGIDOS`.** Achou um canal com prefixo errado, case errado ou faltando no
   gate? NÃO corrige só aquele: audita a lista INTEIRA canal por canal (o mesmo bug quase
   sempre está replicado — na v0.35 eram 5 canais ungated, não 1).
3. Sub-agentes: paralelo só em arquivos novos; integração serial; revisão antes de fechar
   fase.
