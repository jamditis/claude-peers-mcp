// tests/notify.test.ts — the doorbell marker helpers (issue #49), pure file IO.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorbellDir, doorbellPath, readDoorbell, removeDoorbell, writeDoorbell } from "../shared/notify.ts";

describe("doorbell path derivation", () => {
  it("derives the doorbell dir as a sibling of the db file", () => {
    expect(doorbellDir("/home/u/.claude-peers.db")).toBe("/home/u/.claude-peers.db.doorbells");
  });

  it("places one .mark file per peer id under the dir", () => {
    expect(doorbellPath("/x/db", "abc-123")).toBe("/x/db.doorbells/abc-123.mark");
  });

  it("rejects ids that are not filename-safe (path-traversal guard)", () => {
    for (const bad of ["../escape", "a/b", "with space", "", "a..b", "..", "a/../b"]) {
      expect(doorbellPath("/x/db", bad)).toBeNull();
    }
  });

  it("accepts the real peer-id shape, including dotted id_prefix", () => {
    // id_prefix is copied verbatim into the id and may contain a dot (e.g. `node.a`), so a
    // single dot must be allowed — only `..` and separators are unsafe.
    for (const ok of ["dla-wc7mijtj", "peer-1", "a_b-9", "node.a-wc7mijtj", "a.b"]) {
      expect(doorbellPath("/x/db", ok)).not.toBeNull();
    }
  });
});

describe("doorbell read/write/remove", () => {
  let dbPath = "";

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "doorbell-"));
    dbPath = join(dir, "store.db"); // the file itself need not exist; only the .doorbells dir is used
  });
  afterEach(() => {
    try { rmSync(`${dbPath}.doorbells`, { recursive: true, force: true }); } catch {}
  });

  it("writes the counter and reads it back", () => {
    expect(writeDoorbell(dbPath, "p-1", 42)).toBe(true);
    expect(readDoorbell(dbPath, "p-1")).toBe(42);
    expect(readFileSync(doorbellPath(dbPath, "p-1") as string, "utf8")).toBe("42");
  });

  it("creates the doorbell directory on first write", () => {
    expect(existsSync(doorbellDir(dbPath))).toBe(false);
    writeDoorbell(dbPath, "p-1", 1);
    expect(existsSync(doorbellDir(dbPath))).toBe(true);
  });

  it("overwrites in place so the counter only reflects the latest value", () => {
    writeDoorbell(dbPath, "p-1", 5);
    writeDoorbell(dbPath, "p-1", 9);
    expect(readDoorbell(dbPath, "p-1")).toBe(9);
  });

  // The watcher arms at the value it last read and fires only above it, so a marker that can fall
  // silences every watcher already armed higher. Max pending id does fall (a later pushable row
  // delivered while an earlier poll-only row waits), so the clamp lives here rather than at each
  // ring site, where the next caller would have to remember it.
  it("never lowers the counter, whatever a caller passes", () => {
    expect(writeDoorbell(dbPath, "p-1", 9)).toBe(true);
    expect(writeDoorbell(dbPath, "p-1", 4)).toBe(false); // a lower max pending id is not an advance
    expect(readDoorbell(dbPath, "p-1")).toBe(9);
    expect(writeDoorbell(dbPath, "p-1", 9)).toBe(false); // nor is the same one again
    expect(readDoorbell(dbPath, "p-1")).toBe(9);
    expect(writeDoorbell(dbPath, "p-1", 10)).toBe(true);
    expect(readDoorbell(dbPath, "p-1")).toBe(10);
  });

  it("returns the missing sentinel when no marker exists", () => {
    expect(readDoorbell(dbPath, "never")).toBe(-1);
    expect(readDoorbell(dbPath, "never", 0)).toBe(0);
  });

  it("returns the missing sentinel for a garbage marker", () => {
    writeDoorbell(dbPath, "p-1", 1);
    writeFileSync(doorbellPath(dbPath, "p-1") as string, "not-a-number");
    expect(readDoorbell(dbPath, "p-1", 7)).toBe(7);
  });

  it("removeDoorbell deletes the marker and is a no-op when already gone", () => {
    writeDoorbell(dbPath, "p-1", 1);
    expect(existsSync(doorbellPath(dbPath, "p-1") as string)).toBe(true);
    removeDoorbell(dbPath, "p-1");
    expect(existsSync(doorbellPath(dbPath, "p-1") as string)).toBe(false);
    removeDoorbell(dbPath, "p-1"); // second call must not throw
  });

  it("write/read for an unsafe id is a no-op, never an escape", () => {
    expect(writeDoorbell(dbPath, "../escape", 1)).toBe(false);
    expect(readDoorbell(dbPath, "../escape", -1)).toBe(-1);
  });
});
