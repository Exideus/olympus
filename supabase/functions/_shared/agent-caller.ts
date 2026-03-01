/**
 * Shared Agent Caller — Multi-provider LLM calling for OLYMPUS agents.
 *
 * Supports: Anthropic (with optional tool use), Kimi/Moonshot, Ollama, OpenAI-compatible.
 * Routing is based on the agent's `api_endpoint` field from the agents table.
 */

import type { AgentRecord, AgentResponse, AgentResponseWithTools, CommitCodeInput, ProgressUpdateInput } from "./types.ts";
import { getSupabase } from "./event-bus.ts";

const OLLAMA_URL = Deno.env.get("OLLAMA_BASE_URL") || "http://172.29.96.1:11434";
const KIMI_KEY = Deno.env.get("KIMI_API_KEY") || "";

// ============================================================
// Tool Definitions (for Anthropic tool-use agents)
// ============================================================

export const AGENT_TOOLS = [
  {
    name: "commit_code",
    description:
      "Commit code files to the repository. Use this whenever you write code that should be saved. Do NOT paste code into the chat — always use this tool instead.",
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Files to commit",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "File path relative to repo root",
              },
              content: { type: "string", description: "Full file content" },
              action: {
                type: "string",
                enum: ["create", "update", "delete"],
                description: "What to do with this file",
              },
            },
            required: ["path", "content", "action"],
          },
        },
        branch: { type: "string", description: "Branch name" },
        commit_message: { type: "string", description: "Commit message" },
      },
      required: ["files", "branch", "commit_message"],
    },
  },
  {
    name: "update_progress",
    description:
      "Update your current task progress so the team knows where you are.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["planning", "coding", "testing", "committing", "done", "blocked"],
          description: "Current status",
        },
        percent: { type: "number", description: "Progress percentage 0-100" },
        message: { type: "string", description: "Short status message" },
      },
      required: ["status", "percent", "message"],
    },
  },
];

// ============================================================
// Provider Detection
// ============================================================

type Provider = "anthropic" | "kimi" | "ollama" | "openai_compatible";

function detectProvider(endpoint: string): Provider {
  if (endpoint.includes("anthropic.com")) return "anthropic";
  if (endpoint.includes("moonshot.cn")) return "kimi";
  if (
    endpoint.includes("localhost") ||
    endpoint.includes("172.") ||
    endpoint.includes("ollama")
  )
    return "ollama";
  return "openai_compatible";
}

// ============================================================
// Lightweight Call (for hand-raise, short prompts — no tools)
// ============================================================

export async function callAgentLightweight(
  agentRecord: AgentRecord,
  systemPrompt: string,
  message: string,
  maxTokens: number,
  timeoutMs = 10000
): Promise<string> {
  const endpoint = agentRecord.api_endpoint!;
  const provider = detectProvider(endpoint);

  switch (provider) {
    case "anthropic": {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: agentRecord.api_model || "claude-sonnet-4-5-20250929",
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: message }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
      const data = await res.json();
      return data.content[0].text;
    }
    case "kimi": {
      if (!KIMI_KEY) throw new Error("KIMI_API_KEY not set");
      const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${KIMI_KEY}`,
        },
        body: JSON.stringify({
          model: agentRecord.api_model || "moonshot-v1-auto",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Kimi error ${res.status}`);
      const data = await res.json();
      return data.choices[0].message.content;
    }
    case "ollama": {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agentRecord.api_model || "qwen2.5-coder:32b",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs + 5000),
      });
      if (!res.ok) throw new Error(`Ollama error ${res.status}`);
      const data = await res.json();
      return data.message.content;
    }
    default: {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agentRecord.api_model || "gpt-4",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }
  }
}

// ============================================================
// Full Call (no tools — Kimi, Ollama, OpenAI-compatible)
// ============================================================

