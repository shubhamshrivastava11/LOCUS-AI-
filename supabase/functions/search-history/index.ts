// supabase/functions/search-history/index.ts
//
// Backs frontend/src/pages/SettingsPage.tsx's Search settings (list/toggle/
// clear/download) and frontend/src/components/DashboardSearch.tsx (record,
// called after each real POST /search on the FastAPI backend succeeds).
//
// Auth: same pattern as delete-account/export-account-data — a raw
// Supabase-issued access token, verified via supabase.auth.getUser(token),
// not the separate Locus-issued backend token used by the FastAPI routes.
//
// Actions (POST body: { action, ...}):
//   list      -> { items, total, saveHistory }
//   toggle    -> { enabled: boolean } -> { saveHistory }
//   clear     -> {} -> { cleared: true }
//   download  -> {} -> { items, total, exportedAt }  (full history, no limit)
//   record    -> { query: string, result_count: number } -> { recorded: boolean }
//                no-ops (recorded: false) if the user has saveHistory off

import { getServiceClient } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const LIST_LIMIT = 50;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authorization = req.headers.get("Authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return jsonResponse({ error: "Authentication required" }, 401);
  }

  const supabase = getServiceClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return jsonResponse({ error: "Invalid or expired session" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = String(body.action ?? "");

  const getSaveHistory = async (): Promise<boolean> => {
    const { data } = await supabase
      .from("user_search_preferences")
      .select("save_history")
      .eq("user_id", user.id)
      .maybeSingle();
    // No row yet means the default (save) applies — matches the frontend's
    // own default of saveHistory = true before it's ever been toggled.
    return data?.save_history ?? true;
  };

  if (action === "list" || action === "download") {
    const query = supabase
      .from("search_history")
      .select("id, query, result_count, searched_at", { count: "exact" })
      .eq("user_id", user.id)
      .order("searched_at", { ascending: false });

    if (action === "list") query.limit(LIST_LIMIT);

    const { data, error, count } = await query;
    if (error) {
      console.error("Failed to load search_history:", error);
      return jsonResponse({ error: "Unable to load search history" }, 500);
    }

    if (action === "download") {
      return jsonResponse(
        { items: data ?? [], total: count ?? 0, exportedAt: new Date().toISOString() },
        200,
      );
    }

    const saveHistory = await getSaveHistory();
    return jsonResponse({ items: data ?? [], total: count ?? 0, saveHistory }, 200);
  }

  if (action === "toggle") {
    const enabled = Boolean(body.enabled);
    const { error } = await supabase.from("user_search_preferences").upsert(
      { user_id: user.id, save_history: enabled, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) {
      console.error("Failed to update user_search_preferences:", error);
      return jsonResponse({ error: "Unable to update preference" }, 500);
    }
    return jsonResponse({ saveHistory: enabled }, 200);
  }

  if (action === "clear") {
    const { error } = await supabase.from("search_history").delete().eq("user_id", user.id);
    if (error) {
      console.error("Failed to clear search_history:", error);
      return jsonResponse({ error: "Unable to clear search history" }, 500);
    }
    return jsonResponse({ cleared: true }, 200);
  }

  if (action === "record") {
    const query = String(body.query ?? "").trim();
    if (!query) {
      return jsonResponse({ error: "query is required" }, 400);
    }
    const resultCount = Number.isFinite(body.result_count) ? Number(body.result_count) : 0;

    const saveHistory = await getSaveHistory();
    if (!saveHistory) {
      return jsonResponse({ recorded: false }, 200);
    }

    const { data: membership, error: membershipError } = await supabase
      .from("memberships")
      .select("tenant_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (membershipError || !membership) {
      console.error("Unable to resolve tenant for search history record:", membershipError);
      // Don't fail the caller's search flow over a bookkeeping write.
      return jsonResponse({ recorded: false }, 200);
    }

    const { error: insertError } = await supabase.from("search_history").insert({
      tenant_id: membership.tenant_id,
      user_id: user.id,
      query,
      result_count: resultCount,
    });

    if (insertError) {
      console.error("Failed to record search history:", insertError);
      return jsonResponse({ recorded: false }, 200);
    }

    return jsonResponse({ recorded: true }, 200);
  }

  return jsonResponse({ error: `Unknown action: ${action}` }, 400);
});
