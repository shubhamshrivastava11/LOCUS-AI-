// supabase/functions/team-invites/index.ts
//
// Lets a tenant owner/admin bring a second person into their EXISTING
// tenant, instead of every signup always getting its own brand-new solo
// one (see public.handle_new_user() - deliberately left untouched by this
// feature; invited members never go through the early-access allowlist
// gate there, since being invited by an already-approved owner is itself
// the authorization).
//
// Action-based dispatch (POST body: { action, ... }), same convention as
// capture-source-rules - this function bundles several operations, so it
// matches that shape rather than delete-account's single-purpose one.
// Works cleanly with supabase.functions.invoke() from the frontend, which
// is fundamentally a POST-with-JSON-body call (no clean way to do a real
// GET+querystring through it).
//
// Auth: raw Supabase-issued access token, verified via
// supabase.auth.getUser(token) - same pattern as capture-source-rules/
// delete-account, NOT the custom locus-ai tenant JWT api/index.ts's
// getCurrentTenant expects (this is an account-settings action, not a
// product-data read).
//
// Every public.invites read/write goes through this service-role client -
// the table has no authenticated-role RLS policies at all (see its
// migration), same convention as memberships/tenants.
//
// Deploy note: MUST be deployed with --no-verify-jwt. "lookup" has to be
// reachable with no real user session yet (the invitee hasn't signed in
// when they open the link) - it still goes through functions.invoke using
// just the anon key, and does its own no-op-if-absent auth check below.

import { getServiceClient } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

function randomToken(): string {
  // 32 bytes, hex-encoded - same shape as a typical opaque bearer token,
  // unguessable, no encoding ambiguity in a URL query param.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendInviteEmail(
  toEmail: string, tenantName: string, inviterName: string, inviteUrl: string,
): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set - skipping invite email, link-only.");
    return false;
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Locus AI <onboarding@resend.dev>",
        to: [toEmail],
        subject: `${inviterName} invited you to ${tenantName} on Locus AI`,
        html: `<p>${inviterName} invited you to join <strong>${tenantName}</strong>'s workspace on Locus AI.</p>` +
          `<p><a href="${inviteUrl}">Accept the invite</a></p>` +
          `<p>Or copy this link: ${inviteUrl}</p>`,
      }),
    });
    if (!resp.ok) {
      console.error("Resend send failed:", resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Resend send threw:", err);
    return false;
  }
}

// deno-lint-ignore no-explicit-any
type ServiceClient = any;

type AuthError = { error: string; status: number };
// deno-lint-ignore no-explicit-any
type AuthedUser = { user: any };

async function getAuthedUser(supabase: ServiceClient, req: Request): Promise<AuthError | AuthedUser> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return { error: "Authentication required", status: 401 };
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { error: "Invalid or expired session", status: 401 };
  return { user };
}

// Loads the caller's own membership + role for their (oldest, same
// ── The role ladder ──────────────────────────────────────────────────────
//
// Mirrors memberships.role_level, which is a generated column over the same
// names. Duplicated here rather than read back per request because it is used
// for comparisons on every management action and the mapping is fixed by a
// CHECK constraint on the same table.
const ROLE_LEVELS: Record<string, number> = {
  owner: 5,
  admin: 4,
  lead: 3,
  member: 2,
  guest: 1,
};

/** Roles that can be handed out by invitation. Owner is transferred, not invited. */
const INVITABLE_ROLES = ["admin", "lead", "member", "guest"];

function levelOf(role: string | null | undefined): number {
  return ROLE_LEVELS[String(role ?? "")] ?? 0;
}

/** Default Guest window when an inviter does not name one. */
const GUEST_DEFAULT_DAYS = 30;

/**
 * Who may hand out, or take away, a given role.
 *
 * Two rules, and the second is the one worth stating: you cannot grant a role
 * at or above your own. Without it an Admin could promote a colleague to Owner
 * and inherit the billing surface through them, which makes the level below
 * Owner equivalent to Owner.
 *
 * The first rule is the Owner carve-out: only an Owner may create or remove
 * another Owner. An Admin manages the workspace; it does not get to decide who
 * owns it.
 */
function canAssign(callerRole: string, targetRole: string): boolean {
  const caller = levelOf(callerRole);
  const target = levelOf(targetRole);
  if (target >= ROLE_LEVELS.owner) return caller >= ROLE_LEVELS.owner;
  return caller > target;
}

