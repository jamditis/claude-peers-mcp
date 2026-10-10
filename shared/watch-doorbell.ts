import { closeSync, constants, fstatSync, type FSWatcher, mkdirSync, openSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { isPidDead, pidProbe } from "../delivery.ts";
import { doorbellDir, doorbellPath } from "./notify.ts";

// Unlike the broker's best-effort marker read, readiness cannot treat an I/O
// error as "unchanged". Validate and read the same descriptor; O_NONBLOCK keeps
// a substituted FIFO from hanging startup before the regular-file check.
function readWatchMarker(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64) throw new Error("Doorbell marker must be a regular counter file");
    const raw = readFileSync(fd, "utf8").trim();
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value)) throw new Error("Doorbell marker has no valid counter");
    return value;
  } finally { closeSync(fd); }
}

export interface WatchDoorbellOptions {
  dbPath: string;
  id: string;
  since: number | null;
  pollMs: number;
  timeoutSec: number | null;
  persistent: boolean;
  ownerPid?: number;
  exclusive?: boolean;
}

/** Notify only. A host-owned child must deliver completion to its session. */
export async function watchDoorbell(options: WatchDoorbellOptions): Promise<number> {
  const { dbPath, id, since, timeoutSec, persistent, ownerPid, exclusive } = options;
  const markPath = doorbellPath(dbPath, id);
  if (!markPath) throw new Error("Invalid peer id");
  if (ownerPid && isPidDead(pidProbe(ownerPid))) {
    console.error(`doorbell stopped for ${id}: owner exited`);
    return 4;
  }
  const pollMs = Math.max(250, options.pollMs);
  mkdirSync(doorbellDir(dbPath), { recursive: true });
  const lockPath = `${markPath}.watcher`;
  if (exclusive) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner_pid: ownerPid }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      console.error(`doorbell blocked for ${id}: watcher lock exists at ${lockPath}; retain the original host task. If it was hard-killed, verify it has stopped before removing the stale lock.`);
      return 3;
    }
  }

  try {
    // Never truncate a broker counter. Fail visibly on an inaccessible marker.
    try { writeFileSync(markPath, "0", { flag: "wx" }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const initial = readWatchMarker(markPath); // Validate even when --since was supplied.
    let baseline = since ?? initial;
    return await new Promise<number>((resolve) => {
      let watcher: FSWatcher | null = null;
      let debounce: ReturnType<typeof setTimeout> | null = null;
      let done = false;
      let ready = false;
      let readFailedAt: number | null = null;
      const poll = setInterval(check, pollMs);
      const timeout = timeoutSec && timeoutSec > 0
        ? setTimeout(() => finish(2, `no mail for ${id} within ${timeoutSec}s`), timeoutSec * 1000) : null;
      const cancel = () => finish(4, `doorbell stopped for ${id}`);

      function finish(code: number, message: string) {
        if (done) return;
        done = true;
        if (debounce) clearTimeout(debounce);
        clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        watcher?.close();
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
        process.off("SIGHUP", cancel);
        console.log(message);
        resolve(code);
      }
      function check() {
        if (done) return;
        if (ownerPid && isPidDead(pidProbe(ownerPid))) {
          finish(4, `doorbell stopped for ${id}: owner exited`);
          return;
        }
        let cur: number;
        try {
          cur = readWatchMarker(markPath as string);
          if (readFailedAt !== null) console.log(`doorbell recovered for ${id}: marker readable`);
          readFailedAt = null;
        } catch (error) {
          if (ownerPid && (error as NodeJS.ErrnoException).code === "ENOENT") {
            finish(4, `doorbell stopped for ${id}: peer marker removed`);
            return;
          }
          // In-place broker writes can briefly expose an empty counter. Report
          // degradation immediately, but allow two poll intervals to recover.
          const now = performance.now();
          if (readFailedAt === null) {
            readFailedAt = now;
            console.log(`doorbell degraded for ${id}: marker unreadable; retrying`);
          } else if (now - readFailedAt >= 2 * pollMs) {
            finish(1, `doorbell failed for ${id}: marker unreadable across multiple polls`);
          }
          return;
        }
        if (!ready) {
          ready = true;
          console.log(`doorbell armed for ${id} (since=${baseline}; backend=${watcher ? "watch+poll" : "poll"}; consumed=false)`);
        }
        if (cur <= baseline) return;
        if (persistent) {
          console.log(`mail for ${id} (mark=${cur})`);
          baseline = cur;
        } else finish(0, `mail for ${id} (mark=${cur}) - re-arm, then run check_messages`);
      }
      function onEvent() {
        if (done) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(check, 50);
      }
      process.on("SIGINT", cancel);
      process.on("SIGTERM", cancel);
      process.on("SIGHUP", cancel);
      try {
        watcher = watch(markPath, { persistent: true }, onEvent);
        watcher.on("error", () => { watcher?.close(); watcher = null; });
      } catch { /* fallback poll still observes the level */ }
      check(); // Catch advances between the supplied snapshot and actual child startup.
    });
  } finally {
    if (exclusive) {
      try { unlinkSync(lockPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`doorbell lock cleanup failed for ${id}; verify the task has stopped before removing ${lockPath}`);
        }
      }
    }
  }
}
