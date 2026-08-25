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
- Sessão do jogo = janela de login real (usuário resolve captcha/2FA) na partição
  `persist:tw`; requisições via `session.fetch` da partição (cookie jar do Chromium).
- Padrão detect-pause-notify: sentinela de sessão/captcha interrompe a operação e avisa.
- Leituras: até 3 tentativas em falha transitória. Mutações: 1 tentativa, confirmação dupla
  na UI, journal obrigatório. `dryRun` padrão ON até validação na tribo.
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
