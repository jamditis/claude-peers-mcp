import type { PeerId } from "./types.ts";

export interface BrokerRecovery {
  previousId: PeerId | null;
}

export interface BrokerFetchOptions {
  recover?: boolean;
}

export type BrokerFetch = <T>(
  path: string,
  body: unknown,
  options?: BrokerFetchOptions,
) => Promise<T>;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface BrokerFetchDependencies {
  brokerUrl: string;
  getAuthToken: () => string | null;
  getPeerId: () => PeerId | null;
  recover: () => Promise<BrokerRecovery>;
  fetch?: FetchLike;
}

const PEER_ID_FIELDS = ["id", "from_id", "exclude_id"] as const;
const CONNECTION_REFUSED_CODES = new Set(["ConnectionRefused", "ECONNREFUSED"]);

export class BrokerHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Broker error (${path}): ${status} ${detail}`);
    this.name = "BrokerHttpError";
  }
}

export function isConnectionRefused(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (
      typeof candidate.code === "string"
      && CONNECTION_REFUSED_CODES.has(candidate.code)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function rebindPeerIdentity(
  body: unknown,
  previousId: PeerId | null,
  currentId: PeerId | null,
): unknown {
  if (
    !previousId
    || !currentId
    || previousId === currentId
    || !body
    || typeof body !== "object"
    || Array.isArray(body)
  ) {
    return body;
  }

  const rebound = { ...body as Record<string, unknown> };
  for (const field of PEER_ID_FIELDS) {
    if (rebound[field] === previousId) rebound[field] = currentId;
  }
  return rebound;
}

export function createRecoveringBrokerFetch(
  dependencies: BrokerFetchDependencies,
): BrokerFetch {
  const fetchBroker = dependencies.fetch ?? fetch;
  let recoveryInFlight: Promise<BrokerRecovery> | null = null;

  function recoverSingleFlight(): Promise<BrokerRecovery> {
    if (recoveryInFlight) return recoveryInFlight;

    const tracked = dependencies.recover().finally(() => {
      if (recoveryInFlight === tracked) recoveryInFlight = null;
    });
    recoveryInFlight = tracked;
    return tracked;
  }

  async function request<T>(
    path: string,
    body: unknown,
    allowRecovery: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = dependencies.getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetchBroker(`${dependencies.brokerUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      // A refused connection proves the broker never accepted the request, so one
      // retry is safe. Other transport failures are ambiguous: the broker may have
      // committed the operation before the response was lost.
      if (
        !allowRecovery
        || path === "/register"
        || !isConnectionRefused(error)
      ) {
        throw error;
      }
      const recovery = await recoverSingleFlight();
      return request<T>(
        path,
        rebindPeerIdentity(
          body,
          recovery.previousId,
          dependencies.getPeerId(),
        ),
        false,
      );
    }

    // A fresh broker rejects the old capability before dispatching the request.
    // Re-registering and retrying once is therefore side-effect safe.
    if (allowRecovery && path !== "/register" && response.status === 401) {
      const recovery = await recoverSingleFlight();
      return request<T>(
        path,
        rebindPeerIdentity(
          body,
          recovery.previousId,
          dependencies.getPeerId(),
        ),
        false,
      );
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new BrokerHttpError(path, response.status, detail);
    }
    return response.json() as Promise<T>;
  }

  const brokerFetch: BrokerFetch = async <T>(
    path: string,
    body: unknown,
    options: BrokerFetchOptions = {},
  ) => {
    const allowRecovery = options.recover !== false;
    let requestBody = body;
    // A caller arriving during recovery must not race registration with an old
    // token. Share the in-flight recovery and rewrite its principal fields
    // before doing any new broker I/O.
    if (allowRecovery && recoveryInFlight) {
      const recovery = await recoveryInFlight;
      requestBody = rebindPeerIdentity(
        requestBody,
        recovery.previousId,
        dependencies.getPeerId(),
      );
    }

    // /list-peers is token-exempt at the broker, so a fresh empty-DB broker
    // would answer it successfully without revealing that this session's old
    // capability is unknown. Send one lightweight authenticated liveness probe
    // first. A healthy broker answers directly; only a 401 or refused connection
    // escalates through the full recovery path.
    const probeId =
      path === "/list-peers" ? dependencies.getPeerId() : null;
    if (allowRecovery && probeId) {
      try {
        await request(
          "/heartbeat",
          { id: probeId, probe_only: true },
          true,
        );
        requestBody = rebindPeerIdentity(
          requestBody,
          probeId,
          dependencies.getPeerId(),
        );
      } catch (error) {
        // A retiring broker rejects heartbeat probes with 503 but deliberately
        // keeps /list-peers readable. Preserve that transient read behavior;
        // authenticated operations still surface the 503, and a later listing
        // probes the replacement broker again.
        if (
          !(error instanceof BrokerHttpError)
          || error.status !== 503
        ) {
          throw error;
        }
      }
    }
    return request<T>(path, requestBody, allowRecovery);
  };

  return brokerFetch;
}
