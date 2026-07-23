import { describe, expect, it } from "bun:test";
import {
  createRecoveringBrokerFetch,
  isConnectionRefused,
  rebindPeerIdentity,
} from "../shared/broker-fetch.ts";

function refusedConnection(): Error & { code: string } {
  return Object.assign(new Error("broker is down"), {
    code: "ConnectionRefused",
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("isConnectionRefused", () => {
  it("recognizes Bun and Node refusal codes, including a nested cause", () => {
    expect(isConnectionRefused(refusedConnection())).toBe(true);
    expect(isConnectionRefused({
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    })).toBe(true);
  });

  it("does not treat an ambiguous transport failure as safe to retry", () => {
    expect(isConnectionRefused(new Error("connection reset"))).toBe(false);
    expect(isConnectionRefused({ code: "ECONNRESET" })).toBe(false);
  });
});

describe("rebindPeerIdentity", () => {
  it("moves only the caller's principal fields to the recovered peer id", () => {
    expect(rebindPeerIdentity({
      id: "old-id",
      from_id: "old-id",
      exclude_id: "old-id",
      to_id: "old-id",
      text: "old-id",
    }, "old-id", "new-id")).toEqual({
      id: "new-id",
      from_id: "new-id",
      exclude_id: "new-id",
      to_id: "old-id",
      text: "old-id",
    });
  });
});

describe("createRecoveringBrokerFetch", () => {
  it("recovers a refused connection, rebinds the peer id, and retries once", async () => {
    let peerId = "old-id";
    let token = "old-token";
    let requests = 0;
    let recoveries = 0;
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => token,
      getPeerId: () => peerId,
      recover: async () => {
        recoveries++;
        const previousId = peerId;
        peerId = "new-id";
        token = "new-token";
        return { previousId };
      },
      fetch: async (_url, init) => {
        requests++;
        if (requests === 1) throw refusedConnection();
        expect(init?.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: "Bearer new-token",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          from_id: "new-id",
          to_id: "recipient",
        });
        return Response.json({ ok: true });
      },
    });

    await expect(brokerFetch("/send-message", {
      from_id: "old-id",
      to_id: "recipient",
    })).resolves.toEqual({ ok: true });
    expect(requests).toBe(2);
    expect(recoveries).toBe(1);
  });

  it("re-registers on a 401 before retrying with the new identity", async () => {
    let peerId = "old-id";
    let token = "old-token";
    let requests = 0;
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => token,
      getPeerId: () => peerId,
      recover: async () => {
        const previousId = peerId;
        peerId = "new-id";
        token = "new-token";
        return { previousId };
      },
      fetch: async (_url, init) => {
        requests++;
        if (requests === 1) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        expect(JSON.parse(String(init?.body))).toEqual({ id: "new-id" });
        return Response.json({ ok: true });
      },
    });

    await expect(
      brokerFetch("/heartbeat", { id: "old-id" }),
    ).resolves.toEqual({ ok: true });
    expect(requests).toBe(2);
  });

  it("uses a lightweight probe without full recovery on a healthy peer listing", async () => {
    let recoveries = 0;
    const observed: Array<{ path: string; body: unknown }> = [];
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => "token",
      getPeerId: () => "peer",
      recover: async () => {
        recoveries++;
        return { previousId: "peer" };
      },
      fetch: async (url, init) => {
        const path = new URL(
          url instanceof Request ? url.url : url,
        ).pathname;
        observed.push({
          path,
          body: JSON.parse(String(init?.body)),
        });
        return path === "/list-peers"
          ? Response.json([])
          : Response.json({ ok: true });
      },
    });

    await expect(
      brokerFetch("/list-peers", { exclude_id: "peer" }),
    ).resolves.toEqual([]);
    expect(recoveries).toBe(0);
    expect(observed).toEqual([
      {
        path: "/heartbeat-probe",
        body: { id: "peer" },
      },
      {
        path: "/list-peers",
        body: { exclude_id: "peer" },
      },
    ]);
  });

  it("probes registration before a token-exempt peer listing", async () => {
    let peerId = "old-id";
    let token = "old-token";
    let recoveries = 0;
    const observed: Array<{ path: string; body: unknown; token: string }> = [];
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => token,
      getPeerId: () => peerId,
      recover: async () => {
        recoveries++;
        const previousId = peerId;
        peerId = "new-id";
        token = "new-token";
        return { previousId };
      },
      fetch: async (url, init) => {
        const path = new URL(
          url instanceof Request ? url.url : url,
        ).pathname;
        const token = (init?.headers as Record<string, string>).Authorization ?? "";
        observed.push({
          path,
          body: JSON.parse(String(init?.body)),
          token,
        });
        if (path === "/heartbeat-probe" && token === "Bearer old-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return path === "/list-peers"
          ? Response.json([])
          : Response.json({ ok: true });
      },
    });

    await expect(
      brokerFetch("/list-peers", { exclude_id: "old-id" }),
    ).resolves.toEqual([]);
    expect(recoveries).toBe(1);
    expect(observed).toEqual([
      {
        path: "/heartbeat-probe",
        body: { id: "old-id" },
        token: "Bearer old-token",
      },
      {
        path: "/heartbeat-probe",
        body: { id: "new-id" },
        token: "Bearer new-token",
      },
      {
        path: "/list-peers",
        body: { exclude_id: "new-id" },
        token: "Bearer new-token",
      },
    ]);
  });

  it("keeps peer listing readable while a broker rejects its retire-window probe", async () => {
    let requests = 0;
    let recoveries = 0;
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => "token",
      getPeerId: () => "peer",
      recover: async () => {
        recoveries++;
        return { previousId: "peer" };
      },
      fetch: async (url) => {
        requests++;
        const path = new URL(
          url instanceof Request ? url.url : url,
        ).pathname;
        return path === "/heartbeat-probe"
          ? Response.json({ error: "broker retiring" }, { status: 503 })
          : Response.json([]);
      },
    });

    await expect(
      brokerFetch("/list-peers", { exclude_id: "peer" }),
    ).resolves.toEqual([]);
    expect(requests).toBe(2);
    expect(recoveries).toBe(0);
  });

  it("retires a pre-9 broker before its delivery heartbeat can drain mail", async () => {
    let currentBroker = false;
    let recoveries = 0;
    let deliveryDrains = 0;
    const observedPaths: string[] = [];
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => "token",
      getPeerId: () => "peer",
      recover: async () => {
        recoveries++;
        currentBroker = true;
        return { previousId: "peer" };
      },
      fetch: async (url) => {
        const path = new URL(
          url instanceof Request ? url.url : url,
        ).pathname;
        observedPaths.push(path);
        if (path === "/heartbeat") {
          deliveryDrains++;
          return Response.json({ ok: true });
        }
        if (path === "/heartbeat-probe" && !currentBroker) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return path === "/list-peers"
          ? Response.json([])
          : Response.json({ ok: true });
      },
    });

    await expect(
      brokerFetch("/list-peers", { exclude_id: "peer" }),
    ).resolves.toEqual([]);
    expect(recoveries).toBe(1);
    expect(deliveryDrains).toBe(0);
    expect(observedPaths).toEqual([
      "/heartbeat-probe",
      "/list-peers",
    ]);
  });

  it("shares one recovery across concurrent failed operations", async () => {
    let peerId = "old-id";
    let token = "old-token";
    let recoveries = 0;
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => token,
      getPeerId: () => peerId,
      recover: async () => {
        recoveries++;
        const previousId = peerId;
        await Bun.sleep(20);
        peerId = "new-id";
        token = "new-token";
        return { previousId };
      },
      fetch: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === "Bearer old-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({
          id: JSON.parse(String(init?.body)).id,
        });
      },
    });

    const results = await Promise.all([
      brokerFetch("/heartbeat", { id: "old-id" }),
      brokerFetch("/peek", { id: "old-id" }),
    ]);

    expect(recoveries).toBe(1);
    expect(results).toEqual([{ id: "new-id" }, { id: "new-id" }]);
  });

  it("rebinds a late 401 after another request already changed identity", async () => {
    let peerId = "old-id";
    let token = "old-token";
    let recoveries = 0;
    let oldRequests = 0;
    const secondOldRequestStarted = deferred();
    const releaseSecond401 = deferred();
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => token,
      getPeerId: () => peerId,
      recover: async () => {
        recoveries++;
        const previousId = peerId;
        if (recoveries === 1) {
          peerId = "new-id";
          token = "new-token";
        }
        return { previousId };
      },
      fetch: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        const body = JSON.parse(String(init?.body)) as { id: string };
        if (headers.Authorization === "Bearer old-token") {
          oldRequests++;
          if (oldRequests === 2) {
            secondOldRequestStarted.resolve();
            await releaseSecond401.promise;
          }
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (body.id !== peerId) {
          return Response.json({ error: "wrong principal" }, { status: 401 });
        }
        return Response.json({ id: body.id });
      },
    });

    const first = brokerFetch<{ id: string }>(
      "/heartbeat",
      { id: "old-id" },
    );
    const second = brokerFetch<{ id: string }>("/peek", { id: "old-id" });
    await secondOldRequestStarted.promise;
    await expect(first).resolves.toEqual({ id: "new-id" });

    releaseSecond401.resolve();
    await expect(second).resolves.toEqual({ id: "new-id" });
    expect(recoveries).toBe(1);
  });

  it("holds a caller that arrives during recovery until registration settles", async () => {
    let peerId = "old-id";
    let token = "old-token";
    const recoveryStarted = deferred();
    const recoveryCanFinish = deferred();
    const observed: Array<{ path: string; body: unknown; token: string }> = [];
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => token,
      getPeerId: () => peerId,
      recover: async () => {
        const previousId = peerId;
        recoveryStarted.resolve();
        await recoveryCanFinish.promise;
        peerId = "new-id";
        token = "new-token";
        return { previousId };
      },
      fetch: async (url, init) => {
        const path = new URL(
          url instanceof Request ? url.url : url,
        ).pathname;
        const auth = (init?.headers as Record<string, string>).Authorization;
        observed.push({
          path,
          body: JSON.parse(String(init?.body)),
          token: auth ?? "",
        });
        if (auth === "Bearer old-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ ok: true });
      },
    });

    const heartbeat = brokerFetch("/heartbeat", { id: "old-id" });
    await recoveryStarted.promise;
    const listPeers = brokerFetch("/list-peers", {
      exclude_id: "old-id",
    });
    await Bun.sleep(10);
    expect(observed).toHaveLength(1);

    recoveryCanFinish.resolve();
    await Promise.all([heartbeat, listPeers]);

    expect(observed).toContainEqual({
      path: "/list-peers",
      body: { exclude_id: "new-id" },
      token: "Bearer new-token",
    });
  });

  it("does not retry HTTP failures or ambiguous transport failures", async () => {
    let recoveries = 0;
    let mode: "http" | "transport" = "http";
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => "token",
      getPeerId: () => "peer",
      recover: async () => {
        recoveries++;
        return { previousId: "peer" };
      },
      fetch: async () => {
        if (mode === "http") {
          return Response.json({ error: "retiring" }, { status: 503 });
        }
        throw Object.assign(new Error("connection reset"), {
          code: "ECONNRESET",
        });
      },
    });

    await expect(
      brokerFetch("/heartbeat", { id: "peer" }),
    ).rejects.toThrow("Broker error (/heartbeat): 503");
    mode = "transport";
    await expect(
      brokerFetch("/heartbeat", { id: "peer" }),
    ).rejects.toThrow("connection reset");
    expect(recoveries).toBe(0);
  });

  it("bounds recovery to one retry", async () => {
    let requests = 0;
    let recoveries = 0;
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => "token",
      getPeerId: () => "peer",
      recover: async () => {
        recoveries++;
        return { previousId: "peer" };
      },
      fetch: async () => {
        requests++;
        throw refusedConnection();
      },
    });

    await expect(
      brokerFetch("/heartbeat", { id: "peer" }),
    ).rejects.toThrow("broker is down");
    expect(requests).toBe(2);
    expect(recoveries).toBe(1);
  });

  it("can disable recovery for cleanup calls", async () => {
    let recoveries = 0;
    const brokerFetch = createRecoveringBrokerFetch({
      brokerUrl: "http://broker.test",
      getAuthToken: () => "token",
      getPeerId: () => "peer",
      recover: async () => {
        recoveries++;
        return { previousId: "peer" };
      },
      fetch: async () => {
        throw refusedConnection();
      },
    });

    await expect(
      brokerFetch("/unregister", { id: "peer" }, { recover: false }),
    ).rejects.toThrow("broker is down");
    expect(recoveries).toBe(0);
  });
});
