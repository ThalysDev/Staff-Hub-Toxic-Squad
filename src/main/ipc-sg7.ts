import { ipcMain } from "electron";
import type { Sg7Service } from "./mutations/sg7-service";

export function registerSg7Ipc(sg7: Sg7Service): void {
  ipcMain.handle("sg7:conference", async (_event, threadUrl: string) => {
    try {
      return await sg7.conference(threadUrl);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
  ipcMain.handle("sg7:adjust", async (_event, threadUrl: string, confirm: boolean) => {
    try {
      return await sg7.adjust(threadUrl, confirm);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
