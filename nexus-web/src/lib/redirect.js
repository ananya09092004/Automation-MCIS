/** Full-page navigation to a provider-hosted page (checkout / billing portal). Isolated so tests can mock it. */
export function redirectTo(url) { window.location.assign(url); }
