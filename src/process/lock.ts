import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

/** Serialize daemon startup across CLI processes, including two chats starting together. */
export async function withBridgeLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const file = path.join(ensureDir(path.join(getStateDir(), "locks")), `${id}.lock`);
  const deadline = Date.now() + 25_000;
  while (true) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Do not unlink a stale PID lock automatically: a competing process may
      // have replaced it between our read and unlink. Recovery is deliberately
      // fail-closed; remove the lock only after confirming no startup is active.
      if (Date.now() >= deadline) throw new Error(`Bridge startup lock is held. Retry after the other CLI completes; after a crash, confirm no bridge is starting before removing ${file}.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await action(); } finally { fs.rmSync(file, { force: true }); }
}
