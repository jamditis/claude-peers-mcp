// shared/types.ts
export type PeerId = string;

export type DeliveryKind = "tmux" | "launcher" | "none";
export type DeliveryState = "queued" | "delivering" | "delivered";

// Broker wire-protocol version. Bumped to 2 for the delivery_state schema and
// delivery backends. server.ts requires at least this from a running broker.
export const PROTOCOL_VERSION = 2;

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
