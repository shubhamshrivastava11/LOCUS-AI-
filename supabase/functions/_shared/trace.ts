// supabase/functions/_shared/trace.ts
//
// Minimal request tracing: stage timings written to public.request_traces,
// one row per request. Closes the gap where metadata.latency_ms was the
// only number the system emitted and nothing collected it.
//
// Two rules this file exists to enforce:
//
//   1. Tracing NEVER fails the request it is tracing. Every write is
//      wrapped and swallowed - an observability table filling up, a
//      connection blip, or a schema drift must not turn a working /search
//      into a 500. A missing trace row is an acceptable loss; a failed
//      answer because of a telemetry insert is not.
//
//   2. It costs one insert, after the response is already assembled - the
//      timing data is gathered in memory during the request and written
//      once at the end, never between stages.

import { withTenant } from "./db.ts";

export class Trace {
  private marks: Record<string, number> = {};
  private startedAt = Date.now();
  private last = Date.now();

  /** Close off a stage and record how long it took since the previous mark. */
  mark(stage: string): void {
    const now = Date.now();
    this.marks[stage] = now - this.last;
    this.last = now;
  }

  /**
   * Record a non-timing fact about the request (recorded as 1 so it sits in
   * the same numeric stages map). Used to make "which code path ran" a
   * question answerable from data rather than inference.
   */
  flag(name: string): void {
    this.marks[name] = 1;
  }

  get totalMs(): number {
    return Date.now() - this.startedAt;
  }

  get stages(): Record<string, number> {
    return { ...this.marks };
  }

  /**
   * Persist the trace. Fire-and-forget by design: callers should NOT await
   * this before responding, and it can never throw into the caller.
   */
  async write(
    tenantId: string | null,
    route: string,
    opts: { ok?: boolean; error?: string } = {},
  ): Promise<void> {
    const total = this.totalMs;
    const stages = this.stages;
    try {
      if (!tenantId) return; // RLS is tenant-scoped; an unauthenticated failure has nowhere to go
      await withTenant(tenantId, async (sql) => {
        await sql`
          insert into public.request_traces (tenant_id, route, total_ms, stages, ok, error)
          values (
            ${tenantId}::uuid,
            ${route},
            ${total},
            ${sql.json(stages)}::jsonb,
            ${opts.ok ?? true},
            ${opts.error ?? null}
          )
        `;
      });
    } catch (err) {
      // Deliberately swallowed - see rule 1 above.
      console.error("trace write failed (request itself unaffected):", err);
    }
  }
}
