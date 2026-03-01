/**
 * Process Event — Event bus processor for OLYMPUS agent communication.
 *
 * This function is called when new events are inserted into `agent_events`.
 * It routes events to the appropriate subscribers, enforcing the constraint
 * that a source agent cannot process its own events.
 *
 * Can be triggered by:
 * 1. Supabase Database Webhook on agent_events INSERT
 * 2. Direct HTTP call from other edge functions
 * 3. Periodic polling (fallback)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { CORS_HEADERS, jsonResponse } from "../_shared/types.ts";
import type { AgentEvent, EventChannel } from "../_shared/types.ts";
import {
  getSupabase,
  getSubscribers,
  updateEventStatus,
  postToWarRoom,
} from "../_shared/event-bus.ts";

// Events that should be cross-posted to War Room for human visibility
const HUMAN_VISIBLE_EVENTS = new Set([
  "task.created",
  "task.completed",
  "task.blocked",
  "escalation.created",
  "pr.created",
  "pr.merged",
  "review.escalated",
  "test.failed",
  "security.finding",
  "merge.completed",
  "merge.blocked",
]);

// Human-readable event descriptions for War Room cross-posting
const EVENT_DESCRIPTIONS: Record<string, (payload: Record<string, unknown>) => string> = {
  "task.created": (p) =>
    `📋 New task created: **${p.title || "Untitled"}** (assigned to ${p.assignee || "unassigned"})`,
  "task.completed": (p) =>
    `✅ Task completed: **${p.title || "Untitled"}** by ${p.completed_by || "unknown"}`,
  "task.blocked": (p) =>
    `🚫 Task blocked: **${p.title || "Untitled"}** — ${p.reason || "no reason given"}`,
  "escalation.created": (p) =>
    `🚨 **Escalation**: ${p.escalation_type || "unknown"} — ${p.summary || "See details"}${p.recommended_resolution ? `\n💡 Recommended: ${p.recommended_resolution}` : ""}`,
  "pr.created": (p) =>
    `🔀 PR created: **${p.title || "Untitled"}** on branch \`${p.branch || "unknown"}\` by ${p.created_by || "unknown"}`,
  "pr.merged": (p) =>
    `🎉 PR merged: **${p.title || "Untitled"}** into \`${p.base_branch || "main"}\``,
  "review.escalated": (p) =>
    `⚖️ Review escalation: ${p.summary || "Review could not be resolved after multiple rounds"}`,
  "test.failed": (p) =>
    `❌ Tests failed on \`${p.branch || "unknown"}\`: ${p.failed_count || 0} failure(s), ${p.coverage_percent || "?"}% coverage`,
  "security.finding": (p) =>
    `🔒 Security finding (${p.severity || "unknown"}): ${p.title || "See details"}`,
  "merge.completed": (p) =>
    `✅ Merge completed: **${p.title || "Untitled"}** — all gates passed`,
  "merge.blocked": (p) =>
    `🛑 Merge blocked: **${p.title || "Untitled"}** — missing: ${(p.blocked_by as string[])?.join(", ") || "unknown gates"}`,
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();

    // Support both webhook format and direct call
    const event: AgentEvent = body.record || body;

    if (!event.event_type || !event.channel || !event.source_agent) {
      return jsonResponse({ error: "Missing required event fields" }, 400);
    }

    const eventId = event.id;
    if (!eventId) {
      return jsonResponse({ error: "Event must have an ID" }, 400);
    }

    // Mark event as processing
    await updateEventStatus(eventId, "processing");

    // Step 1: Get subscribers for this event's channel + type
    const subscribers = await getSubscribers(
      event.channel as EventChannel,
      event.event_type
    );

    // Also check for targeted events
    const targetedSubscribers = event.target_agent
      ? [event.target_agent]
      : [];

    // Merge subscribers, excluding the source agent (no self-processing)
    const allTargets = [
      ...new Set([...subscribers, ...targetedSubscribers]),
    ].filter((name) => name !== event.source_agent);

    // Step 2: Cross-post to War Room if human-visible
    if (HUMAN_VISIBLE_EVENTS.has(event.event_type)) {
      const descFn = EVENT_DESCRIPTIONS[event.event_type];
      const warRoomMessage = descFn
        ? descFn(event.payload)
        : `📡 Event: ${event.event_type} from ${event.source_agent}`;

      // Find an active war room to post to
      const roomId = (event.payload.room_id as string) || await getDefaultWarRoom();
      if (roomId) {
        await postToWarRoom(roomId, "System", warRoomMessage, {
          event_id: eventId,
          event_type: event.event_type,
          source_agent: event.source_agent,
          is_event_crosspost: true,
        });
      }
    }

    // Step 3: Mark event as completed with routing info
    await updateEventStatus(eventId, "completed", {
      routed_to: allTargets,
      subscribers_count: allTargets.length,
    });

    return jsonResponse({
      status: "processed",
      event_id: eventId,
      event_type: event.event_type,
      routed_to: allTargets,
    });
  } catch (err) {
    console.error("process-event error:", err);
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
// Helpers
// ============================================================

/**
 * Get the default War Room ID for system-level cross-posts.
 * Falls back to the most recently active room.
 */
async function getDefaultWarRoom(): Promise<string | null> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from("war_room_messages")
    .select("room_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data?.room_id || null;
}