export async function callAgent(
  agentRecord: AgentRecord,
  systemPrompt: string,
  message: string,
  maxTokens = 1024,
  timeoutMs = 30000
): Promise<AgentResponse> {
  const endpoint = agentRecord.api_endpoint!;
  const provider = detectProvider(endpoint);

  switch (provider) {
    case "anthropic": {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: agentRecord.api_model || "claude-sonnet-4-5-20250929",
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: message }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Anthropic error ${res.status}: ${errBody.substring(0, 200)}`);
      }
      const data = await res.json();
      return {
        text: data.content[0].text,
        tokensUsed: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      };
    }
    case "kimi": {
      if (!KIMI_KEY) throw new Error("KIMI_API_KEY not set");
      const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${KIMI_KEY}`,
        },
        body: JSON.stringify({
          model: agentRecord.api_model || "moonshot-v1-auto",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Kimi error ${res.status}`);
      const data = await res.json();
      return {
        text: data.choices[0].message.content,
        tokensUsed: data.usage?.total_tokens || 0,
      };
    }
    case "ollama": {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agentRecord.api_model || "qwen2.5-coder:32b",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs + 30000),
      });
      if (!res.ok) throw new Error(`Ollama error ${res.status}`);
      const data = await res.json();
      return {
        text: data.message.content,
        tokensUsed: (data.eval_count || 0) + (data.prompt_eval_count || 0),
      };
    }
    default: {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agentRecord.api_model || "gpt-4",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`API error at ${endpoint}: ${res.status}`);
      const data = await res.json();
      return {
        text: data.choices?.[0]?.message?.content || "No response",
        tokensUsed: data.usage?.total_tokens || 0,
      };
    }
  }
}

// ============================================================
// Anthropic with Tool Use
// ============================================================

export async function callAnthropicWithTools(
  systemPrompt: string,
  message: string,
  model: string,
  agentName: string,
  roomId: string,
  tools = AGENT_TOOLS
): Promise<AgentResponseWithTools> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
      tools,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await res.json();
  const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

  const textParts: string[] = [];
  const toolsUsed: string[] = [];

  for (const block of data.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolsUsed.push(block.name);
      if (block.name === "commit_code") {
        await handleCommitCode(block.input as CommitCodeInput, agentName, roomId);
      } else if (block.name === "update_progress") {
        await handleProgressUpdate(block.input as ProgressUpdateInput, agentName, roomId);
      }
    }
  }

  // Continue conversation if model wants to use tools
  if (data.stop_reason === "tool_use") {
    const toolResults = data.content
      .filter((b: Record<string, unknown>) => b.type === "tool_use")
      .map((b: Record<string, unknown>) => ({
        type: "tool_result",
        tool_use_id: b.id,
        content:
          b.name === "commit_code"
            ? "Code queued in execution pipeline. Branch will be created and deployed."
            : "Progress update saved.",
      }));

    const followUp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          { role: "user", content: message },
          { role: "assistant", content: data.content },
          { role: "user", content: toolResults },
        ],
        tools,
      }),
    });

    if (followUp.ok) {
      const followUpData = await followUp.json();
      for (const block of followUpData.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        }
      }
    }
  }

  return { text: textParts.join("\n"), tokensUsed, toolsUsed };
}

// ============================================================
// Unified Agent Call — auto-detects provider, uses tools for Anthropic
// ============================================================

export async function callAgentWithTools(
  agentRecord: AgentRecord,
  userMessage: string,
  context: string,
  agentName: string,
  roomId: string
): Promise<AgentResponseWithTools> {
  if (agentName === "ARGOS" && !agentRecord?.api_endpoint) {
    return {
      text: `🔱 ARGOS acknowledges your message. Orchestrator integration is being configured.`,
      tokensUsed: 0,
      toolsUsed: [],
    };
  }

  if (!agentRecord) {
    throw new Error(`Agent "${agentName}" not found in agents table.`);
  }

  if (!agentRecord.api_endpoint) {
    throw new Error(`No API endpoint configured for ${agentName}.`);
  }

  const systemPrompt =
    agentRecord.system_prompt ||
    `You are ${agentName}, a ${agentRecord.role} in the OLYMPUS system.`;

  const fullPrompt = `${systemPrompt}\n\n${context}`;
  const provider = detectProvider(agentRecord.api_endpoint);

  if (provider === "anthropic") {
    return callAnthropicWithTools(
      fullPrompt,
      userMessage,
      agentRecord.api_model || "claude-sonnet-4-5-20250929",
      agentName,
      roomId
    );
  }

  // Non-Anthropic: fallback to plain call (no tool use)
  const resp = await callAgent(agentRecord, fullPrompt, userMessage);
  return { ...resp, toolsUsed: [] };
}

// ============================================================
// Tool Handlers
// ============================================================

async function handleCommitCode(
  input: CommitCodeInput,
  agentName: string,
  roomId: string
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from("execution_queue").insert({
    room_id: roomId,
    requested_by: agentName,
    execution_type: "code_commit",
    payload: {
      files: input.files,
      branch: input.branch,
      commit_message: input.commit_message,
      base_branch: input.base_branch || "main",
    },
    status: "pending",
  });

  if (error) {
    console.error("Failed to insert execution_queue:", error);
    throw new Error(`Failed to queue code commit: ${error.message}`);
  }

  await supabase.from("war_room_messages").insert({
    room_id: roomId,
    sender_name: "EXECUTION BRIDGE",
    sender_type: "system",
    content: `📦 **${agentName}** submitted code:\n• Branch: \`${input.branch}\`\n• ${input.files.length} file(s)\n• Commit: "${input.commit_message}"\n\n⏳ Being committed and deployed...`,
    metadata: { is_system_message: true, execution_pending: true },
  });
}

async function handleProgressUpdate(
  input: ProgressUpdateInput,
  agentName: string,
  roomId: string
): Promise<void> {
  const supabase = getSupabase();

  const statusEmoji: Record<string, string> = {
    planning: "📋",
    coding: "⌨️",
    testing: "🧪",
    committing: "📦",
    done: "✅",
    blocked: "🚫",
  };

  const emoji = statusEmoji[input.status] || "🔄";
  const filled = Math.round(input.percent / 10);
  const empty = 10 - filled;
  const progressBar = "█".repeat(filled) + "░".repeat(empty);

  await supabase.from("war_room_messages").insert({
    room_id: roomId,
    sender_name: agentName,
    sender_type: "agent",
    content: `${emoji} ${progressBar} ${input.percent}%\n${input.message}`,
    content_type: "text",
    metadata: {
      is_progress_update: true,
      progress_status: input.status,
      progress_percent: input.percent,
    },
  });
}
