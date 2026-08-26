import { ipcMain, BrowserWindow, dialog } from "electron";
import type { Sg7Service } from "./mutations/sg7-service";

/**
 * C9 — confirmação NATIVA no main (defesa em profundidade) para as mutações
 * do fórum (editar post da tabela / apagar posts). Cancelar é o default.
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
    detail: "Ação REAL no fórum — uma única tentativa, verificação pós-envio e Journal.",
    buttons: ["Cancelar", confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent !== undefined ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (response !== 1) {
    throw new Error("Cancelado na confirmação nativa — nada foi alterado no fórum.");
  }
}

export function registerSg7Ipc(sg7: Sg7Service): void {
  ipcMain.handle("sg7:conference", async (_event, threadUrl: string) => {
    try {
      return await sg7.conference(threadUrl);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
  ipcMain.handle("sg7:adjust", async (event, threadUrl: string, confirm: boolean) => {
    try {
      if (confirm) {
        await confirmMutation(
          event,
          "Ajustar post da blindagem",
          "Confirmar a edição do PRIMEIRO post do tópico com a tabela atualizada?",
          "Confirmar ajuste",
        );
      }
      return await sg7.adjust(threadUrl, confirm);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
  ipcMain.handle("sg7:delete-posts", async (event, threadUrl: string, postIds: number[], confirm: boolean) => {
    try {
      if (confirm) {
        await confirmMutation(
          event,
          "Apagar mensagens",
          `Confirmar a exclusão de ${postIds.length} post(s) do tópico (moderação)?`,
          "Confirmar exclusão",
        );
      }
      return await sg7.deletePosts(threadUrl, postIds, confirm);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
