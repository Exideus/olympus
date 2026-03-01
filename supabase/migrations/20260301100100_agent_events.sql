-- Phase 1.1: Agent Event Bus Schema
-- Supabase-native event-driven message bus for structured agent-to-agent communication.
-- The War Room remains the human-facing chat layer; events are the agent coordination layer.

-- ============================================================
-- Event Bus Core Table
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,                       -- e.g. 'task.created', 'code.committed', 'review.requested'
  channel TEXT NOT NULL DEFAULT 'broadcast',       -- e.g. 'orchestrator', 'code', 'review', 'testing', 'security', 'docs', 'broadcast'
  source_agent TEXT NOT NULL,                      -- agent that published the event
  target_agent TEXT,                               -- specific target agent (null = broadcast to channel subscribers)
  payload JSONB NOT NULL DEFAULT '{}',             -- event-specific data
  correlation_id UUID DEFAULT gen_random_uuid(),   -- links related events in a chain
  parent_event_id UUID REFERENCES agent_events(id),-- event that triggered this one
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  result JSONB,                                    -- processing result (populated on completion)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ                           -- optional TTL for auto-cleanup
);

-- Indexes for efficient event routing
CREATE INDEX IF NOT EXISTS idx_agent_events_channel_status
  ON agent_events (channel, status);
CREATE INDEX IF NOT EXISTS idx_agent_events_target_status
  ON agent_events (target_agent, status) WHERE target_agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_events_correlation
  ON agent_events (correlation_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_created
  ON agent_events (created_at DESC);

-- ============================================================
-- Agent Subscriptions (which agents listen to which channels)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  event_types TEXT[] NOT NULL DEFAULT ARRAY['*'],  -- array of event types, '*' = all
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_name, channel)
);

-- ============================================================
-- Seed Default Subscriptions
-- ============================================================

-- ARGOS subscribes to everything (orchestrator)
INSERT INTO agent_subscriptions (agent_name, channel, event_types)
VALUES
  ('ARGOS', 'broadcast', ARRAY['*']),
  ('ARGOS', 'orchestrator', ARRAY['*']),
  ('ARGOS', 'code', ARRAY['task.completed', 'task.blocked', 'code.committed']),
  ('ARGOS', 'review', ARRAY['review.completed', 'review.escalated']),
  ('ARGOS', 'testing', ARRAY['test.passed', 'test.failed']),
  ('ARGOS', 'security', ARRAY['security.review_completed', 'security.finding'])
ON CONFLICT (agent_name, channel) DO NOTHING;

-- Code agents subscribe to code + orchestrator channels
INSERT INTO agent_subscriptions (agent_name, channel, event_types)
VALUES
  ('ATLAS', 'code', ARRAY['*']),
  ('ATLAS', 'orchestrator', ARRAY['task.assigned', 'task.decomposed']),
  ('ATLAS', 'review', ARRAY['review.request_changes']),
  ('HERCULOS', 'code', ARRAY['*']),
  ('HERCULOS', 'orchestrator', ARRAY['task.assigned', 'task.decomposed']),
  ('HERCULOS', 'review', ARRAY['review.request_changes'])
ON CONFLICT (agent_name, channel) DO NOTHING;

-- Review agent subscribes to review channel
INSERT INTO agent_subscriptions (agent_name, channel, event_types)
VALUES
  ('ATHENA', 'review', ARRAY['*']),
  ('ATHENA', 'code', ARRAY['code.committed', 'pr.created']),
  ('ATHENA', 'testing', ARRAY['*'])
ON CONFLICT (agent_name, channel) DO NOTHING;

-- Infrastructure/Security
INSERT INTO agent_subscriptions (agent_name, channel, event_types)
VALUES
  ('PROMETHEUS', 'infra', ARRAY['*']),
  ('PROMETHEUS', 'security', ARRAY['*']),
  ('PROMETHEUS', 'code', ARRAY['pr.created'])
ON CONFLICT (agent_name, channel) DO NOTHING;

-- Documentation
INSERT INTO agent_subscriptions (agent_name, channel, event_types)
VALUES
  ('HERMES', 'docs', ARRAY['*']),
  ('HERMES', 'code', ARRAY['task.completed', 'pr.merged']),
  ('HERMES', 'orchestrator', ARRAY['task.completed'])
ON CONFLICT (agent_name, channel) DO NOTHING;

-- Design
INSERT INTO agent_subscriptions (agent_name, channel, event_types)
VALUES
  ('APOLLO', 'design', ARRAY['*']),
  ('APOLLO', 'orchestrator', ARRAY['task.assigned'])
ON CONFLICT (agent_name, channel) DO NOTHING;

-- Claude subscribes broadly (architecture)
INSERT INTO agent_subscriptions (agent_name, channel, event_types)
VALUES
  ('Claude', 'broadcast', ARRAY['*']),
  ('Claude', 'review', ARRAY['review.escalated', 'review.disagreement']),
  ('Claude', 'orchestrator', ARRAY['escalation.created'])
ON CONFLICT (agent_name, channel) DO NOTHING;

-- ============================================================
-- RLS Policies
-- ============================================================

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_read_agent_events" ON agent_events
  FOR SELECT USING (true);

CREATE POLICY "allow_insert_agent_events" ON agent_events
  FOR INSERT WITH CHECK (true);

CREATE POLICY "allow_update_agent_events" ON agent_events
  FOR UPDATE USING (true);

CREATE POLICY "allow_read_agent_subscriptions" ON agent_subscriptions
  FOR SELECT USING (true);

CREATE POLICY "allow_insert_agent_subscriptions" ON agent_subscriptions
  FOR INSERT WITH CHECK (true);

CREATE POLICY "allow_update_agent_subscriptions" ON agent_subscriptions
  FOR UPDATE USING (true);

-- ============================================================
-- Enable Realtime for event bus
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE agent_events;

-- ============================================================
-- Auto-cleanup expired events (optional, run via pg_cron)
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_expired_events()
RETURNS void AS $$
BEGIN
  DELETE FROM agent_events
  WHERE expires_at IS NOT NULL
    AND expires_at < now()
    AND status IN ('completed', 'failed');
END;
$$ LANGUAGE plpgsql;
