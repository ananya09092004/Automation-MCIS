"""Centralized SSRF/scheme policy for every Nexus Playwright navigation.

-- P-SEC-2 (security hardening, pre-launch) --------------------------------
Nexus's own browser-automation navigation (browser/skills/navigation.py,
browser/controller/controller.py, browser/runtime/runtime.py,
browser/platform_executor.py) previously called page.goto(url) with ZERO
validation -- no scheme allowlist, no private-IP/metadata-endpoint
blocking -- unlike the backend's connector HTTP path
(mcis/backend/services/integrations/safeHttp.js), which has exactly this
protection for LLM-connector HTTP calls. An LLM-planned or prompt-injected
navigation could previously be sent to file://, http://169.254.169.254/,
an internal service on the local network, etc.

This module is the Python-native equivalent for the browser-automation
engine -- the SAME concerns (scheme allowlisting, private/internal
destination blocking, redirect safety) as safeHttp.js, implemented
idiomatically for Python/Playwright rather than ported line-for-line from
JavaScript. It is applied once, at the single place every Playwright Page
object is created (browser/engines/engine.py), via
browser/security/navigation_guard.py, so it covers every navigation path
(goto, link clicks, new tabs, back/forward, redirects) rather than one
call site.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_SCHEMES = frozenset({"https", "http"})

# Hostnames that resolve to "this machine" without even needing a DNS
# lookup -- blocked unconditionally regardless of what they'd resolve to.
_BLOCKED_HOSTNAMES = frozenset({
    "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
})


class UnsafeNavigationError(ValueError):
    """Raised when a URL fails the navigation policy: disallowed scheme,
    disallowed/unresolvable host, or a destination that resolves to a
    private, loopback, link-local, or other internal/reserved address."""


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.is_loopback or ip.is_link_local or ip.is_private or ip.is_reserved \
            or ip.is_multicast or ip.is_unspecified:
        return True
    # IPv4-mapped (::ffff:10.0.0.1) or 6to4 (2002::/16) IPv6 wrapping a
    # blocked IPv4 address -- check the embedded address too.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None and _is_blocked_ip(mapped):
        return True
    sixtofour = getattr(ip, "sixtofour", None)
    if sixtofour is not None and _is_blocked_ip(sixtofour):
        return True
    return False


def _resolve_all_addresses(hostname: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except (socket.gaierror, UnicodeError) as error:
        raise UnsafeNavigationError(f"Could not resolve host: {hostname!r}") from error
    return sorted({info[4][0] for info in infos})


class BrowserNavigationPolicy:
    """Validates that a URL is allowed to be the target of a Nexus
    browser-automation navigation.

    The PRODUCTION default (no arguments) allows only https/http to a
    public destination that is not a private/internal/reserved address.

    ``allow_file_urls`` / ``extra_allowed_hosts`` exist ONLY for test
    fixtures that need to serve a local file or host without a real
    network destination. Production code must never construct a policy
    with either set -- grep for ``allow_file_urls=True`` /
    ``extra_allowed_hosts=`` finding only files under ``tests/`` is the
    intended, auditable state.
    """

    def __init__(
        self,
        *,
        allow_file_urls: bool = False,
        extra_allowed_hosts: frozenset[str] = frozenset(),
    ) -> None:
        self.allow_file_urls = allow_file_urls
        self.extra_allowed_hosts = frozenset(h.lower() for h in extra_allowed_hosts)

    def validate(self, url: str) -> str:
        """Returns `url` unchanged if allowed; raises UnsafeNavigationError
        otherwise. Never partially validates -- any failure raises."""
        if not url or not isinstance(url, str):
            raise UnsafeNavigationError("Empty or non-string URL.")

        parts = urlsplit(url)
        scheme = (parts.scheme or "").lower()

        if scheme == "file":
            if self.allow_file_urls:
                return url
            raise UnsafeNavigationError("file:// navigation is not permitted.")

        if scheme not in ALLOWED_SCHEMES:
            # Explicitly covers javascript:, data:, about:, ftp:, and any
            # other/custom scheme -- default-deny, not a denylist of names.
            raise UnsafeNavigationError(f"Unsupported navigation scheme: {scheme!r}")

        hostname = parts.hostname
        if not hostname:
            raise UnsafeNavigationError(f"URL has no host: {url!r}")
        hostname = hostname.lower()

        if hostname in self.extra_allowed_hosts:
            return url

        if hostname in _BLOCKED_HOSTNAMES:
            raise UnsafeNavigationError(f"Navigation to {hostname!r} is not permitted.")

        literal_ip: ipaddress.IPv4Address | ipaddress.IPv6Address | None
        try:
            literal_ip = ipaddress.ip_address(hostname.strip("[]"))
        except ValueError:
            literal_ip = None

        if literal_ip is not None:
            if _is_blocked_ip(literal_ip):
                raise UnsafeNavigationError(f"Navigation to {hostname!r} is not permitted.")
            return url

        # Hostname (not a literal IP) -- resolve and validate EVERY
        # address it maps to. A hostname that resolves to a private or
        # internal address -- by misconfiguration, or by a deliberate DNS
        # rebinding attempt -- is blocked exactly like a literal private
        # IP would be. This same check also runs again, per request,
        # immediately before Playwright sends it (navigation_guard.py),
        # narrowing (never fully eliminating -- no in-process Python check
        # can) the TOCTOU window a rebinding attack would need between
        # this check and the actual connection.
        for address in _resolve_all_addresses(hostname):
            try:
                resolved_ip = ipaddress.ip_address(address)
            except ValueError:
                continue
            if _is_blocked_ip(resolved_ip):
                raise UnsafeNavigationError(
                    f"{hostname!r} resolves to a blocked internal address ({address})."
                )
        return url


def default_policy() -> BrowserNavigationPolicy:
    """The strict, production-default policy. Always use this unless a
    test explicitly needs a relaxed one (see class docstring)."""
    return BrowserNavigationPolicy()
