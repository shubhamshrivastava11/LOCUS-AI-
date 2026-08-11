// supabase/functions/admin-dedupe-decisions/index.ts
//
// One-off maintenance sweep: finds and resolves duplicate decisions already
// sitting in the database, across every tenant. This is the same
// "duplicates" outcome ai-worker's detectConflicts() already applies to new
// captures (older row gets decisions.superseded_by set to the newer row),
// except detectConflicts only ever compares a brand-new decision against a
// handful of nearest existing ones at the moment it's embedded - it never
// retroactively re-checks the ones that existed before that logic shipped,
// or that fell outside its candidate window at the time.
//
// Deliberately does NOT call Claude - this reuses embeddings that already
// exist in decision_embeddings (from the normal capture pipeline), so a full
// historical sweep costs zero Anthropic tokens. The tradeoff is precision:
// no LLM double-check of "same real person/team" the way detectConflicts
// does, so the similarity floor here is set high (0.96 cosine) specifically
// to avoid false positives without that check.
//
// Two-phase and safe to call repeatedly:
//   ?mode=preview (default) - read-only, reports what WOULD change.
//   ?mode=apply             - marks older duplicates superseded_by the
//                              newer one, then hard-deletes any row that is
//                              now superseded AND not itself the
//                              superseded_by target of some other row (that
//                              guard avoids ever violating the
//                              fk_decisions_superseded_tenant FK - a 3+-way
//                              duplicate chain may need a second ?mode=apply
//                              pass to fully collapse, which is safe to do).
//
// Requires a valid Supabase key in the Authorization header (default JWT
// verification, not deployed with --no-verify-jwt) - this is an admin
// maintenance tool, not a public endpoint.

import { withAdmin } from "../_shared/db.ts";

const SIMILARITY_FLOOR = 0.96;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const apply = url.searchParams.get("mode") === "apply";

  try {
    const result = await withAdmin(async (sql) => {
      // All-pairs comparison within a tenant, same record_type, neither side
      // already superseded, above the similarity floor. Ordered so the
      // strongest matches are marked first (matters for 3+-way chains - see
      // module comment).
      const pairs = await sql`
        SELECT
          a.tenant_id,
          a.id AS older_id, a.decision_statement AS older_statement, a.created_at AS older_created_at,
          b.id AS newer_id, b.decision_statement AS newer_statement, b.created_at AS newer_created_at,
          1 - (ea.embedding <=> eb.embedding) AS similarity
        FROM public.decision_embeddings ea
        JOIN public.decisions a ON a.id = ea.decision_id AND a.tenant_id = ea.tenant_id
        JOIN public.decision_embeddings eb ON eb.tenant_id = ea.tenant_id AND eb.decision_id != ea.decision_id
        JOIN public.decisions b ON b.id = eb.decision_id AND b.tenant_id = eb.tenant_id
        WHERE a.created_at < b.created_at
          AND a.record_type = b.record_type
          AND a.superseded_by IS NULL
          AND b.superseded_by IS NULL
          AND 1 - (ea.embedding <=> eb.embedding) >= ${SIMILARITY_FLOOR}
        ORDER BY similarity DESC
      `;

      type Pair = {
        tenant_id: string; older_id: string; older_statement: string; older_created_at: string;
        newer_id: string; newer_statement: string; newer_created_at: string; similarity: number;
      };
      const typedPairs = pairs as unknown as Pair[];

      if (!apply) {
        return {
          mode: "preview",
          pairs_found: typedPairs.length,
          sample: typedPairs.slice(0, 30).map((p) => ({
            tenant_id: p.tenant_id,
            similarity: Number(p.similarity.toFixed(4)),
            would_delete: { id: p.older_id, statement: p.older_statement, created_at: p.older_created_at },
            keeps: { id: p.newer_id, statement: p.newer_statement, created_at: p.newer_created_at },
          })),
        };
      }

      let marked = 0;
      for (const p of typedPairs) {
        const res = await sql`
          UPDATE public.decisions SET superseded_by = ${p.newer_id}
          WHERE id = ${p.older_id} AND tenant_id = ${p.tenant_id} AND superseded_by IS NULL
        `;
        marked += res.count ?? 0;
      }

      const deleted = await sql`
        DELETE FROM public.decisions
        WHERE superseded_by IS NOT NULL
          AND id NOT IN (SELECT superseded_by FROM public.decisions WHERE superseded_by IS NOT NULL)
        RETURNING id, tenant_id, decision_statement, created_at
      `;

      const remainingSuperseded = await sql`
        SELECT COUNT(*)::int AS n FROM public.decisions WHERE superseded_by IS NOT NULL
      `;

      return {
        mode: "apply",
        pairs_found: typedPairs.length,
        marked_superseded: marked,
        deleted_count: deleted.length,
        deleted_sample: deleted.slice(0, 30),
        // >0 here means a 3+-way duplicate chain didn't fully collapse in
        // this pass - call ?mode=apply again to finish it off.
        superseded_rows_still_pending_deletion: remainingSuperseded[0]?.n ?? 0,
      };
    });

    return json(result);
  } catch (err) {
    console.error("admin-dedupe-decisions failed:", err);
    return json({ error: String(err) }, 500);
  }
});
