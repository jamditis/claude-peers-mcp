import { describe, it, expect } from "bun:test";
import { loadConfig, type PeersConfig } from "../shared/config.ts";

describe("loadConfig", () => {
  it("loads config from a file path", () => {
    const tmpPath = "/tmp/test-claude-peers.json";
    Bun.write(tmpPath, JSON.stringify({
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

  it("throws if required fields are missing", () => {
    const tmpPath = "/tmp/test-claude-peers-bad.json";
    Bun.write(tmpPath, JSON.stringify({ machine: "test" }));
    expect(() => loadConfig(tmpPath)).toThrow();
  });
});
