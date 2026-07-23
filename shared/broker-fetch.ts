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
    // A call arriving after another call started recovery must not race the
    // registration with an old token or let a token-exempt read observe the
    // replacement broker before this session exists there.
    if (allowRecovery && recoveryInFlight) {
      const recovery = await recoveryInFlight;
      requestBody = rebindPeerIdentity(
        requestBody,
        recovery.previousId,
        dependencies.getPeerId(),
      );
    }
    return request<T>(path, requestBody, allowRecovery);
  };

  return brokerFetch;
}
