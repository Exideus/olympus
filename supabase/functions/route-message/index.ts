/**
 * Route Message — Main War Room message handler.
 *
 * Handles:
 * - Human messages with @mentions → direct agent response (with tool use)
 * - Human messages without mentions → hand-raise mode (agents decide if they should speak)
 * - Voice messages → transcribe then route
 * - Full response requests from frontend (hand-raise click)
 *
 * Uses shared modules from _shared/ for LLM calling, context building, and voice.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import type { AgentRecord, HandRaiseResult } from "../_shared/types.ts";
import { CORS_HEADERS, jsonResponse } from "../_shared/types.ts";
import { callAgentLightweight, callAgentWithTools } from "../_shared/agent-caller.ts";
import { buildContext } from "../_shared/context-builder.ts";
import { getSupabase, transcribeVoice, generateVoice } from "../_shared/event-bus.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const {
      message_id,
      room_id,
      content,
      content_type,
      audio_url,
      action,
      target_agents,
    } = body;

    // ---- ACTION: full_response (frontend requests specific agent responses) ----
    if (action === "full_response") {
      return await handleFullResponse(room_id, content, target_agents || []);
    }

    // ---- DEFAULT: triggered by DB webhook on human message ----
    const supabase = getSupabase();

    // Step 1: If voice message, transcribe first
    let messageText = content;
    if (content_type === "voice" && audio_url) {
      messageText = await transcribeVoice(audio_url);
      await supabase
        .from("war_room_messages")
        .update({ content: messageText, metadata: { original_type: "voice" } })
        .eq("id", message_id);
    }

    // Step 2: Get room participants
    const { data: participants } = await supabase
      .from("war_room_participants")
      .select("*")
      .eq("room_id", room_id)
      .eq("is_active", true);

    const agentParticipants =
      participants?.filter((p) => p.participant_type === "agent") || [];

    if (agentParticipants.length === 0) {
      return jsonResponse({ status: "no_agents" });
    }

    // Step 3: Check for mentions — direct response (skip hand-raise)
    const allParticipants = participants?.filter((p) => p.is_active) || [];

    // Check @mentions against ALL participants (agents + humans)
    const mentionedByAt = allParticipants
      .filter((a) =>
        messageText
          .toLowerCase()
          .includes(`@${a.participant_name.toLowerCase()}`)
      )
      .map((a) => ({ name: a.participant_name, type: a.participant_type }));

    // Name-based detection (without @) — only for AGENTS
    const mentionedByName = agentParticipants
      .filter((a) => {
        if (mentionedByAt.some((m) => m.name === a.participant_name))
          return false;
        const name = a.participant_name.toLowerCase();
        const text = messageText.toLowerCase();
        const nameRegex = new RegExp(`\\b${name}\\b`, "i");
        return nameRegex.test(text);
      })
      .map((a) => ({ name: a.participant_name, type: "agent" }));

    const allMentioned = [...mentionedByAt, ...mentionedByName];
    const mentionedAgents = allMentioned
      .filter((m) => m.type === "agent")
      .map((m) => m.name);

    if (mentionedAgents.length > 0) {
      return await handleFullResponse(room_id, messageText, mentionedAgents);
    }

    // If only humans were mentioned, no agent response needed
    if (allMentioned.length > 0 && mentionedAgents.length === 0) {
      return jsonResponse({
        status: "human_mention",
        mentioned: allMentioned.map((m) => m.name),
      });
    }

    // Step 3b: Voice messages — all agents respond directly
    if (content_type === "voice") {
      const allAgentNames = agentParticipants.map((a) => a.participant_name);
      return await handleFullResponse(room_id, messageText, allAgentNames);
    }

    // Step 4: Hand-raise mode — ask all agents if they want to speak
    await supabase
      .from("war_room_participants")
      .update({ hand_raised: false, hand_reason: null })
      .eq("room_id", room_id)
      .eq("participant_type", "agent");

    const agentNames = agentParticipants.map((a) => a.participant_name);
    const agentMap = await fetchAgentRecords(agentNames);

    const handRaiseResults = await Promise.all(
      agentNames.map(async (name) => {
        const rec = agentMap.get(name);
        if (!rec) return null;
        const result = await askHandRaise(rec, messageText, name);
        return { name, ...result };
      })
    );

    for (const result of handRaiseResults) {
      if (!result) continue;
      const participant = agentParticipants.find(
        (a) => a.participant_name === result.name
      );
      if (!participant) continue;

      await supabase
        .from("war_room_participants")
        .update({
          hand_raised: result.wants_to_speak,
          hand_reason: result.wants_to_speak ? result.reason : null,
        })
        .eq("id", participant.id);
    }

    const raisedHands = handRaiseResults
      .filter((r) => r?.wants_to_speak)
      .map((r) => r!.name);
    return jsonResponse({ status: "hands_raised", agents: raisedHands });
  } catch (err) {
    console.error("route-message error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }
});

// ============================================================
// Full Response Handler (used for hand-raise click + @mentions)
// ============================================================

async function handleFullResponse(
  roomId: string,
  messageText: string,
  targetAgents: string[]
): Promise<Response> {
  if (targetAgents.length === 0) {
    return jsonResponse({ status: "no_targets" });
  }

  const supabase = getSupabase();

  // If no content, fetch latest human message
  let effectiveMessage = messageText;
  if (!effectiveMessage) {
    const { data: latestMsg } = await supabase
      .from("war_room_messages")
      .select("content")
      .eq("room_id", roomId)
      .eq("sender_type", "human")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    effectiveMessage = latestMsg?.content || "Please respond.";
  }

  const { data: participants } = await supabase
    .from("war_room_participants")
    .select("*")
    .eq("room_id", roomId)
    .eq("is_active", true);

  const agentMap = await fetchAgentRecords(targetAgents);
  const responded: string[] = [];

  // Sequential execution: each agent sees previous agents' responses
  for (const agentName of targetAgents) {
    const participant = participants?.find(
      (a) => a.participant_name === agentName
    );
    const agentRecord = agentMap.get(agentName);

    if (!participant) continue;
    if (participant.participant_type === "human") continue;

    // Rebuild context each time so this agent sees previous agents' responses
    const context = await buildContext(roomId, 20);
    const startTime = Date.now();

    try {
      const response = await callAgentWithTools(
        agentRecord!,
        effectiveMessage,
        context,
        agentName,
        roomId
      );
      const responseTime = Date.now() - startTime;
      const modelUsed =
        agentRecord?.api_model || agentRecord?.model_primary || "unknown";

      // Only post text response to chat (code goes to execution queue via tools)
      if (response.text && response.text.trim().length > 0) {
        const { data: insertedMsg } = await supabase
          .from("war_room_messages")
          .insert({
            room_id: roomId,
            sender_name: agentName,
            sender_type: "agent",
            content: response.text,
            content_type: "text",
            metadata: {
              model_used: modelUsed,
              tokens_used: response.tokensUsed,
              response_time_ms: responseTime,
              tools_used: response.toolsUsed,
            },
          })
          .select()
          .single();

        // Voice TTS if agent has a voice_id configured
        if (agentRecord?.voice_id && insertedMsg) {
          try {
            await generateVoice(
              response.text,
              agentRecord.voice_id,
              insertedMsg.id
            );
          } catch (ttsErr) {
            console.error(`TTS failed for ${agentName}:`, ttsErr);
          }
        }
      }

      // Lower hand after responding
      await supabase
        .from("war_room_participants")
        .update({ hand_raised: false, hand_reason: null })
        .eq("id", participant.id);

      responded.push(agentName);
    } catch (err) {
      console.error(`Agent ${agentName} failed:`, err);
      await supabase.from("war_room_messages").insert({
        room_id: roomId,
        sender_name: "System",
        sender_type: "system",
        content: `⚠️ ${agentName} could not respond: ${(err as Error).message}`,
        metadata: { error: true },
      });
    }
  }

  return jsonResponse({ status: "ok", responded });
}

// ============================================================
// Hand Raise — Lightweight check per agent
// ============================================================

async function askHandRaise(
  agentRecord: AgentRecord,
  message: string,
  agentName: string
): Promise<HandRaiseResult> {
  if (!agentRecord?.api_endpoint) {
    return { wants_to_speak: false, reason: "" };
  }

  const systemPrompt = `You are ${agentName}, a ${agentRecord.role}. Based on the user's message, decide if you have relevant expertise to contribute. Respond ONLY with JSON: {"wants_to_speak": true or false, "reason": "max 5 words"}`;

  try {
    const text = await callAgentLightweight(
      agentRecord,
      systemPrompt,
      message,
      60
    );
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        wants_to_speak: !!parsed.wants_to_speak,
        reason: String(parsed.reason || "").substring(0, 50),
      };
    }
    return { wants_to_speak: false, reason: "" };
  } catch {
    return { wants_to_speak: false, reason: "" };
  }
}

// ============================================================
// Helpers
// ============================================================

async function fetchAgentRecords(
  agentNames: string[]
): Promise<Map<string, AgentRecord>> {
  const supabase = getSupabase();

  const { data: agentRecords } = await supabase
    .from("agents")
    .select(
      "name, role, session_key, api_endpoint, api_model, system_prompt, model_primary, model_escalation, voice_id"
    )
    .in("name", agentNames);

  const agentMap = new Map<string, AgentRecord>();
  for (const rec of agentRecords || []) {
    agentMap.set(rec.name, rec);
  }
  return agentMap;
}
