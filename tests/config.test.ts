import { describe, expect, it } from "bun:test";
import { loadConfig, singleHostDefault } from "../shared/config.ts";

describe("loadConfig", () => {
  it("loads config from a file path", async () => {
    const tmpPath = "/tmp/test-claude-peers.json";
    await Bun.write(tmpPath, JSON.stringify({
      machine: "testmachine",
      tailscale_ip: "100.0.0.1",
      port: 7899,
      id_prefix: "tst",
      siblings: [
        { machine: "other", url: "http://100.0.0.2:7899" }
      ],
      allowed_ips: ["127.0.0.1", "100.0.0.1", "100.0.0.2"]
    }));

    const config = loadConfig(tmpPath);
    expect(config.machine).toBe("testmachine");
    expect(config.id_prefix).toBe("tst");
    expect(config.siblings).toHaveLength(1);
    expect(config.allowed_ips).toContain("127.0.0.1");
  });

  it("throws if required fields are missing", async () => {
    const tmpPath = "/tmp/test-claude-peers-bad.json";
    await Bun.write(tmpPath, JSON.stringify({ machine: "test" }));
    expect(() => loadConfig(tmpPath)).toThrow();
  });

  it("resolves a relative db_path against the config file's directory, not cwd", async () => {
    // A relative db_path must resolve to the same absolute path for every process (broker,
    // server, doorbell watcher) regardless of their cwd, or they would derive different
    // doorbell marker locations and the wake would silently never fire. Anchoring on the
    // config file's directory gives that cwd-independent agreement.
    const tmpPath = "/tmp/test-claude-peers-reldb.json";
    await Bun.write(tmpPath, JSON.stringify({
      machine: "m", tailscale_ip: "100.0.0.1", port: 7899, id_prefix: "tst",
      siblings: [], allowed_ips: ["127.0.0.1"], db_path: "state/peers.db",
    }));
    const config = loadConfig(tmpPath);
    expect(config.db_path).toBe("/tmp/state/peers.db");
  });

  it("leaves an absolute db_path unchanged", async () => {
    const tmpPath = "/tmp/test-claude-peers-absdb.json";
    await Bun.write(tmpPath, JSON.stringify({
      machine: "m", tailscale_ip: "100.0.0.1", port: 7899, id_prefix: "tst",
      siblings: [], allowed_ips: ["127.0.0.1"], db_path: "/var/lib/peers.db",
    }));
    expect(loadConfig(tmpPath).db_path).toBe("/var/lib/peers.db");
  });
});

describe("floor_remote_forwards", () => {
  // Secure-by-default: an absent flag floors remote forwards (queued for
  // check_messages) so a remote machine cannot auto-paste into a live pane
  // without the operator opting in. Cross-node push is enabled per machine by
  // setting the flag false explicitly. Until federation traffic is authenticated
  // (per-message secret/signature), this is the safe resting posture.
  it("defaults to true when absent", async () => {
    const path = "/tmp/cfg-floor-absent.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19001,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    expect(loadConfig(path).floor_remote_forwards).toBe(true);
  });

  it("reads false when explicitly set to false (opt in to cross-node push)", async () => {
    const path = "/tmp/cfg-floor-false.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19003,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
      floor_remote_forwards: false,
    }));
    expect(loadConfig(path).floor_remote_forwards).toBe(false);
  });

  it("reads true when set", async () => {
    const path = "/tmp/cfg-floor-true.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19002,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
      floor_remote_forwards: true,
    }));
    expect(loadConfig(path).floor_remote_forwards).toBe(true);
  });
});

