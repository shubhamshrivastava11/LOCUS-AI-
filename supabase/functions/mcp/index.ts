// supabase/functions/mcp/index.ts
//
// MCP (Model Context Protocol) — JSON-RPC 2.0 endpoint.
//
// Ported from the Python FastAPI implementation in
// backend/src/modules/mcp/ (server.py, tools/search.py, tools/context.py).
//
// Auth: EXACTLY the same tenant-scoped JWT used by the Python backend and
// the UI path.  Tokens are HS256-signed by the backend auth service using
// APP_SECRET_KEY.  MCP clients must supply:
//   Authorization: Bearer <tenant_jwt>
//
// There is NO separate auth mechanism for MCP — it is not exempted from
// tenant scoping under any circumstance.
//
// Supported tools:
//   - search_decisions       { query: string, limit?: number }
//   - get_decision_context   { decision_id: string (UUID) }
//
// Wire protocol: https://modelcontextprotocol.io/docs/concepts/transports

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getServiceClient } from "../_shared/supabase.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

interface TenantContext {
  userId: string;
  tenantId: string;
  role: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

// ── JWT verification (custom HS256 tenant token) ───────────────────────────────
//
// The backend issues a custom HS256 token (not a native Supabase JWT) with
// claims: { iss, sub, tenant_id, role, iat, exp }
// signed with APP_SECRET_KEY.  We verify it using the Web Crypto API
// (available natively in Deno/Edge Functions — no external library needed).

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  // Pad to multiple of 4, convert URL-safe chars
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const base64 = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function verifyTenantJwt(
  token: string,
  secret: string,
): Promise<TenantContext> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Verify header algorithm
  const header = JSON.parse(
    new TextDecoder().decode(base64urlDecode(headerB64)),
  );
  if (header.alg !== "HS256") {
    throw new Error(`Unexpected JWT algorithm: ${header.alg}`);
  }

  // Verify signature
  const key = await importHmacKey(secret);
  const sigBytes = base64urlDecode(sigB64);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(signingInput),
  );
  if (!valid) throw new Error("Invalid JWT signature");

  // Decode and validate claims
  const payload = JSON.parse(
    new TextDecoder().decode(base64urlDecode(payloadB64)),
  );

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSec) throw new Error("JWT expired");
  if (payload.iss !== "locus-ai") {
    throw new Error(`Unexpected JWT issuer: ${payload.iss}`);
  }
  if (!payload.sub) throw new Error("JWT missing sub claim");
  if (!payload.tenant_id) throw new Error("JWT missing tenant_id claim");

  return {
    userId: payload.sub,
    tenantId: payload.tenant_id,
    role: payload.role ?? "member",
  };
}

// ── JSON-RPC helpers ───────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonrpcOk(id: string | number | null, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function jsonrpcError(
  id: string | number | null,
  code: number,
  message: string,
): Response {
  // JSON-RPC protocol errors always use HTTP 200
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolError(
  id: string | number | null,
  text: string,
): Response {
  // Tool-level errors are returned as successful JSON-RPC results with isError:true
  return jsonrpcOk(id, {
    content: [{ type: "text", text }],
    isError: true,
  });
}

// ── Tool schemas (mirrors Python _TOOL_SCHEMAS) ───────────────────────────────

const TOOL_SCHEMAS = [
  {
    name: "search_decisions",
    description:
      "Search for decisions in the authenticated tenant's workspace using a free-text query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        limit: {
          type: "integer",
          description: "Max results (1-50)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_decision_context",
    description:
      "Fetch a single decision and its source links for use in AI context.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string", format: "uuid" },
      },
      required: ["decision_id"],
    },
  },
];

// ── Tool implementations ───────────────────────────────────────────────────────

