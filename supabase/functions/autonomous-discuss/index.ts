/**
 * Autonomous Discuss — Round-robin agent discussion with summary.
 *
 * Agents take turns discussing a topic, with token budgeting and timeout.
 * Claude summarizes at the end. Uses shared modules for LLM calling.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import type { AgentRecord } from "../_shared/types.ts";
import { CORS_HEADERS, jsonResponse } from "../_shared/types.ts";
import { callAgent } from "../_shared/agent-caller.ts";
import { buildDiscussionContext } from "../_shared/context-builder.ts";
import { getSupabase } from "../_shared/event-bus.ts";

const MAX_TOKENS_PER_AGENT = 500;
const MAX_TOTAL_TOKENS = 5000;
const DISCUSSION_TIMEOUT_MS = 120_000; // 2 minutes

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const startTime = Date.now();

  try {
    const { room_id, topic, deliverable, agents } = await req.json();
    const discussionId = crypto.randomUUID();
    const agentNames: string[] = agents || [];

    const supabase = getSupabase();

    // Step 1: Post the discussion header message
    await supabase.from("war_room_messages").insert({
      room_id,
      sender_name: "System",
      sender_type: "system",
      content: `🔄 Team Discussion: ${topic}`,
      metadata: {
        discussion_topic: topic,
        discussion_id: discussionId,
        discussion_deliverable: deliverable,
        discussion_agent_count: agentNames.length,
      },
    });

    // Step 2: Look up agent records
    const { data: agentRecords } = await supabase
      .from("agents")
      .select("name, role, session_key, api_endpoint, api_model, system_prompt")
      .in("name", agentNames);

    const agentMap = new Map<string, AgentRecord>();
    for (const rec of agentRecords || []) {
      agentMap.set(rec.name, rec as AgentRecord);
    }

    // Filter to agents that have endpoints configured
    const validAgents = agentNames.filter((name) => {
      const rec = agentMap.get(name);
      return rec && rec.api_endpoint;
    });

    // Step 3: Get recent context
    const recentContext = await buildDiscussionContext(room_id, 10);

    // Step 4: Round-robin — each agent gets one turn
    const contributions: { agent: string; text: string }[] = [];
    let totalTokens = 0;

    for (const agentName of validAgents) {
      // Check timeout
      if (Date.now() - startTime > DISCUSSION_TIMEOUT_MS) {
        await supabase.from("war_room_messages").insert({
          room_id,
          sender_name: "System",
          sender_type: "system",
          content: "⏱️ Discussion time limit reached. Moving to summary.",
          metadata: { discussion: true, discussion_id: discussionId },
        });
        break;
      }

      // Check token budget
      if (totalTokens >= MAX_TOTAL_TOKENS) {
        await supabase.from("war_room_messages").insert({
          room_id,
          sender_name: "System",
          sender_type: "system",
          content: "📊 Token budget reached. Moving to summary.",
          metadata: { discussion: true, discussion_id: discussionId },
        });
        break;
      }

      const rec = agentMap.get(agentName)!;

      const previousContributions =
        contributions.length > 0
          ? "\n\nOther agents have already said:\n" +
            contributions.map((c) => `[${c.agent}]: ${c.text}`).join("\n")
          : "";

      const systemPrompt = `You are ${agentName}, a ${rec.role} in the OLYMPUS team. You are in a focused team discussion.

TOPIC: ${topic}
DELIVERABLE: ${deliverable}

Recent conversation context:
${recentContext}
${previousContributions}

Share your perspective concisely. Stay on topic. Don't repeat what others said. Focus on your area of expertise. Max 3-4 sentences.`;

      try {
        const response = await callAgent(
          rec,
          systemPrompt,
          `Discuss: ${topic}`,
          MAX_TOKENS_PER_AGENT,
          30000
        );
        totalTokens += response.tokensUsed;
        contributions.push({ agent: agentName, text: response.text });

        await supabase.from("war_room_messages").insert({
          room_id,
          sender_name: agentName,
          sender_type: "agent",
          content: response.text,
          content_type: "text",
          metadata: {
            discussion: true,
            discussion_id: discussionId,
            tokens_used: response.tokensUsed,
          },
        });
      } catch (err) {
        console.error(`Discussion: ${agentName} failed:`, err);
      }
    }

    // Step 5: Claude summarizes
    if (contributions.length > 0) {
      const summaryPrompt = `You are Claude, the team moderator. Summarize this team discussion and provide the deliverable.

TOPIC: ${topic}
DELIVERABLE REQUESTED: ${deliverable}

CONTRIBUTIONS:
${contributions.map((c) => `[${c.agent}]: ${c.text}`).join("\n\n")}

Write a concise summary (2-3 paragraphs max) that:
1. Captures the key points from each contributor
2. Identifies areas of agreement and disagreement
3. Provides the requested deliverable: ${deliverable}

Address the human directly. Start with: "Here's what we discussed:"`;

      try {
        const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
        if (apiKey) {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-5-20250929",
              max_tokens: 1024,
              system:
                "You are Claude, a thoughtful team moderator who synthesizes discussions into actionable summaries.",
              messages: [{ role: "user", content: summaryPrompt }],
            }),
          });

          if (res.ok) {
            const data = await res.json();
            const summaryText = data.content[0].text;

            await supabase.from("war_room_messages").insert({
              room_id,
              sender_name: "Claude",
              sender_type: "agent",
              content: summaryText,
              content_type: "text",
              metadata: {
                discussion_summary: true,
                discussion_id: discussionId,
                model_used: "claude-sonnet-4-5-20250929",
                tokens_used:
                  (data.usage?.input_tokens || 0) +
                  (data.usage?.output_tokens || 0),
              },
            });
          }
        }
      } catch (err) {
        console.error("Summary generation failed:", err);
      }
    }

    return jsonResponse({
      status: "ok",
      discussion_id: discussionId,
      agents_participated: contributions.length,
      total_tokens: totalTokens,
    });
  } catch (err) {
    console.error("autonomous-discuss error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});