describe("push_delay_ms", () => {
  // The window a "normal"-urgency message waits queued before the broker pushes it
  // anyway. Long enough for the recipient to hit a task boundary and poll (the cheap
  // path — no inference turn), short enough that unpolled mail still arrives promptly.
  it("defaults to 120000 when absent", async () => {
    const path = "/tmp/cfg-delay-absent.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19004,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    expect(loadConfig(path).push_delay_ms).toBe(120_000);
  });

  it("reads an explicit number", async () => {
    const path = "/tmp/cfg-delay-set.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19005,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
      push_delay_ms: 5_000,
    }));
    expect(loadConfig(path).push_delay_ms).toBe(5_000);
  });

  it("falls back to the default on a negative or non-numeric value", async () => {
    const path = "/tmp/cfg-delay-bad.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19006,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
      push_delay_ms: "soon",
    }));
    expect(loadConfig(path).push_delay_ms).toBe(120_000);
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19006,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
      push_delay_ms: -1,
    }));
    expect(loadConfig(path).push_delay_ms).toBe(120_000);
  });
});

describe("auto_summary", () => {
  // The registration-time git snapshot ("[auto] branch; recent files") gossips to sibling
  // brokers like any summary. Branch and file names are same-class metadata as the cwd and
  // git_root fields that already federate, so the seed defaults on — but an operator
  // federating across a sensitive boundary can switch it off without losing set_summary.
  it("defaults to true when absent", async () => {
    const path = "/tmp/cfg-autosum-absent.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19007,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
    }));
    expect(loadConfig(path).auto_summary).toBe(true);
  });

  it("reads false when explicitly set (opt out of the git-seeded summary)", async () => {
    const path = "/tmp/cfg-autosum-false.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19008,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
      auto_summary: false,
    }));
    expect(loadConfig(path).auto_summary).toBe(false);
  });

  it("treats a non-boolean value as the default (tuning knob, not a startup gate)", async () => {
    const path = "/tmp/cfg-autosum-bad.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19009,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
      auto_summary: "nope",
    }));
    expect(loadConfig(path).auto_summary).toBe(true);
  });
});

describe("single-host default (zero-config fresh install)", () => {
  // A fresh single-host install requests no config and has no ~/.claude-peers.json yet, so
  // loadConfig returns this loopback-only default. The default is tested directly because the
  // trigger (the absent DEFAULT path) can't be forced on a dev box where that file exists.
  it("singleHostDefault is a valid loopback-only config", () => {
    const config = singleHostDefault();
    expect(config.port).toBe(7899);
    expect(config.siblings).toEqual([]);
    expect(config.allowed_ips).toContain("127.0.0.1");
    expect(config.tailscale_ip).toBe("127.0.0.1");
    expect(config.floor_remote_forwards).toBe(true);
    expect(config.machine.length).toBeGreaterThan(0);
    expect(config.id_prefix).toMatch(/^[a-z0-9]+$/);
    expect(config.id_prefix.length).toBeGreaterThanOrEqual(1);
    expect(config.id_prefix.length).toBeLessThanOrEqual(3);
  });

  it("throws on an explicit missing path (only the default path defaults)", () => {
    // A caller that passes a path MEANT to load it — a missing explicit config is a real
    // misconfiguration, not a fresh install, so it must fail loudly rather than default.
    expect(() => loadConfig("/tmp/definitely-absent-peers.json")).toThrow();
  });

  it("throws when CLAUDE_PEERS_CONFIG points at a missing file (deploy misconfig fails loudly)", () => {
    const prev = process.env.CLAUDE_PEERS_CONFIG;
    process.env.CLAUDE_PEERS_CONFIG = "/tmp/definitely-absent-env-peers.json";
    try {
      expect(() => loadConfig()).toThrow();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PEERS_CONFIG;
      else process.env.CLAUDE_PEERS_CONFIG = prev;
    }
  });

  it("still throws on a present-but-incomplete file (does not loosen validation)", async () => {
    await Bun.write("/tmp/cfg-present-incomplete.json", JSON.stringify({ machine: "only-machine" }));
    expect(() => loadConfig("/tmp/cfg-present-incomplete.json")).toThrow();
  });

  it("still throws when the config path is unreadable (a directory -> EISDIR, not absence)", () => {
    // A path that exists but cannot be read as a file is an explicit misconfiguration and
    // must fail loudly, not silently default.
    expect(() => loadConfig("/tmp")).toThrow();
  });
});
