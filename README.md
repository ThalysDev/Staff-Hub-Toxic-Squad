# Staff Hub Toxic Squad

Hub desktop para a **staff da tribo Toxic Squad** no Tribal Wars BR (mundo BR142). Reúne os
7 fluxos da antiga ferramenta de userscripts (SG_1 a SG_7) + Sala de Guerra em um app só,
com dados que ficam salvos, journal auditável e atualização automática.

---

## Instalação

1. Receba o zip `StaffHubToxicSquad-<versão>.zip` (ou baixe do canal) e **extraia a pasta**;
2. Abra **Staff Hub Toxic Squad.exe** — não precisa instalar nada;
3. No primeiro boot: **crie sua conta** e aguarde um administrador aprovar. Conta aprovada =
   hub liberado.

**Atualização é automática**: o hub confere o canal sozinho (ao abrir e a cada 6h) e mostra
uma faixa no topo quando há versão nova — "Baixar e preparar" e depois "Reiniciar agora",
sem reinstalar nada. Se dispensar a faixa ("Agora não"), ela volta quando sair outra
versão, ou use **Ctrl+K → "Verificar atualizações"**.

---

## Dois logins, funções diferentes

| Login | Para quê | Onde |
|-------|----------|------|
| **Conta do Staff Hub** | Abrir o app. É criada no 1º boot e aprovada por um admin. Tem senha própria (troque na página Sessão). Sem internet na VPS? Você continua dentro por até 72h. | Tela de login do hub |
| **Sessão do jogo (Tribal Wars)** | Ler páginas do jogo e executar ações (coletas, reservas, MPs, fórum). Faça login na janela do jogo que o hub abre, ou cole o cookie `sid` do seu navegador (EditThisCookie). Nunca peça/préste o sid de outra pessoa. | Página "Sessão" |

Se um administrador banir uma conta, o hub trava na hora — fale com a staff da tribo.

---

## Os módulos em 1 linha cada

- **SG_1 · Análise de Aldeias** — tempo de nobre de cada aldeia até o inimigo mais próximo (buckets <1h a >34h) + mapa do mundo por tribo.
- **SG_2 · Análise de Tropas** — coleta as tropas de todas as aldeias da tribo, com filtros, Full/Semi e aba de Auditoria de Membros (quem cresceu, quem esvaziou).
- **SG_3 · Análise de Defesa** — o que está parado em cada aldeia, quanto falta de blind (com BBCode pronto) e apoiadores.
- **SG_4 · Criação de OPs** — monta a OP por coordenada central, distribui alvos por origem com heatmap de tempo/moral e calcula hora de envio.
- **SG_5 · Conferência** — confere quem enviou comando para cada alvo antes da OP, com diff entre rodadas e documento imprimível.
- **SG_6 · Reservas e MPs** — reserva alvos em massa no planejador e envia MPs personalizadas em cadeia (`#alvos#`, `#horarios#`).
- **SG_7 · Blindagem no Fórum** — lê os pedidos `pedido/lanceiros/espadachins/arqueiros` no tópico, soma o enviado e ajusta a tabela.
- **Sala de Guerra** — Planner em Massa (OP grande origem × alvo com exportação para as ferramentas conhecidas) e monitoramento ao vivo da OP (cobertura, agenda, mapa, pós-OP).

Fluxo típico de OP: SG_1 acha o alvo → SG_2/SG_3 checam tropa → SG_4 distribui → SG_5
confere → SG_6 avisa → SG_7 blinda → Sala de Guerra acompanha.

Atalhos: **Ctrl+K** paleta de comandos · **Alt+1..7** módulos · **Alt+8** Guerra · **Alt+9** Início.

---

## A quem pedir ajuda

- **Login, conta, aprovação, banimento, senha do hub** → administrador da tribo (página Admin).
- **Sessão do jogo, coletas, mutações, dúvida de módulo** → dono da tribo / quem administra o canal da staff.
- **O hub não abre após uma atualização** → siga o arquivo `RECUPERACAO.txt` que aparece ao lado da pasta do app (ou peça ajuda citando esse arquivo).
- Administradores/ops da infraestrutura (VPS, canal de atualização, API) → `docs/RUNBOOK-OPS.md`.
