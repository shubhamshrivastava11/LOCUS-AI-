-- =====================================================================
-- Migration 016: Search History
-- Backs the search-history Supabase Edge Function, called from
-- frontend/src/pages/SettingsPage.tsx (list/toggle/clear/download) and
-- frontend/src/components/DashboardSearch.tsx (record, after each real
-- POST /search call). The function referenced by that frontend code
-- never existed; this is the storage it needs.
--
-- Personal, not workspace-shared data — scoped by user_id (RLS via
-- auth.uid()), the same pattern already used for memberships/tenants in
-- 007_rls_tenant_isolation.sql, not the app.current_tenant_id GUC pattern
-- used elsewhere (that pattern is for the non-bypass locus_app role
-- talking to the FastAPI backend; this table is only ever touched by the
-- search-history Edge Function via a real end-user Supabase JWT).
-- =====================================================================

CREATE TABLE IF NOT EXISTS search_history (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    query        TEXT NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    searched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_history_user_time
    ON search_history (user_id, searched_at DESC);

ALTER TABLE search_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS search_history_own_rows ON search_history;
CREATE POLICY search_history_own_rows ON search_history
    FOR ALL
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- One row per user: whether to keep saving new search history at all.
-- Absence of a row means "save" (the frontend's own default), so the
-- Edge Function treats a missing row as save_history = true rather than
-- requiring a row to exist up front.
CREATE TABLE IF NOT EXISTS user_search_preferences (
    user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    save_history BOOLEAN NOT NULL DEFAULT true,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_search_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_search_preferences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_search_preferences_own_row ON user_search_preferences;
CREATE POLICY user_search_preferences_own_row ON user_search_preferences
    FOR ALL
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
