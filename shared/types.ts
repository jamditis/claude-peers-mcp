// shared/types.ts
export type PeerId = string;

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
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string;
  delivered: boolean;
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
