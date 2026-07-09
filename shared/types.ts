// shared/types.ts
export type PeerId = string;

export type DeliveryKind = "tmux" | "launcher" | "none";
export type DeliveryState = "queued" | "delivering" | "delivered";

// How a message reaches the recipient. "interrupt" pushes into their session at once
// (and flushes their pending pushable mail with it). "normal" queues: delivered at the
// recipient's next check_messages, or auto-pushed once push_delay_ms elapses. "fyi"
// never auto-pushes — poll-only, no reply expected. Absent on the wire = "interrupt",
// so a pre-urgency client keeps its old push-on-send behavior.
export type Urgency = "interrupt" | "normal" | "fyi";

export const LIST_PEERS_SCOPES = ["machine", "directory", "repo"] as const;
export type ListPeersScope = (typeof LIST_PEERS_SCOPES)[number];
export const LIST_PEERS_SCOPE_ERROR = "scope must be one of: machine, directory, repo";

export function isListPeersScope(value: unknown): value is ListPeersScope {
  return typeof value === "string"
    && (LIST_PEERS_SCOPES as readonly string[]).includes(value);
}

export function parseListPeersScope(
  args: unknown,
): { scope: ListPeersScope } | { error: typeof LIST_PEERS_SCOPE_ERROR } {
  const values = args && typeof args === "object"
    ? args as Record<string, unknown>
    : {};
  return isListPeersScope(values.scope)
    ? { scope: values.scope }
    : { error: LIST_PEERS_SCOPE_ERROR };
}

// Broker wire-protocol version. Bumped to 2 for the delivery_state schema and
// delivery backends; to 3 for per-session capability tokens (a registered peer may
// act only as the id it holds the token for); to 4 for urgency tiers and the
// push_after deadline column; to 5 for the /peek route and the delivery_kind='none'
// doorbell (a server holding peek_messages must force a broker that implements /peek
// and writes doorbell markers, or both silently no-op against an older broker);
// to 6 for local-peer heartbeat TTL eviction and the broker-restart grace that lets
// surviving servers refresh stale rows before pruning; to 7 for the peers/remote_peers
// session-name column and the gossiped `name` field (a server that reports a session name
// forces a pre-7 broker to retire, so the name is never silently dropped on register or
// gossip against a broker whose schema predates it); to 8 for send_message address-by-name
// resolution (a server advertising name sends forces a pre-8 broker to retire, so a name send
// never silently falls back to the old id-only path and fails as "not found" against a broker
// that stores names but cannot resolve them).
// server.ts requires at least this from a running broker.
export const PROTOCOL_VERSION = 8;

// Urgency tiers arrived in protocol 4 (see the history above). A broker older than
// this ignores the urgency field and keeps the old push-on-send behavior, so a
// non-interrupt send to such a broker silently degrades to an interrupt (#30).
export const URGENCY_MIN_PROTOCOL = 4;

export interface Peer {
  id: PeerId;
  pid: number;
  machine: string;
  tailscale_ip: string;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
  is_remote?: boolean;
  // Friendly session name a human uses to refer to this session (e.g. "newsroom", "billing").
  // Unlike the delivery coordinates below, this is public: it rides gossip and appears in
  // list_peers so a remote session can be found by name, not just by opaque id. Null when
  // the session has no resolvable name (a non-tmux session with no override).
  name?: string | null;
  // Local-only delivery coordinates. Never serialized into gossip/forward payloads.
  tmux_pane?: string | null;
  tmux_socket?: string | null;
  delivery_kind?: DeliveryKind;
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string;
  delivery_state: DeliveryState;
  lease_expires_at: number | null;
  lease_token: string | null;
  urgency: Urgency;
  // Epoch ms when this row becomes push-eligible; NULL = never auto-push (fyi, and
  // floored remote forwards). 0/past = due now. See pushAfterFor in delivery.ts.
  push_after: number | null;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  machine: string;
  tailscale_ip: string;
  // Friendly session name, resolved by the server at startup (see resolveSessionName).
  // Optional: absent when the session has no resolvable name.
  name?: string | null;
  tmux_pane?: string | null;
  tmux_socket?: string | null;
}

