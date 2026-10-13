"""Installs browser_navigation_policy on a live Playwright page so that
EVERY navigation request it ever makes -- the initial page.goto(), a link
click, back/forward, a new tab, AND each hop of a server-side redirect --
is validated before the browser ever connects to it.

Validating only the URL the caller passed to page.goto() is not enough:
if the server then replies with a 3xx redirect, Chromium follows it
internally, and (confirmed empirically against Playwright 1.56 on
Chromium) route.continue_() on the first request does NOT cause
page.route() to be re-invoked for the redirect's own request -- only
passive observers like page.on("request") see it, too late to stop it.
To actually enforce the policy on every hop, this module takes over the
whole navigation itself: it fetches the request's URL with redirects
disabled (route.fetch(..., max_redirects=0)), validates any 3xx
Location header BEFORE following it, and repeats until a non-redirect
response is reached (or a hop count limit is hit), fulfilling the route
with that final response. Only Playwright's own cookie/credential
handling is reused (via route.fetch, which shares the page's context);
no separate HTTP client is introduced.
"""

from __future__ import annotations

from urllib.parse import urljoin, urlsplit

from browser.security.url_policy import BrowserNavigationPolicy, UnsafeNavigationError, default_policy

_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_MAX_REDIRECTS = 10


def install_navigation_guard(page, policy: BrowserNavigationPolicy | None = None) -> None:
    policy = policy or default_policy()

    def _handle(route) -> None:
        request = route.request
        if not request.is_navigation_request():
            route.continue_()
            return

        try:
            policy.validate(request.url)
        except UnsafeNavigationError:
            route.abort()
            return

        if (urlsplit(request.url).scheme or "").lower() == "file":
            # file:// can only ever reach this point via an explicit
            # test-only policy override (allow_file_urls=True -- see
            # url_policy.py), never in production. It cannot redirect
            # and route.fetch() cannot fetch it (APIRequestContext only
            # speaks http/https), so there is nothing to redirect-chase.
            route.continue_()
            return

        current_url = request.url
        for _ in range(_MAX_REDIRECTS):
            try:
                response = route.fetch(url=current_url, max_redirects=0)
            except Exception:
                # Network-level failure fetching this hop ourselves (DNS,
                # connection refused, timeout, ...) -- let it surface as
                # a normal navigation failure rather than silently
                # falling back to the browser's own (unvalidated) fetch.
                route.abort()
                return

            if response.status in _REDIRECT_STATUSES:
                location = response.headers.get("location")
                if not location:
                    route.abort()
                    return
                next_url = urljoin(current_url, location)
                try:
                    policy.validate(next_url)
                except UnsafeNavigationError:
                    route.abort()
                    return
                current_url = next_url
                continue

            route.fulfill(response=response)
            return

        route.abort()  # too many redirect hops

    page.route("**/*", _handle)
