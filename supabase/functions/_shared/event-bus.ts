/**
 * Event Bus — Supabase-native event system for OLYMPUS agent communication.
 *
 * Uses the `agent_events` table with Supabase Realtime for pub/sub.
 * The War Room remains the human-facing chat layer; the event bus handles
 * structured agent-to-agent communication.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AgentEvent, EventChannel } from "./types.ts";

// ============================================================
// Supabase Client Singleton
// ============================================================

let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
  }
  return _supabase;
}

// ============================================================
// Publish Events
// ============================================================

/**
 * Publish a typed event to the agent event bus.
 */
export async function publishEvent(event: AgentEvent): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("agent_events")
    .insert({
      event_type: event.event_type,
      channel: event.channel,
      source_agent: event.source_agent,
      target_agent: event.target_agent || null,
      payload: event.payload,
      correlation_id: event.correlation_id || crypto.randomUUID(),
      parent_event_id: event.parent_event_id || null,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to publish event:", error);
    throw new Error(`Failed to publish event: ${error.message}`);
  }

  return data.id;
}

/**
 * Publish an event and cross-post a human-readable summary to the War Room.
 */
export async function publishEventWithWarRoomNotice(
  event: AgentEvent,
  roomId: string,
  warRoomMessage: string
): Promise<string> {
  const eventId = await publishEvent(event);

  await postToWarRoom(roomId, event.source_agent, warRoomMessage, {
    event_id: eventId,
    event_type: event.event_type,
  });

  return eventId;
}

// ============================================================
// Query Events
// ============================================================

/**
 * Get pending events for a specific agent or channel.
 */
export async function getPendingEvents(
  options: { targetAgent?: string; channel?: EventChannel; limit?: number }
): Promise<AgentEvent[]> {
  const supabase = getSupabase();

  let query = supabase
    .from("agent_events")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (options.targetAgent) {
    query = query.eq("target_agent", options.targetAgent);
  }
  if (options.channel) {
    query = query.eq("channel", options.channel);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Failed to fetch pending events:", error);
    return [];
  }
  return data || [];
}

/**
 * Get events by correlation ID (to trace related event chains).
 */
export async function getEventsByCorrelation(
  correlationId: string
): Promise<AgentEvent[]> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from("agent_events")
    .select("*")
    .eq("correlation_id", correlationId)
    .order("created_at", { ascending: true });

  return data || [];
}

// ============================================================
// Update Event Status
// ============================================================

/**
 * Mark an event as processing, completed, or failed.
 */
export async function updateEventStatus(
  eventId: string,
  status: "processing" | "completed" | "failed",
  result?: Record<string, unknown>
): Promise<void> {
  const supabase = getSupabase();

  const update: Record<string, unknown> = {
    status,
    processed_at: status !== "processing" ? new Date().toISOString() : undefined,
  };

  if (result) {
    update.result = result;
  }

  const { error } = await supabase
    .from("agent_events")
    .update(update)
    .eq("id", eventId);

  if (error) {
    console.error(`Failed to update event ${eventId}:`, error);
  }
}

// ============================================================
// Subscriptions
// ============================================================

/**
 * Check if an agent is subscribed to a given channel + event type.
 */
export async function isAgentSubscribed(
  agentName: string,
  channel: EventChannel,
  eventType: string
): Promise<boolean> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from("agent_subscriptions")
    .select("event_types")
    .eq("agent_name", agentName)
    .eq("channel", channel)
    .single();

  if (!data) return false;

  // Wildcard subscription or specific event match
  return data.event_types.includes("*") || data.event_types.includes(eventType);
}

/**
 * Get all agents subscribed to a channel + event type.
 */
export async function getSubscribers(
  channel: EventChannel,
  eventType: string
): Promise<string[]> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from("agent_subscriptions")
    .select("agent_name, event_types")
    .eq("channel", channel);

  if (!data) return [];

  return data
    .filter(
      (sub) =>
        sub.event_types.includes("*") || sub.event_types.includes(eventType)
    )
    .map((sub) => sub.agent_name);
}

// ============================================================
// War Room Helpers
// ============================================================

/**
 * Post a message to the War Room (human-facing chat).
 */
export async function postToWarRoom(
  roomId: string,
  senderName: string,
  content: string,
  metadata: Record<string, unknown> = {},
  senderType: "agent" | "system" = "system"
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from("war_room_messages").insert({
    room_id: roomId,
    sender_name: senderName,
    sender_type: senderType,
    content,
    content_type: "text",
    metadata,
  });

  if (error) {
    console.error("Failed to post to war room:", error);
  }
}

// ============================================================
// Voice Helpers
// ============================================================

/**
 * Transcribe voice audio via Whisper API.
 */
export async function transcribeVoice(audioUrl: string): Promise<string> {
  const audioRes = await fetch(audioUrl);
  const audioBlob = await audioRes.blob();

  const formData = new FormData();
  formData.append("file", audioBlob, "voice.webm");
  formData.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
    },
    body: formData,
  });

  if (!res.ok) throw new Error(`Whisper API error: ${res.status}`);
  const data = await res.json();
  return data.text;
}

/**
 * Generate voice audio via ElevenLabs TTS and attach to a War Room message.
 */
export async function generateVoice(
  text: string,
  voiceId: string,
  messageId: string
): Promise<void> {
  const supabase = getSupabase();

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": Deno.env.get("ELEVENLABS_API_KEY")!,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!res.ok) {
    console.error("ElevenLabs TTS failed:", res.status);
    return;
  }

  const audioBuffer = await res.arrayBuffer();
  const fileName = `war-room-voice/${messageId}.mp3`;

  const { error: uploadError } = await supabase.storage
    .from("war-room-audio")
    .upload(fileName, audioBuffer, { contentType: "audio/mpeg" });

  if (uploadError) {
    console.error("Audio upload failed:", uploadError);
    return;
  }

  const { data: urlData } = supabase.storage
    .from("war-room-audio")
    .getPublicUrl(fileName);

  await supabase
    .from("war_room_messages")
    .update({ audio_url: urlData.publicUrl })
    .eq("id", messageId);
}
