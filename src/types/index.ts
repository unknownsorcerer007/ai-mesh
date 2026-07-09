// Pulse — Core Types

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

export interface Message {
  id: string;
  group_id: string;
  sender_id: string;
  sender_ai: string | null;
  message_type: 'text' | 'code' | 'alert' | 'system';
  content: string;
  metadata: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface PendingMessage {
  id: string;
  message_id: string;
  recipient_id: string;
  status: 'pending' | 'delivered' | 'expired';
  created_at: string;
  expires_at: string;
}

export interface JoinRequest {
  id: string;
  group_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

// MCP tool input types
export interface SendMessageInput {
  group_id: string;
  message: string;
  type?: 'text' | 'code' | 'alert' | 'system';
  metadata?: Record<string, unknown>;
}

export interface ReceiveMessageInput {
  group_id?: string;
  limit?: number;
}

export interface CreateGroupInput {
  name: string;
  description?: string;
  group_type?: 'team' | 'project' | 'open';
}

export interface JoinGroupInput {
  invite_code: string;
}

export interface GetGroupHistoryInput {
  group_id: string;
  limit?: number;
  before?: string;
}

export interface TranslateMessageInput {
  message: string;
  target_lang?: string;
}

export interface ApproveJoinInput {
  request_id: string;
  approve: boolean;
}

// WebSocket events
export interface WsEvent {
  type: 'message' | 'join_request' | 'member_joined' | 'member_left' | 'typing' | 'error';
  payload: unknown;
  group_id?: string;
  timestamp: string;
}
