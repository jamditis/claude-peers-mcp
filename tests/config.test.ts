import { describe, it, expect } from "bun:test";
import { loadConfig, type PeersConfig } from "../shared/config.ts";

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

  it("throws if config file is missing", () => {
    expect(() => loadConfig("/tmp/nonexistent-peers.json")).toThrow();
  });

  it("throws if required fields are missing", async () => {
    const tmpPath = "/tmp/test-claude-peers-bad.json";
    await Bun.write(tmpPath, JSON.stringify({ machine: "test" }));
    expect(() => loadConfig(tmpPath)).toThrow();
  });
});

describe("floor_remote_forwards", () => {
  it("defaults to false when absent", async () => {
    const path = "/tmp/cfg-floor-absent.json";
    await Bun.write(path, JSON.stringify({
      machine: "m", tailscale_ip: "127.0.0.1", port: 19001,
      id_prefix: "m", siblings: [], allowed_ips: ["127.0.0.1"],
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