export interface RegisterResponse {
  id: PeerId;
  // Per-session capability token. The peer presents it (Authorization: Bearer) on every
  // mutating control-plane call; the broker binds the call's principal to it. Loopback-only,
  // never serialized into gossip/forward payloads.
  token: string;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: ListPeersScope;
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  // Absent = "interrupt" (wire back-compat with pre-urgency clients).
  urgency?: Urgency;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  routed?: "local" | "remote";
  // "accepted" = pushed into the recipient's live session; "queued" = left for
  // their next check_messages. (No "injected": only these two states occur in M1.)
  delivery?: "accepted" | "queued";
  // Only set for a remote (forwarded) send, and only meaningful when delivery is
  // "queued": true iff the remote host will never auto-push the row (its stored
  // push_after is NULL because it was floored or sent fyi, or the recipient is not
  // push-eligible there), false iff it is push-eligible there (the remote heartbeat
  // pushes it once due). Absent when the send was local or the remote broker predates
  // the field, so a reader must treat absence as "unknown", not "push-eligible" (#39).
  poll_only?: boolean;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// A non-consuming, recipient-scoped read of the caller's own backlog: the read equivalent of
// /poll-messages minus markPolled (issue #49). Returns how many rows are pending and the
// highest pending id, so a session can learn its own id and whether it has mail without
// flipping any row to delivered — check_messages stays the single consume path. Token-gated to
// the caller's id like every other mutating-principal route; it never marks anything delivered.
export interface PeekMessagesRequest {
  id: PeerId;
}

export interface PeekMessagesResponse {
  // Caller's own peer id, echoed back so a session can discover the id to arm a doorbell with.
  id: PeerId;
  // Rows in delivery_state queued|delivering addressed to the caller.
  count: number;
  // Highest pending row id, or null when count is 0. Matches the doorbell marker counter, so a
  // watcher can use it as the baseline to arm with.
  max_id: number | null;
}

// --- Federation types ---

export interface GossipRequest {
  protocol_version: number;
  machine: string;
  tailscale_ip: string;
  peers: Peer[];
}

export interface ForwardMessageRequest {
  protocol_version: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  from_machine: string;
  // Absent = "interrupt" (a pre-urgency sibling broker). The receiving broker applies
  // its own push_delay_ms; floor_remote_forwards overrides to never-push regardless.
  urgency?: Urgency;
}

export interface ForwardMessageResponse {
  ok: boolean;
  // Disposition of the auto-inject the receiving broker attempted for this forward:
  // "accepted" = pushed into the recipient's live tmux session; "queued" = left for
  // their next check_messages (e.g. floor_remote_forwards, no tmux backend, or a failed
  // push). Absent when ok is false (no recipient to deliver to).
  delivery?: "accepted" | "queued";
  // Whether this host will never auto-push the forwarded row, so it is poll-only here:
  // true when the stored push_after is NULL (floored via floor_remote_forwards, or an fyi
  // whose pushAfterFor is NULL) or when the recipient is not push-eligible on this host at
  // all (a delivery_kind='none' session, a paneless row, or no tmux backend). Lets the
  // originating broker tell its sender whether a "queued" remote message waits for
  // check_messages or still gets pushed by this host's heartbeat. Absent from a broker
  // predating the field, which the sender-side reader treats as unknown rather than
  // push-eligible (#39).
  poll_only?: boolean;
}

// The parsed body of a control-plane request. Each route reads only the fields of its own
// request type; the switch on `path` selects which. The control plane is loopback-gated and the
// only client is our own MCP server, which constructs these exact shapes, so the broker trusts
// the parsed body — this intersection restores the field types `req.json()` erases to `unknown`.
// No field name collides across the members (every shared key — id/from_id/to_id/summary/machine/
// tailscale_ip/protocol_version — has the same type), so the intersection is internally consistent
// and is assignable to each handler's parameter type.
export type ControlPlaneRequest = RegisterRequest &
  HeartbeatRequest &
  SetSummaryRequest &
  ListPeersRequest &
  SendMessageRequest &
  PollMessagesRequest &
  GossipRequest &
  ForwardMessageRequest;
