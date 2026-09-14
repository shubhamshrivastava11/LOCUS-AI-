import { getServiceClient } from "../_shared/supabase.ts";
import { withAdmin } from "../_shared/db.ts";
import { PERSONAL_SOURCES } from "../_shared/tenantAuth.ts";

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
    // Was .select("*").in("tenant_id", tenantIds) with no source filter at
    // all, so exporting your own account data handed you every teammate's
    // Gmail-derived record in every workspace you belong to. The API's own
    // listDecisions has excluded those since the Gmail privacy work; the
    // export route never got the same treatment, which made it the easiest
    // way to read exactly what that work was meant to protect.
    //
    // Same NOT EXISTS predicate as api/index.ts:679, and the same carve-out:
    // a row whose connection predates connected_by cannot be attributed to
    // anyone, so it stays visible rather than being hidden from its own
    // owner.
    //
    // Raw SQL rather than the query builder because this is a correlated
    // subquery over two other tables, which PostgREST cannot express.
    let data: Record<string, unknown>[];
    try {
      data = await withAdmin(async (sql) => {
        return await sql`
          SELECT d.*
          FROM public.decisions d
          WHERE d.tenant_id = ANY(${tenantIds}::uuid[])
            AND NOT EXISTS (
              SELECT 1
              FROM public.raw_events pre
              JOIN public.source_connections psc
                ON psc.id = pre.connection_id AND psc.tenant_id = pre.tenant_id
              WHERE pre.id = d.origin_raw_event_id
                AND pre.tenant_id = d.tenant_id
                AND psc.source = ANY(${[...PERSONAL_SOURCES]}::text[])
                AND psc.connected_by IS NOT NULL
                AND psc.connected_by <> ${user.id}::uuid
            )
          ORDER BY d.created_at DESC
        ` as unknown as Record<string, unknown>[];
      });
    } catch (recordsError) {
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
