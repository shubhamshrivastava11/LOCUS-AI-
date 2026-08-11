// supabase/functions/_shared/productFacts.ts
//
// Single source of truth for the product facts that need to stay identical
// across the real app UI and Loci's chat widget system prompt - pricing,
// connector status, and the core feature list. Before this, Loci's prompt
// (loci-chat/index.ts) had these hand-typed as prose, completely
// disconnected from wherever the app itself displays them, so a real
// pricing or feature change had no way to reach Loci except someone
// remembering to hand-edit that prompt string too.
//
// loci-chat imports this directly and builds the relevant sections of its
// system prompt from it at module-eval time, so editing this file and
// redeploying loci-chat is the whole "sync" step - no separate generation
// script needed, since Supabase bundles this file into the function the
// same way it already does for every other _shared/*.ts import.
//
// frontend/src/pages/AccountSettings.tsx imports the plan names from here
// too, for the same reason. NOT everything pricing-related can be pulled
// from here, though: the actual price figures shown to a real user in that
// page are baked into the /individual-plan-header.png and
// /team-plan-header.png images themselves (pre-rendered artwork, not text),
// plus a hardcoded mock invoice list - those stay manual. If the price
// changes, PLANS below, the two header images, and that mock invoice list
// all need updating together.

export type PlanFacts = {
  id: "self_serve" | "team";
  name: string;
  priceUsdPerMonth: number;
  features: string[];
};

export const PLANS: PlanFacts[] = [
  {
    id: "self_serve",
    name: "Individual",
    priceUsdPerMonth: 12,
    features: [
      "Own memory sources",
      "Private memory register",
      "Context Search with saved history",
      "Personal Pulse",
      "Catch-Up Brief",
      "6-hour memory refresh",
      "MCP access",
    ],
  },
  {
    id: "team",
    name: "Team",
    priceUsdPerMonth: 15,
    features: [
      "Same core features as Individual",
      "Team-wide memory",
    ],
  },
];

// Marked "upcoming" on the Team plan specifically - not live yet on any plan.
export const TEAM_PLAN_UPCOMING_FEATURES = ["Audit log", "data export", "cookie controls"];

export type ConnectorFacts = { name: string; status: "live" | "roadmap" };

export const CONNECTORS: ConnectorFacts[] = [
  { name: "Gmail", status: "live" },
  { name: "Slack", status: "live" },
  { name: "Notion", status: "live" },
  { name: "SharePoint", status: "roadmap" },
  { name: "OneDrive", status: "roadmap" },
  { name: "Teams", status: "roadmap" },
];

export const CORE_FEATURES: { title: string; description: string }[] = [
  {
    title: "Decision Log / Memory Explorer",
    description: "a filterable log of everything Locus has extracted, filterable by type (Decision / Action Item / Blocker) and by source (Slack / Gmail / Notion).",
  },
  {
    title: "Team Pulse",
    description: "a periodic digest summarizing recent decisions, action items, and blockers across connected sources.",
  },
  {
    title: "Context Search",
    description: "saved, searchable history across everything Locus has ingested.",
  },
  {
    title: "Personal Pulse",
    description: "a weekly digest for an individual user.",
  },
  {
    title: "Catch-Up Brief",
    description: "a quick summary for catching up after time away.",
  },
  {
    title: "MCP access",
    description: "Locus exposes its memory to agent tools (like Claude Code) via MCP tools: search_team_context, get_team_pulse, get_onboarding_brief.",
  },
];

export const MEMORY_REFRESH_CYCLE_HOURS = 6;
export const RAW_CONTENT_RETENTION_DAYS = 30;
export const DATA_RESIDENCY = "US-West";
