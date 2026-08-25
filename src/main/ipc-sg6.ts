import { ipcMain } from "electron";
import type { Journal } from "./journal";
import type { Sg6Service, MpEntry } from "./mutations/sg6-service";

export interface Sg6IpcDeps {
  sg6: Sg6Service;
  journal: Journal;
}

export function registerSg6Ipc(deps: Sg6IpcDeps): void {
  ipcMain.handle("sg6:reserve-mass", async (_event, coords: string[], confirm: boolean) => {
    try {
      return await deps.sg6.reserveMass(coords, confirm);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
  ipcMain.handle("sg6:send-mps", async (_event, input: { subject: string; body: string; entries: MpEntry[] }, confirm: boolean) => {
    try {
      return await deps.sg6.sendMps(input.subject, input.body, input.entries, confirm);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}
