/** Session keys shared across auth + onboarding screens. */
export const DEMO_EMAIL_KEY = 'locus:demo-email'
export const WORKSPACES_DONE_KEY = 'locus:workspaces-connected'

/**
 * Holds a pending team-invite token across the Google OAuth round trip -
 * signInWithOAuth's redirectTo is a single fixed callback URL shared by
 * every sign-in path, so it can't carry custom state through Google's
 * redirect itself. JoinTeam.tsx sets this right before starting sign-in;
 * OAuthCallback.tsx checks it right after the session is established, and
 * always clears it whether accept succeeds or fails, so a leftover token
 * never resurfaces on some later, unrelated sign-in.
 */
export const PENDING_INVITE_TOKEN_KEY = 'locus:pending-invite-token'

/**
 * localStorage (not sessionStorage - should survive a browser restart, same
 * as a real "seen" flag would) marking that the user has opened Team Pulse
 * at least once. TeamPulse sets it on mount and dispatches
 * TEAM_PULSE_SEEN_EVENT so DashboardNav's badge dot can clear immediately in
 * the same tab, without waiting for a 'storage' event (which only fires in
 * *other* tabs, never the one that made the change).
 */
export const TEAM_PULSE_SEEN_KEY = 'locus:team-pulse-seen'
export const TEAM_PULSE_SEEN_EVENT = 'locus:team-pulse-seen'

/** localStorage flag marking that a visitor has already seen (and
 * dismissed, or joined via) the early-access popup on the marketing site -
 * same "survive a browser restart" reasoning as TEAM_PULSE_SEEN_KEY, so it
 * only ever shows once per browser, not once per page load. */
export const EARLY_ACCESS_POPUP_SEEN_KEY = 'locus:early-access-popup-seen'
