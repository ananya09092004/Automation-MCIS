"""P-SEC-2 regression tests: Playwright navigation SSRF/scheme policy.

Before this fix, every Nexus browser-automation navigation path called
page.goto(url) with zero validation. These tests prove the centralized
policy (browser/security/url_policy.py, installed on every page via
browser/security/navigation_guard.py / browser/engines/engine.py) actually
blocks unsafe destinations, without breaking normal public-website
navigation.
"""

import pytest

from browser.security.url_policy import BrowserNavigationPolicy, UnsafeNavigationError, default_policy


# ---------------------------------------------------------------------------
# Pure policy unit tests (no real browser/network needed -- fast, always run)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://example.com/",
    "https://example.com/path?query=1#frag",
    "http://example.com/",  # http is explicitly still supported
])
def test_public_url_allowed(url):
    assert default_policy().validate(url) == url


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "file:///C:/Windows/System32/config/SAM",
])
def test_file_scheme_denied_by_default(url):
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate(url)


@pytest.mark.parametrize("url", [
    "javascript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "about:blank",
    "ftp://example.com/file",
    "chrome://settings",
    "weirdscheme://host/path",
])
def test_unsupported_scheme_denied(url):
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate(url)


@pytest.mark.parametrize("url", [
    "https://localhost/",
    "http://localhost:8080/",
    "https://127.0.0.1/",
    "http://127.0.0.1:9000/admin",
    "http://127.5.5.5/",          # anywhere in 127.0.0.0/8
    "http://169.254.169.254/latest/meta-data/",  # cloud metadata endpoint
    "http://169.254.0.1/",        # link-local
    "http://10.0.0.5/",           # RFC1918
    "http://172.16.0.1/",         # RFC1918
    "http://192.168.1.1/",        # RFC1918
    "http://0.0.0.0/",            # unspecified
    "http://[::1]/",              # IPv6 loopback
    "http://[fe80::1]/",          # IPv6 link-local
    "http://[fc00::1]/",          # IPv6 unique local (private)
    "http://[::ffff:127.0.0.1]/",  # IPv4-mapped IPv6 loopback
])
def test_private_and_internal_destinations_denied(url):
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate(url)


def test_malformed_url_denied():
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate("")
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate(None)
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate("not a url at all, just text")
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate("https://")  # scheme with no host


def test_unresolvable_hostname_denied():
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate("https://this-domain-should-never-exist.invalid-tld-nexus-test/")


def test_test_only_file_url_opt_in_works_and_is_explicit():
    """The relaxed policy exists ONLY for tests that explicitly construct
    it -- proving it is opt-in, not a change to the default."""
    relaxed = BrowserNavigationPolicy(allow_file_urls=True)
    assert relaxed.validate("file:///tmp/fixture.html") == "file:///tmp/fixture.html"
    # The production default is completely unaffected by that other
    # policy instance existing -- no shared/global state leaks.
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate("file:///tmp/fixture.html")


def test_test_only_extra_allowed_hosts_opt_in_is_scoped():
    relaxed = BrowserNavigationPolicy(extra_allowed_hosts=frozenset({"127.0.0.1"}))
    assert relaxed.validate("http://127.0.0.1:9999/") == "http://127.0.0.1:9999/"
    # Only the explicitly allowlisted host is exempted -- a different
    # private destination is still blocked even on the relaxed instance.
    with pytest.raises(UnsafeNavigationError):
        relaxed.validate("http://169.254.169.254/")
    with pytest.raises(UnsafeNavigationError):
        default_policy().validate("http://127.0.0.1:9999/")


# ---------------------------------------------------------------------------
# Real-browser integration tests: prove the guard is actually wired onto
# every page a Nexus browser executor creates, and that it blocks the
# navigation (not just the standalone policy function) -- including a
# same-navigation server redirect into a blocked destination.
# ---------------------------------------------------------------------------

def test_navigate_action_to_blocked_scheme_is_refused_end_to_end(tmp_path):
    from browser.platform_executor import BrowserPlatformExecutor
    from common import ExecutionAction

    page_file = tmp_path / "unused.html"
    page_file.write_text("<h1>unused</h1>", encoding="utf-8")
    executor = BrowserPlatformExecutor()  # strict production default -- no opt-in
    try:
        result = executor.execute(ExecutionAction(
            platform="browser", action="navigate", value=page_file.as_uri(),
            parameters={"browser_options": {"headless": True}},
        ))
        assert not result.success
    finally:
        executor.stop()


def test_navigate_action_to_public_https_is_allowed_end_to_end():
    """A real public HTTPS destination must still work -- this fix must
    not break normal customer-authorized website navigation. Served
    locally over HTTP via a loopback test server, but validated through
    an explicit per-host allowlist so the DEFAULT production policy
    (which this test does not use) is never the thing under test here --
    see test_public_url_allowed above for the scheme-level guarantee
    against a real https:// URL without any override."""
    import functools
    import http.server
    import threading

    from browser.platform_executor import BrowserPlatformExecutor
    from browser.security.url_policy import BrowserNavigationPolicy
    from common import ExecutionAction

    pytest.importorskip("playwright")

    handler = functools.partial(http.server.SimpleHTTPRequestHandler)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/"
        executor = BrowserPlatformExecutor(
            navigation_policy=BrowserNavigationPolicy(extra_allowed_hosts=frozenset({"127.0.0.1"}))
        )
        try:
            result = executor.execute(ExecutionAction(
                platform="browser", action="navigate", value=url,
                parameters={"browser_options": {"headless": True}},
            ))
            assert result.success, result.error
        finally:
            executor.stop()
    finally:
        server.shutdown()
        thread.join(timeout=3)


def test_redirect_to_blocked_destination_is_refused_end_to_end():
    """The navigation guard intercepts every request Playwright is about
    to send, including each hop of a server-side redirect -- so a
    page.goto() to an ALLOWED url that then 302-redirects to a BLOCKED
    one must still fail, not silently land on the blocked destination."""
    import http.server
    import threading

    from browser.platform_executor import BrowserPlatformExecutor
    from browser.security.url_policy import BrowserNavigationPolicy
    from common import ExecutionAction

    pytest.importorskip("playwright")

    class _RedirectingHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            # Redirects to a private destination the allowlist does NOT
            # cover -- only 127.0.0.1 itself is allowlisted below, not
            # this target, so this must be blocked even though the
            # initial request to 127.0.0.1 was allowed.
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
            self.end_headers()

        def log_message(self, *args):
            pass  # keep test output quiet

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RedirectingHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/"
        executor = BrowserPlatformExecutor(
            navigation_policy=BrowserNavigationPolicy(extra_allowed_hosts=frozenset({"127.0.0.1"}))
        )
        try:
            result = executor.execute(ExecutionAction(
                platform="browser", action="navigate", value=url,
                parameters={"browser_options": {"headless": True}},
            ))
            assert not result.success, "a redirect to a blocked internal destination must not succeed"
        finally:
            executor.stop()
    finally:
        server.shutdown()
        thread.join(timeout=3)
