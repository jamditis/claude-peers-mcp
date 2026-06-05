// shared/types.ts
export type PeerId = string;

export type DeliveryKind = "tmux" | "launcher" | "none";
export type DeliveryState = "queued" | "delivering" | "delivered";

// Broker wire-protocol version. Bumped to 2 for the delivery_state schema and
// delivery backends; to 3 for per-session capability tokens (a registered peer may
// act only as the id it holds the token for). server.ts requires at least this from
// a running broker.
export const PROTOCOL_VERSION = 3;

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
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  routed?: "local" | "remote";
  // "accepted" = pushed into the recipient's live session; "queued" = left for
  // their next check_messages. (No "injected": only these two states occur in M1.)
  delivery?: "accepted" | "queued";
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
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
}

export interface ForwardMessageResponse {
  ok: boolean;
  // Disposition of the auto-inject the receiving broker attempted for this forward:
  // "accepted" = pushed into the recipient's live tmux session; "queued" = left for
  // their next check_messages (e.g. floor_remote_forwards, no tmux backend, or a failed
  // push). Absent when ok is false (no recipient to deliver to).
  delivery?: "accepted" | "queued";
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