async function toolSearchDecisions(
  args: Record<string, unknown>,
  ctx: TenantContext,
  supabase: SupabaseClient,
): Promise<Record<string, unknown>> {
  const query = String(args.query ?? "").trim();
  if (!query) return { decisions: [], total: 0, error: "query is required" };

  let limit = Number(args.limit ?? 10);
  limit = Math.max(1, Math.min(limit, 50)); // clamp 1–50

  // Full-text search — mirrors hybrid.py SQL exactly.
  // Layer-1 tenant isolation: service-role client + explicit tenant_id WHERE.
  // Layer-2: we verify tenant_id on every returned row below.
  const { data, error } = await supabase.rpc("search_decisions_fts", {
    p_query: query,
    p_tenant_id: ctx.tenantId,
    p_limit: limit,
  });

  // Fallback: if RPC not available, use direct table query
  if (error && error.code === "42883") {
    // Function does not exist — use direct ilike search as first-pass fallback
    const { data: rows, error: qErr } = await supabase
      .from("decisions")
      .select(
        "id, tenant_id, record_type, decision_statement, rationale, status, scope, confidence, created_at, updated_at",
      )
      .eq("tenant_id", ctx.tenantId)
      .or(
        `decision_statement.ilike.%${query}%,rationale.ilike.%${query}%`,
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    if (qErr) {
      console.error("search_decisions fallback error:", qErr);
      throw new Error("Search failed");
    }

    const decisions = (rows ?? []).filter((r: { tenant_id: string }) => r.tenant_id === ctx.tenantId); // Layer-2
    return { decisions, total: decisions.length, tenant_id: ctx.tenantId };
  }

  if (error) {
    console.error("search_decisions RPC error:", error);
    throw new Error("Search failed");
  }

  const decisions = (data ?? []).filter((r: { tenant_id: string }) => r.tenant_id === ctx.tenantId); // Layer-2
  return { decisions, total: decisions.length, tenant_id: ctx.tenantId };
}

async function toolGetDecisionContext(
  args: Record<string, unknown>,
  ctx: TenantContext,
  supabase: SupabaseClient,
): Promise<Record<string, unknown>> {
  const decisionId = String(args.decision_id ?? "").trim();

  // Basic UUID format check
  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(decisionId)) {
    return { error: "decision_id must be a valid UUID" };
  }

  // Fetch decision — explicit tenant_id in WHERE (Layer-2 belt-and-suspenders)
  const { data: decision, error: dErr } = await supabase
    .from("decisions")
    .select(
      "id, tenant_id, record_type, decision_statement, rationale, status, scope, confidence, created_at, updated_at",
    )
    .eq("id", decisionId)
    .eq("tenant_id", ctx.tenantId) // Layer-2: explicit tenant filter
    .single();

  if (dErr || !decision) {
    // Do NOT reveal whether the decision exists — return "not found" for both
    // missing and cross-tenant cases.
    return { error: "not found" };
  }

  // Layer-2 assertion: verify the returned row actually belongs to this tenant
  if (decision.tenant_id !== ctx.tenantId) {
    console.warn(
      `Tenant scope violation: requested tenant=${ctx.tenantId} row tenant=${decision.tenant_id}`,
    );
    return { error: "not found" };
  }

  // Fetch sources for this decision
  const { data: sources, error: sErr } = await supabase
    .from("decision_sources")
    .select("permalink, created_at")
    .eq("decision_id", decisionId)
    .eq("tenant_id", ctx.tenantId) // Layer-2 on sources too
    .order("created_at", { ascending: true });

  if (sErr) {
    console.error("get_decision_context sources error:", sErr);
    // Return decision without sources rather than failing entirely
  }

  return {
    decision: {
      id: decision.id,
      tenant_id: decision.tenant_id,
      record_type: decision.record_type,
      decision_statement: decision.decision_statement,
      rationale: decision.rationale,
      status: decision.status,
      scope: decision.scope,
      confidence: decision.confidence,
      created_at: decision.created_at,
      updated_at: decision.updated_at,
    },
    sources: (sources ?? []).map((s: { permalink: string; created_at: string }) => ({
      permalink: s.permalink,
      cited_at: s.created_at,
    })),
  };
}

// ── Audit logging ──────────────────────────────────────────────────────────────
//
// mcp_tool_calls exists in the schema but nothing was ever writing to it —
// every MCP tool invocation was going completely unaudited. Logging failures
// must never break the actual tool response (same "never let secondary
// bookkeeping break the primary flow" pattern as modules/feedback/service.py
// on the Python side) — errors are caught and logged, not surfaced to the
// caller or retried.

interface McpToolCallLog {
  tenantId: string;
  requestingClient: string;
  toolName: string;
  requestParams: Record<string, unknown>;
  resultDecisionIds: string[] | null;
  latencyMs: number;
}

