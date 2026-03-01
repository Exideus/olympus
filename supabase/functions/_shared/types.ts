// Shared types for OLYMPUS Supabase Edge Functions

// ============================================================
// Agent Types
// ============================================================

export interface AgentRecord {
  name: string;
  role: string;
  session_key: string;
  api_endpoint: string | null;
  api_model: string | null;
  system_prompt: string | null;
  model_primary: string | null;
  model_escalation: string | null;
  voice_id: string | null;
  capabilities?: string[];
  agent_type?: AgentType;
}

export type AgentType =
  | "orchestrator"
  | "code"
  | "review"
  | "testing"
  | "infra"
  | "security"
  | "docs"
  | "design"
  | "product"
  | "content"
  | "human";

export interface AgentResponse {
  text: string;
  tokensUsed: number;
  routingReason?: string;
}

export interface AgentResponseWithTools extends AgentResponse {
  toolsUsed: string[];
}

export interface HandRaiseResult {
  wants_to_speak: boolean;
  reason: string;
}

// ============================================================
// Event Bus Types
// ============================================================

export type EventChannel =
  | "orchestrator"
  | "code"
  | "review"
  | "testing"
  | "security"
  | "docs"
  | "design"
  | "product"
  | "content"
  | "infra"
  | "broadcast";

export type EventStatus = "pending" | "processing" | "completed" | "failed";

export interface AgentEvent {
  id?: string;
  event_type: string;
  channel: EventChannel;
  source_agent: string;
  target_agent?: string | null;
  payload: Record<string, unknown>;
  correlation_id?: string;
  parent_event_id?: string | null;
  status?: EventStatus;
  created_at?: string;
  processed_at?: string | null;
  expires_at?: string | null;
}

export interface AgentSubscription {
  agent_name: string;
  channel: EventChannel;
  event_types: string[];
}

// ============================================================
// Tool Types
// ============================================================

export interface CommitCodeInput {
  files: Array<{
    path: string;
    content: string;
    action: "create" | "update" | "delete";
  }>;
  branch: string;
  commit_message: string;
  base_branch?: string;
}

export interface ProgressUpdateInput {
  status: "planning" | "coding" | "testing" | "committing" | "done" | "blocked";
  percent: number;
  message: string;
}

// ============================================================
// CORS Headers
// ============================================================

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
};

// ============================================================
// Helper
// ============================================================

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
