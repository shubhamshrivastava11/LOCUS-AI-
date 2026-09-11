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
    return jsonResponse({ error: "Unable to prepare account deletion" }, 500);
  }

  const privateTenantIds: string[] = [];
  for (const membership of memberships ?? []) {
    if (membership.role !== "owner") continue;

    const { count, error: countError } = await supabase
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", membership.tenant_id);

    if (countError) {
      console.error("Unable to count tenant members:", countError);
      return jsonResponse({ error: "Unable to prepare account deletion" }, 500);
    }

    if ((count ?? 0) > 1) {
      return jsonResponse(
        {
          error:
            "Transfer workspace ownership before deleting this account.",
        },
        409,
      );
    }

    privateTenantIds.push(String(membership.tenant_id));
  }

  const { error: deleteUserError } = await supabase.auth.admin.deleteUser(
    user.id,
    false,
  );

  if (deleteUserError) {
    console.error("Unable to delete auth user:", deleteUserError);
    return jsonResponse({ error: "Unable to delete account" }, 500);
  }

  if (privateTenantIds.length > 0) {
    const { error: tenantError } = await supabase
      .from("tenants")
      .delete()
      .in("id", privateTenantIds);

    if (tenantError) {
      console.error("Auth user deleted but tenant cleanup failed:", tenantError);
      return jsonResponse(
        {
          error:
            "Account deleted, but some workspace data requires administrator cleanup.",
        },
        500,
      );
    }
  }

  return jsonResponse({ deleted: true }, 200);
});
