/** Production app origin - custom domain, apex only (www permanently
 * redirects to this at the edge via vercel.json, so there is exactly one
 * canonical origin for the PKCE OAuth flow to start and finish on).
 * Fallback for non-browser contexts only; in the browser this always
 * defers to the actual origin the app is running on, so OAuth redirects
 * work correctly across preview deployments and independent forks too,
 * not just this one canonical URL. */
export const APP_ORIGIN = 'https://locusaiapp.com'

export function getAppOrigin() {
  if (typeof window !== 'undefined') {
    return window.location.origin
  }
  return APP_ORIGIN
}

export function getAuthCallbackUrl() {
  return `${getAppOrigin()}/?auth_callback=1`
}