function extractResultDecisionIds(
  toolName: string,
  result: Record<string, unknown>,
): string[] | null {
  if (toolName === "search_decisions") {
    const decisions = result.decisions as Array<{ id: string }> | undefined;
    return decisions ? decisions.map((d) => d.id) : [];
  }
  if (toolName === "get_decision_context") {
    const decision = result.decision as { id: string } | undefined;
    return decision ? [decision.id] : [];
  }
  return null;
}

async function logMcpToolCall(
  supabase: SupabaseClient,
  entry: McpToolCallLog,
): Promise<void> {
  try {
    const { error } = await supabase.from("mcp_tool_calls").insert({
      tenant_id: entry.tenantId,
      requesting_client: entry.requestingClient,
      tool_name: entry.toolName,
      request_params: entry.requestParams,
      result_decision_ids: entry.resultDecisionIds,
      latency_ms: Math.round(entry.latencyMs),
    });
    if (error) {
      console.error("Failed to log mcp_tool_calls row:", error);
    }
  } catch (err) {
    console.error("Failed to log mcp_tool_calls row:", (err as Error).message);
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const appSecret = Deno.env.get("APP_SECRET_KEY");
  if (!appSecret) {
    console.error("APP_SECRET_KEY is not configured");
    return new Response("Server misconfiguration", { status: 500 });
  }

  // ── Auth: extract and verify the tenant JWT ──────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return jsonResponse(
      { error: "Missing Authorization header" },
      401,
    );
  }

  let ctx: TenantContext;
  try {
    ctx = await verifyTenantJwt(token, appSecret);
  } catch (err) {
    console.warn("JWT verification failed:", (err as Error).message);
    return jsonResponse(
      { error: "Unauthorized — invalid or expired token" },
      401,
    );
  }

  // ── REST convenience: GET /tools/list ────────────────────────────────────
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/tools/list")) {
    return jsonResponse({ tools: TOOL_SCHEMAS });
  }

  // ── JSON-RPC 2.0 dispatch (POST only) ────────────────────────────────────
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: JsonRpcRequest;
  try {
    body = await req.json();
  } catch {
    return jsonrpcError(null, -32700, "Parse error");
  }

  const rpcId = body.id ?? null;
  const method = body.method ?? "";
  const params = (body.params ?? {}) as Record<string, unknown>;

  // MCP initialize handshake
  if (method === "initialize") {
    return jsonrpcOk(rpcId, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "locus-ai", version: "0.1.0" },
    });
  }

  if (method === "tools/list") {
    return jsonrpcOk(rpcId, { tools: TOOL_SCHEMAS });
  }

  if (method !== "tools/call") {
    return jsonrpcError(rpcId, -32601, `Method not found: ${method}`);
  }

  // ── Tool dispatch ─────────────────────────────────────────────────────────
  const toolName = String(params.name ?? "");
  const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
  const requestingClient = req.headers.get("User-Agent") ?? "unknown";

  // Service-role client: bypasses RLS. Tenant isolation is enforced by
  // explicit tenant_id WHERE clauses on every query (Layer-2).
  const supabase = getServiceClient();

  const t0 = Date.now();
  let result: Record<string, unknown>;

  try {
    if (toolName === "search_decisions") {
      result = await toolSearchDecisions(toolArgs, ctx, supabase);
    } else if (toolName === "get_decision_context") {
      result = await toolGetDecisionContext(toolArgs, ctx, supabase);
    } else {
      return toolError(rpcId, `Unknown tool: ${toolName}`);
    }
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.error(`MCP tool ${toolName} failed:`, (err as Error).message);
    await logMcpToolCall(supabase, {
      tenantId: ctx.tenantId,
      requestingClient,
      toolName,
      requestParams: toolArgs,
      resultDecisionIds: null,
      latencyMs: elapsedMs,
    });
    return toolError(rpcId, "Internal error");
  }

  const elapsedMs = Date.now() - t0;
  console.log(
    `MCP tool=${toolName} tenant=${ctx.tenantId} latency=${elapsedMs}ms`,
  );

  await logMcpToolCall(supabase, {
    tenantId: ctx.tenantId,
    requestingClient,
    toolName,
    requestParams: toolArgs,
    resultDecisionIds: extractResultDecisionIds(toolName, result),
    latencyMs: elapsedMs,
  });

  return jsonrpcOk(rpcId, {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  });
});