// resolution /auth/session uses) tenant, doubling as the owner/admin gate.
async function requireOwnerOrAdmin(
  supabase: ServiceClient, userId: string,
): Promise<AuthError | { tenantId: string; role: string }> {
  const { data: memberships, error } = await supabase
    .from("memberships").select("tenant_id, role, created_at").eq("user_id", userId);
  if (error) {
    console.error("Unable to load memberships:", error);
    return { error: "Unable to load your workspace", status: 500 };
  }
  const primary = (memberships ?? []).sort((a: { created_at?: string }, b: { created_at?: string }) =>
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0];
  if (!primary) return { error: "No workspace found for this account", status: 404 };
  // Leads invite into the scopes they own, so they reach this gate too. What
  // they may hand out is then narrowed by canAssign, which stops a Lead
  // creating an Admin.
  if (!["owner", "admin", "lead"].includes(String(primary.role))) {
    return { error: "Only workspace owners, admins and leads can manage invites", status: 403 };
  }
  return { tenantId: primary.tenant_id as string, role: String(primary.role) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabase = getServiceClient();
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  try {
    // ── create_workspace - authenticated, no existing membership ────────
    // Real gap this closes: handle_new_user() used to unconditionally
    // auto-create a solo tenant the instant an allowlisted email signed
    // in, before the frontend could ever ask "individual or team?". That
    // trigger is gone (see 20260904020000's migration) - this endpoint
    // now owns on-demand tenant creation, called only when someone
    // explicitly chooses "start a new workspace" on ChooseWorkspaceScreen.
    // Re-checks eligibility server-side rather than trusting the
    // frontend's own early_access_allowlist read, same principle as every
    // other action here.
    if (action === "create_workspace") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);

      const { data: allowlisted } = await supabase
        .from("early_access_allowlist").select("email").ilike("email", authed.user.email ?? "").maybeSingle();
      if (!allowlisted) return jsonResponse({ error: "This account isn't on the early access list yet" }, 403);

      const { data: existing } = await supabase.from("memberships").select("id").eq("user_id", authed.user.id).limit(1);
      if (existing && existing.length > 0) {
        return jsonResponse({ error: "This account already belongs to a workspace" }, 409);
      }

      // Same slug-generation logic handle_new_user() used to run.
      const fullName = String(authed.user.user_metadata?.full_name ?? "").trim();
      const email = authed.user.email ?? "";
      const baseSlugSource = fullName || email.split("@")[0] || "workspace";
      const baseSlug = baseSlugSource.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const newTenantId = crypto.randomUUID();
      const finalSlug = `${baseSlug}-${newTenantId.replace(/-/g, "").slice(0, 8)}`;

      // "individual" (self_serve) genuinely cannot invite anyone - see the
      // create action's own plan check below - vs. "team", which can from
      // the start. Both create a real, separate tenant; nothing upgrades
      // one into the other later in this plan.
      const plan = body.plan === "team" ? "team" : "self_serve";

      const { error: tenantError } = await supabase.from("tenants").insert({
        id: newTenantId, name: fullName || email || "My Workspace", slug: finalSlug, plan,
      });
      if (tenantError) {
        console.error("Unable to create workspace:", tenantError);
        return jsonResponse({ error: "Unable to create workspace" }, 500);
      }
      const { error: membershipError } = await supabase.from("memberships").insert({
        tenant_id: newTenantId, user_id: authed.user.id, role: "owner",
      });
      if (membershipError) {
        console.error("Unable to create owner membership:", membershipError);
        return jsonResponse({ error: "Workspace created, but membership setup failed" }, 500);
      }
      return jsonResponse({ tenant_id: newTenantId }, 200);
    }

    // ── lookup - public, no auth required ──────────────────────────────
    if (action === "lookup") {
      const token = String(body.token ?? "");
      if (!token) return jsonResponse({ valid: false, reason: "Missing token" }, 200);

      const { data: invite } = await supabase
        .from("invites").select("status, role, expires_at, tenant_id").eq("token", token).maybeSingle();
      if (!invite) return jsonResponse({ valid: false, reason: "Invite not found" }, 200);
      if (invite.status === "accepted") return jsonResponse({ valid: false, reason: "Already accepted" }, 200);
      if (invite.status === "revoked") return jsonResponse({ valid: false, reason: "Invite was revoked" }, 200);
      if (new Date(invite.expires_at) < new Date()) return jsonResponse({ valid: false, reason: "Invite expired" }, 200);

      const { data: tenant } = await supabase.from("tenants").select("name").eq("id", invite.tenant_id).maybeSingle();
      return jsonResponse({ valid: true, tenant_name: tenant?.name ?? "a workspace", role: invite.role }, 200);
    }

    // ── create - owner/admin only ───────────────────────────────────────
    if (action === "create") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);
      const caller = await requireOwnerOrAdmin(supabase, authed.user.id);
      if ("error" in caller) return jsonResponse({ error: caller.error }, caller.status);

      const email = String(body.email ?? "").trim().toLowerCase();
      const requestedRole = String(body.role ?? "member");
      const role = INVITABLE_ROLES.includes(requestedRole) ? requestedRole : "member";
      if (!email || !email.includes("@")) return jsonResponse({ error: "A valid email is required" }, 422);
      if (!canAssign(caller.role, role)) {
        return jsonResponse({ error: `You can't invite someone as ${role}` }, 403);
      }

      // Guests are time-limited by definition - that is what separates a Guest
      // from a Member with a narrow scope list. An inviter who names no window
      // gets the default rather than a membership that never ends, because a
      // contractor whose access quietly outlives the contract is the exact
      // failure the role exists to prevent.
      let membershipExpiresAt: string | null = null;
      if (role === "guest") {
        const requested = body.expires_at ? new Date(String(body.expires_at)) : null;
        const valid = requested && !Number.isNaN(requested.getTime()) && requested.getTime() > Date.now();
        membershipExpiresAt = (valid
          ? requested
          : new Date(Date.now() + GUEST_DEFAULT_DAYS * 86_400_000)).toISOString();
      }

      const { data: tenant } = await supabase.from("tenants").select("name, plan").eq("id", caller.tenantId).maybeSingle();
      // Real, enforced distinction (not just onboarding copy): an
      // individual (self_serve) workspace genuinely cannot invite anyone,
      // ever - matches ChooseWorkspaceScreen's own "Individual account"
      // description. Only a team-plan workspace can.
      if (tenant?.plan !== "team") {
        return jsonResponse({ error: "Individual accounts can't invite teammates. Create a team account instead to invite others." }, 403);
      }
      const { data: inviterAuth } = await supabase.auth.admin.getUserById(authed.user.id);
      const inviterName = inviterAuth?.user?.user_metadata?.full_name ?? inviterAuth?.user?.email ?? "Someone";

      const inviteToken = randomToken();
      const { error: insertError } = await supabase.from("invites").insert({
        tenant_id: caller.tenantId, email, role, invited_by: authed.user.id, token: inviteToken,
        membership_expires_at: membershipExpiresAt,
      });
      if (insertError) {
        // Partial unique index (tenant_id, lower(email)) where pending -
        // a duplicate live invite to the same address lands here.
        if (insertError.code === "23505") {
          return jsonResponse({ error: "There's already a pending invite for this email" }, 409);
        }
        console.error("Unable to create invite:", insertError);
        return jsonResponse({ error: "Unable to create invite" }, 500);
      }

      const inviteUrl = `${FRONTEND_URL}/join?token=${inviteToken}`;
      const emailSent = await sendInviteEmail(email, tenant?.name ?? "a workspace", inviterName, inviteUrl);
      return jsonResponse({ invite_url: inviteUrl, email_sent: emailSent }, 200);
    }

    // ── accept - requires the invitee's real, now-authenticated session ─
    if (action === "accept") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);

      const inviteToken = String(body.token ?? "");
      if (!inviteToken) return jsonResponse({ error: "Missing invite token" }, 422);

      const { data: invite } = await supabase.from("invites").select("*").eq("token", inviteToken).maybeSingle();
      if (!invite) return jsonResponse({ error: "Invite not found" }, 404);
      if (invite.status !== "pending") return jsonResponse({ error: "This invite is no longer valid" }, 409);
      if (new Date(invite.expires_at) < new Date()) return jsonResponse({ error: "This invite has expired" }, 409);
      if (String(invite.email).toLowerCase() !== String(authed.user.email ?? "").toLowerCase()) {
        return jsonResponse({ error: "This invite was sent to a different email address" }, 403);
      }

      // The oldest-membership-wins landmine (see plan): accepting a second
      // tenant while already belonging to one would silently never show up
      // for this user, since /auth/session always resolves their oldest
      // membership. Reject cleanly instead of creating that broken state.
      const { data: existing } = await supabase.from("memberships").select("id").eq("user_id", authed.user.id).limit(1);
      if (existing && existing.length > 0) {
        return jsonResponse({
          error: "This Google account already has a Locus AI workspace. Accept this invite with a different account, or ask us about workspace switching.",
        }, 409);
      }

      const { error: membershipError } = await supabase.from("memberships").insert({
        tenant_id: invite.tenant_id, user_id: authed.user.id, role: invite.role,
        // Only ever set for a Guest - a CHECK on memberships enforces that,
        // so sending it for any other role would be rejected outright.
        expires_at: invite.role === "guest" ? invite.membership_expires_at : null,
      });
      if (membershipError) {
        console.error("Unable to create membership:", membershipError);
        return jsonResponse({ error: "Unable to join this workspace" }, 500);
      }
      await supabase.from("invites").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", invite.id);

      return jsonResponse({ joined: true, tenant_id: invite.tenant_id }, 200);
    }

    // ── list - any current tenant member ────────────────────────────────
    if (action === "list") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);

      const { data: memberships } = await supabase.from("memberships").select("tenant_id").eq("user_id", authed.user.id).limit(1);
      const tenantId = memberships?.[0]?.tenant_id;
      if (!tenantId) return jsonResponse({ error: "No workspace found for this account" }, 404);

      const { data: invites, error } = await supabase
        .from("invites").select("id, email, role, invited_by, created_at")
        .eq("tenant_id", tenantId).eq("status", "pending").order("created_at", { ascending: false });
      if (error) {
        console.error("Unable to list invites:", error);
        return jsonResponse({ error: "Unable to load pending invites" }, 500);
      }
      return jsonResponse({ invites: invites ?? [] }, 200);
    }

    // ── revoke - owner/admin only ───────────────────────────────────────
    if (action === "revoke") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);
      const caller = await requireOwnerOrAdmin(supabase, authed.user.id);
      if ("error" in caller) return jsonResponse({ error: caller.error }, caller.status);

      const inviteId = String(body.invite_id ?? "");
      if (!inviteId) return jsonResponse({ error: "Missing invite_id" }, 422);

      const { error } = await supabase.from("invites").update({ status: "revoked" })
        .eq("id", inviteId).eq("tenant_id", caller.tenantId);
      if (error) {
        console.error("Unable to revoke invite:", error);
        return jsonResponse({ error: "Unable to revoke invite" }, 500);
      }
      return jsonResponse({ revoked: true }, 200);
    }

    // ── rename_workspace - owner/admin only ─────────────────────────────
    // Real gap this closes: handle_new_user() names every new tenant after
    // the founder's own personal name/email ("Abbas Rahman", not a company
    // name) - fine for a solo signup, not once other people join it.
    if (action === "rename_workspace") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);
      const caller = await requireOwnerOrAdmin(supabase, authed.user.id);
      if ("error" in caller) return jsonResponse({ error: caller.error }, caller.status);

      const name = String(body.name ?? "").trim();
      if (!name) return jsonResponse({ error: "A workspace name is required" }, 422);
      if (name.length > 80) return jsonResponse({ error: "Keep it under 80 characters" }, 422);

      const { error } = await supabase.from("tenants").update({ name }).eq("id", caller.tenantId);
      if (error) {
        console.error("Unable to rename workspace:", error);
        return jsonResponse({ error: "Unable to rename workspace" }, 500);
      }
      return jsonResponse({ name }, 200);
    }

    // ── members - any current tenant member ─────────────────────────────
    if (action === "members") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);

      const { data: memberships } = await supabase.from("memberships").select("tenant_id").eq("user_id", authed.user.id).limit(1);
      const tenantId = memberships?.[0]?.tenant_id;
      if (!tenantId) return jsonResponse({ error: "No workspace found for this account" }, 404);

      const [{ data: rows, error }, { data: tenant }] = await Promise.all([
        supabase.from("memberships")
          .select("id, user_id, role, role_level, can_manage_connectors, can_view_audit, expires_at, created_at")
          .eq("tenant_id", tenantId).order("created_at", { ascending: true }),
        supabase.from("tenants").select("name, plan").eq("id", tenantId).maybeSingle(),
      ]);
      if (error) {
        console.error("Unable to load members:", error);
        return jsonResponse({ error: "Unable to load team members" }, 500);
      }

      const members = await Promise.all((rows ?? []).map(async (m: {
        id: string; user_id: string; role: string; role_level: number;
        can_manage_connectors: boolean; can_view_audit: boolean;
        expires_at: string | null; created_at: string;
      }) => {
        const { data: authUser } = await supabase.auth.admin.getUserById(m.user_id);
        return {
          membership_id: m.id,
          user_id: m.user_id,
          email: authUser?.user?.email ?? null,
          display_name: authUser?.user?.user_metadata?.full_name ?? null,
          role: m.role,
          role_level: m.role_level,
          can_manage_connectors: m.can_manage_connectors === true,
          can_view_audit: m.can_view_audit === true,
          expires_at: m.expires_at,
          // A Guest past their window still has a row; it is the access rule
          // that drops them to Public-only. Surfaced so the list says
          // "expired" rather than showing them as an ordinary member.
          expired: m.expires_at ? new Date(m.expires_at).getTime() <= Date.now() : false,
          joined_at: m.created_at,
          is_self: m.user_id === authed.user.id,
        };
      }));
      return jsonResponse({ members, workspace_name: tenant?.name ?? null, workspace_plan: tenant?.plan ?? null }, 200);
    }

    // ── remove_member - owner/admin only, can't remove yourself this way ─
    if (action === "remove_member") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);
      const caller = await requireOwnerOrAdmin(supabase, authed.user.id);
      if ("error" in caller) return jsonResponse({ error: caller.error }, caller.status);

      const membershipId = String(body.membership_id ?? "");
      if (!membershipId) return jsonResponse({ error: "Missing membership_id" }, 422);

      const { data: target } = await supabase.from("memberships").select("user_id, role").eq("id", membershipId).eq("tenant_id", caller.tenantId).maybeSingle();
      if (!target) return jsonResponse({ error: "Member not found" }, 404);
      if (target.user_id === authed.user.id) return jsonResponse({ error: "Use account settings to remove yourself" }, 400);
      // The ladder, not a blanket ban on removing Owners. An Owner may remove
      // a co-Owner; an Admin may not, and may not remove another Admin either,
      // because a peer removing a peer means whoever clicks first wins.
      if (!canAssign(caller.role, String(target.role))) {
        return jsonResponse({
          error: target.role === "owner"
            ? "Only an owner can remove another owner"
            : `You can't remove a ${target.role}`,
        }, 403);
      }
      if (target.role === "owner") {
        const { count } = await supabase
          .from("memberships").select("id", { count: "exact", head: true })
          .eq("tenant_id", caller.tenantId).eq("role", "owner");
        if ((count ?? 0) <= 1) {
          return jsonResponse({ error: "Transfer ownership before removing the last owner" }, 409);
        }
      }

      const { error } = await supabase.from("memberships").delete().eq("id", membershipId).eq("tenant_id", caller.tenantId);
      if (error) {
        console.error("Unable to remove member:", error);
        return jsonResponse({ error: "Unable to remove member" }, 500);
      }
      return jsonResponse({ removed: true }, 200);
    }

    // ── set_role - change a member's level, or a capability flag ────────
    //
    // Without this the hierarchy would be write-once at invite time, which
    // makes it useless: people change jobs, contractors finish, and the
    // interesting case is the person who has been a Member for a year and
    // should now be the Lead of their own channel.
    //
    // Everything here goes through canAssign in both directions - you must
    // out-rank what someone currently is AND what you are making them. That
    // second half is what stops an Admin promoting a colleague to Owner and
    // reaching billing through them.
    if (action === "set_role") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);
      const caller = await requireOwnerOrAdmin(supabase, authed.user.id);
      if ("error" in caller) return jsonResponse({ error: caller.error }, caller.status);

      const membershipId = String(body.membership_id ?? "");
      if (!membershipId) return jsonResponse({ error: "Missing membership_id" }, 422);

      const { data: target } = await supabase
        .from("memberships").select("user_id, role")
        .eq("id", membershipId).eq("tenant_id", caller.tenantId).maybeSingle();
      if (!target) return jsonResponse({ error: "Member not found" }, 404);

      // Changing your own role is how someone promotes themselves. An Owner
      // hands ownership over deliberately through transfer, not by editing
      // their own row.
      if (target.user_id === authed.user.id) {
        return jsonResponse({ error: "You can't change your own role" }, 400);
      }
      if (!canAssign(caller.role, String(target.role))) {
        return jsonResponse({ error: `You can't manage a ${target.role}` }, 403);
      }

      const update: Record<string, unknown> = {};

      if (body.role !== undefined) {
        const nextRole = String(body.role);
        if (!(nextRole in ROLE_LEVELS)) return jsonResponse({ error: "Unknown role" }, 422);
        if (!canAssign(caller.role, nextRole)) {
          return jsonResponse({ error: `You can't make someone ${nextRole}` }, 403);
        }
        update.role = nextRole;
        // The CHECK on memberships allows expires_at only for a Guest, so
        // promoting out of Guest has to clear it in the same statement or the
        // update is rejected. Demoting TO Guest without a window would leave a
        // guest who never expires, which the role is specifically meant to
        // prevent, so it gets the default.
        if (nextRole !== "guest") {
          update.expires_at = null;
        } else if (body.expires_at === undefined) {
          update.expires_at = new Date(Date.now() + GUEST_DEFAULT_DAYS * 86_400_000).toISOString();
        }
      }

      // Capability flags are independent of level by design - that is the
      // whole point of having them rather than promoting someone. Only an
      // Owner or Admin hands them out; a Lead manages people, not policy.
      for (const flag of ["can_manage_connectors", "can_view_audit"]) {
        if (body[flag] === undefined) continue;
        if (levelOf(caller.role) < ROLE_LEVELS.admin) {
          return jsonResponse({ error: "Only owners and admins can change capabilities" }, 403);
        }
        update[flag] = body[flag] === true;
      }

      if (body.expires_at !== undefined) {
        const role = String(update.role ?? target.role);
        if (role !== "guest") {
          return jsonResponse({ error: "Only guests have an expiry date" }, 422);
        }
        const when = new Date(String(body.expires_at));
        if (Number.isNaN(when.getTime())) return jsonResponse({ error: "Invalid expiry date" }, 422);
        update.expires_at = when.toISOString();
      }

      if (Object.keys(update).length === 0) return jsonResponse({ error: "Nothing to change" }, 422);

      // Never leave a workspace with no owner. Checked before the write rather
      // than repaired after it, because there is no repair.
      if (update.role !== undefined && target.role === "owner" && update.role !== "owner") {
        const { count } = await supabase
          .from("memberships").select("id", { count: "exact", head: true })
          .eq("tenant_id", caller.tenantId).eq("role", "owner");
        if ((count ?? 0) <= 1) {
          return jsonResponse({ error: "A workspace must always have an owner" }, 409);
        }
      }

      const { error } = await supabase
        .from("memberships").update(update).eq("id", membershipId).eq("tenant_id", caller.tenantId);
      if (error) {
        console.error("Unable to update member role:", error);
        return jsonResponse({ error: "Unable to update this member" }, 500);
      }
      return jsonResponse({ updated: true }, 200);
    }

    // ── leave_team - any member leaves their own workspace ──────────────
    // The gap remove_member's own "use account settings to remove
    // yourself" message pointed at but never actually built. A sole owner
    // can't leave without orphaning the workspace (no admin/member left to
    // ever manage it) - block and point at ownership transfer or account
    // deletion instead, same "can't orphan an owner" reasoning
    // remove_member already applies to removing someone else.
    if (action === "leave_team") {
      const authed = await getAuthedUser(supabase, req);
      if ("error" in authed) return jsonResponse({ error: authed.error }, authed.status);

      const { data: membership } = await supabase
        .from("memberships").select("id, tenant_id, role").eq("user_id", authed.user.id).limit(1).maybeSingle();
      if (!membership) return jsonResponse({ error: "No workspace found for this account" }, 404);

      if (membership.role === "owner") {
        return jsonResponse({
          error: "Transfer ownership before leaving, or delete your account instead if this is your only workspace.",
        }, 409);
      }

      // Revoke (not delete) - stops ongoing sync from an account no longer
      // part of this workspace, but keeps what was already captured as the
      // team's shared history, same "keep the history" default disconnect
      // already offers rather than silently purging shared data on the
      // way out.
      const { error: revokeError } = await supabase
        .from("source_connections").update({ status: "revoked" })
        .eq("tenant_id", membership.tenant_id).eq("connected_by", authed.user.id);
      if (revokeError) {
        console.error("Unable to revoke connections on leave:", revokeError);
        // Not fatal - still let them leave; a stray active connection is
        // recoverable by an owner/admin later, an inability to leave at
        // all is worse.
      }

      const { error } = await supabase.from("memberships").delete().eq("id", membership.id);
      if (error) {
        console.error("Unable to leave workspace:", error);
        return jsonResponse({ error: "Unable to leave workspace" }, 500);
      }
      return jsonResponse({ left: true }, 200);
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("team-invites failure:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
