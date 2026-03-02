/**
 * Context Builder — builds conversation context for agent LLM calls.
 *
 * Fetches recent War Room messages, participant info, and (in future phases)
 * relevant agent memory for inclusion in the agent's system prompt context.
 */

import { getSupabase } from "./event-bus.ts";

/**
 * Build conversation context for an agent from a War Room.
 */
export async function buildContext(
  roomId: string,
  messageCount = 20
): Promise<string> {
  const supabase = getSupabase();

  const { data: messages } = await supabase
    .from("war_room_messages")
    .select("sender_name, sender_type, content, created_at")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(messageCount);

  if (!messages || messages.length === 0) return "No previous messages.";

  const { data: participants } = await supabase
    .from("war_room_participants")
    .select("participant_name, participant_type, participant_config")
    .eq("room_id", roomId);

  const participantList = (participants || [])
    .map((p) => {
      const role =
        p.participant_type === "agent"
          ? ((p.participant_config as Record<string, unknown>)?.expertise as string[])?.join(", ") || "AI Agent"
          : ((p.participant_config as Record<string, unknown>)?.role as string) || "Team Member";
      return `- ${p.participant_name} (${p.participant_type}, ${role})`;
    })
    .join("\n");

  const messageHistory = messages
    .reverse()
    .map((m) => {
      const time = new Date(m.created_at).toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `[${m.sender_name} ${time}] ${m.content}`;
    })
    .join("\n");

  return `PARTICIPANTS IN THIS WAR ROOM:
${participantList}

RECENT CONVERSATION:
${messageHistory}

IMPORTANT RULES:
- Read the ENTIRE conversation above carefully, including other agents' responses.
- If another agent already answered, reference their points: agree, disagree, or build on them.
- Do NOT repeat what others already said. Add your unique perspective.
- If you agree with a previous agent, say so briefly and add what they missed.
- If you disagree, explain why with specific reasoning.
- Be concise. No filler.
- Match the language of the conversation (German or English).

TEAM KNOWLEDGE — Security principles the team must always enforce:
• No Authentication = critical vulnerability. Every API endpoint must verify identity before exposing data. "We'll secure it later" is never acceptable.
• No Rate Limiting = brute force attacks, scraping, surprise cloud bills. Every public endpoint needs rate limits.
• Open CORS ("*") = any website can steal user data silently. Whitelist specific origins only, never wildcard in production.
If you see any of these in code or architecture discussions, flag it immediately.`;
}

/**
 * Build lightweight context for autonomous discussions (shorter, no rules).
 */
export async function buildDiscussionContext(
  roomId: string,
  messageCount = 10
): Promise<string> {
  const supabase = getSupabase();

  const { data: recentMsgs } = await supabase
    .from("war_room_messages")
    .select("sender_name, content")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(messageCount);

  return (recentMsgs || [])
    .reverse()
    .map((m) => `[${m.sender_name}] ${m.content}`)
    .join("\n");
}
