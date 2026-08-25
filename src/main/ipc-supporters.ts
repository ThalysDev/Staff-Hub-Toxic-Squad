import { ipcMain } from "electron";
import type { SupportersService } from "./services/supporters-service";

export function registerSupportersIpc(supporters: SupportersService): void {
  ipcMain.handle("sg3:supporters", async (_event, coords: string[]) => {
    try {
      return await supporters.supporters(coords);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
