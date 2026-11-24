import { closeSync, constants, fstatSync, type FSWatcher, mkdirSync, openSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { isPidDead, pidProbe } from "../delivery.ts";
import { doorbellDir, doorbellPath, readDoorbellMetadata, readDrainedDoorbell } from "./notify.ts";

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

interface WatcherLock { pid: number; started_at?: string }

function readWatcherLock(path: string): WatcherLock | null {
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > 512) return null;
    const lock = JSON.parse(raw) as { pid?: unknown; started_at?: unknown };
    if (!Number.isSafeInteger(lock.pid) || (lock.pid as number) <= 0) return null;
    const started = typeof lock.started_at === "string" && /^[0-9T:.Z-]{1,40}$/.test(lock.started_at) ? lock.started_at : undefined;
    return { pid: lock.pid as number, started_at: started };
  } catch { return null; }
}

function watcherLockRefusal(id: string, lockPath: string, holder: WatcherLock | null): string {
  if (!holder) {
    return `doorbell blocked for ${id}: watcher lock ${lockPath} names no process; confirm no doorbell for ${id} is running, delete the lock, and re-arm`;
  }
  const stop = process.platform === "win32" ? `taskkill /PID ${holder.pid}` : `kill ${holder.pid}`;
  return `doorbell blocked for ${id}: watcher lock ${lockPath} names running process ${holder.pid} (started ${holder.started_at ?? "unrecorded"}); keep that task, or stop it with \`${stop}\` and re-arm`;
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
  drainedCounter?: boolean;
  metadata?: boolean;
}

/** Notify only. A host-owned child must deliver completion to its session. */
export async function watchDoorbell(options: WatchDoorbellOptions): Promise<number> {
  const { dbPath, id, since, timeoutSec, persistent, ownerPid, exclusive, drainedCounter } = options;
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
    const lock = JSON.stringify({ pid: process.pid, owner_pid: ownerPid, started_at: new Date().toISOString() });
    const take = () => writeFileSync(lockPath, lock, { flag: "wx", mode: 0o600 });
    try { take(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A host can kill the task without letting it remove its lock (a WSL
      // interop kill leaves the Windows watcher's lock). A dead recorded
      // watcher cannot deliver, so its lock is taken over.
      const holder = readWatcherLock(lockPath);
      if (!holder || !isPidDead(pidProbe(holder.pid))) {
        console.error(watcherLockRefusal(id, lockPath, holder));
        return 3;
      }
      try { unlinkSync(lockPath); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
      try { take(); } catch (retakeError) {
        if ((retakeError as NodeJS.ErrnoException).code !== "EEXIST") throw retakeError;
        console.error(watcherLockRefusal(id, lockPath, readWatcherLock(lockPath)));
        return 3;
      }
      console.error(`doorbell for ${id} took over ${lockPath}: recorded watcher ${holder.pid} (started ${holder.started_at ?? "unrecorded"}) has exited`);
    }
  }

  try {
    // Only legacy/manual watchers create markers. Managed recipes establish one
    // before handoff; an absent marker means the peer was removed or rebound.
    // Recreating it here would silently arm an obsolete ID while its owner lives.
    if (ownerPid === undefined) {
      try { writeFileSync(markPath, "0", { flag: "wx" }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    // Initial validation shares check()'s bounded read-failure grace. A broker
    // may be mid-write before the very first read, not only after readiness.
    let baseline = since;
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
        // A capable broker records completed polls; older brokers use the queue head.
        // An explicit pre-launch baseline must survive startup read failures.
        baseline ??= drainedCounter ? readDrainedDoorbell(dbPath, id) : cur;
        if (!ready) {
          ready = true;
          console.log(`doorbell armed for ${id} (since=${baseline}; backend=${watcher ? "watch+poll" : "poll"}; consumed=false)`);
        }
        if (cur <= baseline) return;
        if (options.metadata) {
          const metadata = readDoorbellMetadata(dbPath, id, cur);
          if (metadata) console.log(`DOORBELL_META ${JSON.stringify(metadata)}`);
        }
        if (persistent) {
          console.log(`mail for ${id} (mark=${cur})`);
          baseline = cur;
        } else finish(0, `mail for ${id} (mark=${cur}) - ${since === null && drainedCounter
          ? "run check_messages, then re-arm" : "re-arm, then run check_messages"}`);
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
