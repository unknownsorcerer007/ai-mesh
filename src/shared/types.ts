// Shared Types — used across all blocks

export interface User {
  id: string;
  username: string;
  hash_id: string;
  public_key: string;
  github_id: string | null;
  github_username: string | null;
  created_at: string;
  updated_at: string;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  invite_code: string;
  admin_id: string;
  max_members: number;
  group_type: 'team' | 'project' | 'open';
  created_at: string;
}

export interface GroupMember {
  id: string;
  group_id: string;
  user_id: string;
  role: 'admin' | 'member';
  joined_at: string;
}

export interface JoinRequest {
  id: string;
  group_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

export interface RelayMessage {
  id: string;
  group_id: string;
  sender_id: string;
  sender_username: string;
  sender_ai?: string;
  type: 'text' | 'code' | 'alert' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface RelayEvent {
  type: 'join_request' | 'join_rejected' | 'member_joined' | 'member_left' | 'notification' | 'approval' | 'error';
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface WsEvent {
  type: 'message' | 'join_request' | 'member_joined' | 'member_left' | 'typing' | 'error' | 'connected' | 'pong';
  payload: unknown;
  group_id?: string;
  timestamp: string;
}
