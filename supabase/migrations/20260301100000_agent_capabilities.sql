-- Phase 0.2: Add agent capabilities and type columns
-- Enables capability-based routing for the ARGOS orchestrator

-- Add capabilities column (JSONB array of skill strings)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '[]';

-- Add agent_type column for role classification
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'agent_type'
  ) THEN
    ALTER TABLE agents ADD COLUMN agent_type TEXT DEFAULT 'general';
    ALTER TABLE agents ADD CONSTRAINT agents_agent_type_check
      CHECK (agent_type IN (
        'orchestrator', 'code', 'review', 'testing', 'infra', 'security',
        'docs', 'design', 'product', 'content', 'human', 'general'
      ));
  END IF;
END $$;

-- Seed capabilities for existing agents
UPDATE agents SET
  agent_type = 'orchestrator',
  capabilities = '["task_decomposition", "routing", "scheduling", "monitoring", "escalation"]'::jsonb
WHERE name = 'ARGOS';

UPDATE agents SET
  agent_type = 'code',
  capabilities = '["frontend", "react", "typescript", "css", "ui_components", "responsive_design"]'::jsonb
WHERE name = 'ATLAS';

UPDATE agents SET
  agent_type = 'review',
  capabilities = '["code_review", "testing", "qa", "strategy", "requirements_validation"]'::jsonb
WHERE name = 'ATHENA';

UPDATE agents SET
  agent_type = 'code',
  capabilities = '["backend", "api", "database", "supabase", "edge_functions", "node"]'::jsonb
WHERE name = 'HERCULOS';

UPDATE agents SET
  agent_type = 'infra',
  capabilities = '["devops", "ci_cd", "deployment", "monitoring", "security", "infrastructure"]'::jsonb
WHERE name = 'PROMETHEUS';

UPDATE agents SET
  agent_type = 'design',
  capabilities = '["ui_design", "visual_design", "figma", "design_tokens", "branding"]'::jsonb
WHERE name = 'APOLLO';

UPDATE agents SET
  agent_type = 'docs',
  capabilities = '["documentation", "adr", "api_docs", "memory", "knowledge_management"]'::jsonb
WHERE name = 'HERMES';

UPDATE agents SET
  agent_type = 'general',
  capabilities = '["architecture", "strategy", "code_review", "system_design", "problem_solving"]'::jsonb
WHERE name = 'Claude';

UPDATE agents SET
  agent_type = 'human',
  capabilities = '["system_architecture", "product_management", "decision_making"]'::jsonb
WHERE name = 'Juan';

UPDATE agents SET
  agent_type = 'human',
  capabilities = '["frontend", "react", "testing", "ux"]'::jsonb
WHERE name = 'Nathanael';
