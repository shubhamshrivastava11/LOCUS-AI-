-- =====================================================================
-- Migration 015: Capture Source Rules
-- Backs the real (not mock) Channels & Source Rules table in
-- frontend/src/pages/SettingsPage.tsx's Capture Controls tab, via the
-- capture-source-rules Supabase Edge Function (list/toggle).
--
-- Workspace-wide (tenant-scoped, not per-user), same rationale as
-- source_connections itself: a Slack channel or Notion page's inclusion
-- state is a shared team setting, not a personal preference. RLS uses the
-- same auth.uid()-via-memberships pattern as source_connections'
-- "_authenticated" policies (007_rls_tenant_isolation.sql), since this is
-- read/written by the Edge Function via a real end-user Supabase JWT, not
-- the FastAPI backend's app.current_tenant_id GUC pattern.
-- =====================================================================

CREATE TABLE IF NOT EXISTS capture_source_rules (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source       TEXT NOT NULL CHECK (source IN ('slack', 'gmail', 'notion')),
    item_id      TEXT NOT NULL,
    item_name    TEXT NOT NULL,
    included     BOOLEAN NOT NULL DEFAULT true,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source, item_id)
);

CREATE INDEX IF NOT EXISTS idx_capture_source_rules_tenant
    ON capture_source_rules (tenant_id);

ALTER TABLE capture_source_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_source_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS capture_source_rules_own_tenant ON capture_source_rules;
CREATE POLICY capture_source_rules_own_tenant ON capture_source_rules
    FOR ALL
    TO authenticated
    USING (
        tenant_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = auth.uid())
    )
    WITH CHECK (
        tenant_id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = auth.uid())
    );
