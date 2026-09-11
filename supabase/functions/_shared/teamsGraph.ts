// supabase/functions/_shared/teamsGraph.ts
//
// Microsoft Graph plumbing for the Teams connector.
//
// This is the THIRD Teams approach in this project, and the first one that
// survived contact with Microsoft's rules, so it is worth recording why it
// looks like this:
//
//   Attempt 1 (outlook_calendar, 31 Aug)  - abandoned.
//   Attempt 2 (Bot Framework + RSC)       - dead on arrival. Microsoft
//     retired multi-tenant bot creation on 31 July 2025, so a new bot only
//     serves its own tenant, and reaching customers would have required an
//     AppSource listing and publisher verification.
//   Attempt 3 (this)                      - no bot at all. A multi-tenant
//     Entra app with the ChannelMessage.Read.All APPLICATION permission
//     subscribes to /teams/getAllMessages and Graph pushes every channel
//     message to us.
//
// Two facts were verified against live Graph before writing this, not
// assumed from documentation:
//
//   1. No protected-API registration is enforced. A token carrying
//      roles: ['ChannelMessage.Read.All'] reached the resource check and
//      failed only with "Microsoft Teams hasn't been provisioned on the
//      tenant" - no approval form, no gate.
//   2. No billing. Teams APIs stopped being metered on 25 August 2025;
//      the model=A/B parameter is ignored and no Azure subscription is
//      needed. The doc describing the old meters is itself deprecated.
//
// What this route DOES still require, and cannot be engineered away:
// tenant admin consent, because application permissions have no
// user-consent path.

const CLIENT_ID = Deno.env.get("TEAMS_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("TEAMS_CLIENT_SECRET") ?? "";

const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * Channel messages only, never chats.
 *
 * /teams/getAllMessages covers messages in team channels. Chats and
 * meeting chats are a different resource (/chats/getAllMessages) behind a
 * different permission (Chat.Read.All), and Locus deliberately does not
 * subscribe to them - the Privacy page commits to never reading direct or
 * group messages, and the cheapest way to keep that promise is to never
 * hold the permission in the first place.
 */
export const CHANNEL_MESSAGES_RESOURCE = "/teams/getAllMessages";

/**
 * Graph caps this resource at one hour, and rejects anything longer unless
 * a lifecycleNotificationUrl is supplied. Renewal is therefore not
 * optional: without it a connection silently stops ingesting after an
 * hour, which looks perfectly healthy right up until it isn't.
 */
export const SUBSCRIPTION_MINUTES = 55;

export interface GraphSubscription {
  id: string;
  expirationDateTime: string;
  resource: string;
}

/**
 * App-only token for one customer's Microsoft tenant.
 *
 * Minted per tenant rather than against /common: client credentials have
 * no user, so the tenant has to be named in the authority.
 */
export async function getAppToken(microsoftTenantId: string): Promise<string> {
  const resp = await fetch(
    `https://login.microsoftonline.com/${microsoftTenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Teams token failed for tenant ${microsoftTenantId}: ${data.error_description ?? data.error ?? resp.status}`,
    );
  }
  return data.access_token as string;
}

export async function graphFetch(
  microsoftTenantId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAppToken(microsoftTenantId);
  const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
  return await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function expiryIso(minutes = SUBSCRIPTION_MINUTES): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace("Z", "0000Z");
}

/**
 * Subscribe to every channel message in a tenant.
 *
 * includeResourceData is deliberately false. Setting it true would deliver
 * the message body inline, but requires managing an encryption
 * certificate, RSA-unwrapping a data key and AES-decrypting the payload.
 * Instead the notification carries only a resource path and we fetch the
 * message with the same app token. That costs one extra Graph call per
 * captured message and removes an entire class of key-management failure.
 * Revisit only if that call ever becomes the bottleneck.
 */
export async function createChannelSubscription(
  microsoftTenantId: string,
  notificationUrl: string,
  lifecycleNotificationUrl: string,
  clientState: string,
): Promise<GraphSubscription> {
  const resp = await graphFetch(microsoftTenantId, "/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      lifecycleNotificationUrl,
      resource: CHANNEL_MESSAGES_RESOURCE,
      includeResourceData: false,
      expirationDateTime: expiryIso(),
      clientState,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Teams subscription create failed: ${resp.status} ${JSON.stringify(data?.error ?? data)}`,
    );
  }
  return data as GraphSubscription;
}

export async function renewSubscription(
  microsoftTenantId: string,
  subscriptionId: string,
): Promise<GraphSubscription> {
  const resp = await graphFetch(microsoftTenantId, `/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    body: JSON.stringify({ expirationDateTime: expiryIso() }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Teams subscription renew failed: ${resp.status} ${JSON.stringify(data?.error ?? data)}`,
    );
  }
  return data as GraphSubscription;
}

export async function deleteSubscription(
  microsoftTenantId: string,
  subscriptionId: string,
): Promise<void> {
  await graphFetch(microsoftTenantId, `/subscriptions/${subscriptionId}`, { method: "DELETE" });
}

export interface TeamsMessage {
  id?: string;
  body?: { content?: string; contentType?: string };
  from?: { user?: { id?: string; displayName?: string } };
  createdDateTime?: string;
  replyToId?: string | null;
  webUrl?: string;
  messageType?: string;
  channelIdentity?: { teamId?: string; channelId?: string };
}

/** Fetch one message by the resource path Graph put in the notification. */
export async function fetchMessage(
  microsoftTenantId: string,
  resourcePath: string,
): Promise<TeamsMessage | null> {
  const resp = await graphFetch(microsoftTenantId, `/${resourcePath.replace(/^\/+/, "")}`);
  if (!resp.ok) {
    console.error(`Teams message fetch failed: ${resp.status} for ${resourcePath}`);
    return null;
  }
  return await resp.json() as TeamsMessage;
}

/** Human-readable team and channel names, for Build Memory's list. */
export async function fetchChannelName(
  microsoftTenantId: string,
  teamId: string,
  channelId: string,
): Promise<{ team: string | null; channel: string | null }> {
  try {
    const [teamResp, chanResp] = await Promise.all([
      graphFetch(microsoftTenantId, `/teams/${teamId}`),
      graphFetch(microsoftTenantId, `/teams/${teamId}/channels/${channelId}`),
    ]);
    const team = teamResp.ok ? (await teamResp.json()).displayName ?? null : null;
    const channel = chanResp.ok ? (await chanResp.json()).displayName ?? null : null;
    return { team, channel };
  } catch (err) {
    // Names are cosmetic. Never fail ingestion over them.
    console.error("Teams: name lookup failed (non-fatal):", err);
    return { team: null, channel: null };
  }
}
