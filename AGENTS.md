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

## Mundo/canário
- Desenvolvimento contra **BR142** (conta de líder/fundador do dono).
- Mutações testadas apenas na tribo do dono: reservas reversíveis, tópico-teste no fórum
  interno (deletável), MP para si mesmo.
- Fixtures HTML reais obrigatórias antes de escrever parser de qualquer tela nova
  (usar a página de capturas do app ou salvar via sessão).

## Fases (ordem acordada com o dono)
Fase 0 bootstrap → Fase 0.5 capturas BR142 → SG_1 → SG_2 → SG_3 → SG_4 → SG_5 → SG_6 → SG_7.
Versionamento: +0.1.0 por frente entregue (package.json + bundleInfo juntos).
Sub-agentes: paralelo só em arquivos novos; integração serial; revisão antes de fechar fase.
