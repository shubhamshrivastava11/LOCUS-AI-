import { getServiceClient } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-region",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id);

  if (membershipError) {
    console.error("Unable to load memberships:", membershipError);
    return jsonResponse({ error: "Unable to export account data" }, 500);
  }

  const tenantIds = (memberships ?? []).map((membership) =>
    String(membership.tenant_id)
  );

  let records: Record<string, unknown>[] = [];
  if (tenantIds.length > 0) {
    const { data, error: recordsError } = await supabase
      .from("decisions")
      .select("*")
      .in("tenant_id", tenantIds)
      .order("created_at", { ascending: false });

    if (recordsError) {
      console.error("Unable to load captured records:", recordsError);
      return jsonResponse({ error: "Unable to export account data" }, 500);
    }

    records = data ?? [];
  }

  return jsonResponse(
    {
      account: {
        id: user.id,
        email: user.email ?? null,
        name:
          user.user_metadata?.full_name ??
          user.user_metadata?.name ??
          user.user_metadata?.display_name ??
          null,
      },
      memberships: memberships ?? [],
      decisions: records.filter((record) => record.record_type === "decision"),
      actionItems: records.filter(
        (record) => record.record_type === "action_item",
      ),
      blockers: records.filter((record) => record.record_type === "blocker"),
      exportedAt: new Date().toISOString(),
    },
    200,
  );
});
