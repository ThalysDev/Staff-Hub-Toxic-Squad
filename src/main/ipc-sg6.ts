import { ipcMain, BrowserWindow, dialog } from "electron";
import type { Sg6ChargeEntry } from "@shared/ipc-types";
import type { Journal } from "./journal";
import type { Sg6Service, MpEntry } from "./mutations/sg6-service";

export interface Sg6IpcDeps {
  sg6: Sg6Service;
  journal: Journal;
}

/**
 * C9 — confirmação NATIVA no main (defesa em profundidade): além da dupla
 * confirmação da UI, o main abre um dialog modal antes de qualquer mutação.
 * Cancelar é o default; nada é enviado sem o clique explícito aqui.
 */
async function confirmMutation(
  event: Electron.IpcMainInvokeEvent,
  title: string,
  message: string,
  confirmLabel: string,
): Promise<void> {
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options = {
    type: "warning" as const,
    title,
    message,
    detail: "Ação REAL no jogo — uma única tentativa por item, pacing humano e Journal obrigatório.",
    buttons: ["Cancelar", confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent !== undefined ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (response !== 1) {
    throw new Error("Cancelado na confirmação nativa — nada foi enviado ao jogo.");
  }
}

export function registerSg6Ipc(deps: Sg6IpcDeps): void {
  ipcMain.handle("sg6:reserve-mass", async (event, coords: string[], confirm: boolean) => {
    try {
      if (confirm) {
        await confirmMutation(
          event,
          "Reserva em massa",
          `Confirmar a reserva de ${coords.length} aldeia(s) no Planejador da tribo?`,
          "Confirmar reserva",
        );
      }
      return await deps.sg6.reserveMass(coords, confirm);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
  ipcMain.handle("sg6:send-mps", async (event, input: { subject: string; body: string; entries: MpEntry[] }, confirm: boolean) => {
    try {
      if (confirm) {
        await confirmMutation(
          event,
          "Envio de MPs",
          `Confirmar o envio de ${input.entries.length} MP(s) personalizada(s)?`,
          "Confirmar envio",
        );
      }
      return await deps.sg6.sendMps(input.subject, input.body, input.entries, confirm);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
  // Cobrança em lote (Sala de Guerra): SEM confirmMutation extra — o diálogo
  // nativo agregado é aberto DENTRO do service (um só dialog para o lote;
  // um segundo aqui virariam dois dialogs por cobrança).
  ipcMain.handle("sg6:charge-batch", async (_event, entries: Sg6ChargeEntry[]) => {
    try {
      return await deps.sg6.chargeBatch(entries);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
