/**
 * Layer 5 — SSRF-safe outbound HTTP client used by EVERY connector.
 *
 * A request is sent only when ALL of these hold, for the first hop AND
 * every redirect hop:
 *   - scheme is https (http only for test clients built with allowInsecureHttp)
 *   - no userinfo in the URL; port is the scheme default (or explicitly allowed)
 *   - hostname is on the caller's allowlist (exact or "*.suffix")
 *   - hostname is not an internal name (localhost, *.local, *.internal,
 *     metadata.google.internal, single-label names …)
 *   - EVERY address the hostname resolves to is public (no loopback,
 *     private, CGNAT, link-local / cloud metadata, multicast, reserved,
 *     unique-local, IPv4-mapped/NAT64/6to4 forms of those …)
 *   - the socket connects to the address that was validated (pinned
 *     lookup) → DNS rebinding between check and connect is impossible
 * and the response is bounded by a hard deadline, a byte limit and an
 * optional content-type allowlist. Redirects are followed manually (GET/
 * HEAD only, max 3); credentials are dropped if the host changes.
 * Errors carry a code and a generic message — never headers or bodies.
 */
'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

class SafeHttpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafeHttpError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc * 256) + Number(o), 0) >>> 0;
}
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function expandIPv6(ip) {
  let s = ip.split('%')[0].toLowerCase();
  // Embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1) → two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (net.isIPv4(tail)) {
    const n = ipv4ToInt(tail);
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  let groups;
  if (s.includes('::')) {
    const [head, rest] = s.split('::');
    const h = head ? head.split(':') : [];
    const r = rest ? rest.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - r.length)).fill('0'), ...r];
  } else {
    groups = s.split(':');
  }
  return groups.slice(0, 8).map((g) => parseInt(g, 16) || 0);
}

function isBlockedIPv6(ip) {
  const g = expandIPv6(ip);
  const embeddedV4 = (a, b) => `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`;
  const allZeroUpTo = (k) => g.slice(0, k).every((x) => x === 0);
  if (g.every((x) => x === 0)) return true;                              // ::
  if (allZeroUpTo(7) && g[7] === 1) return true;                         // ::1
  if (allZeroUpTo(5) && g[5] === 0xffff) return isBlockedIPv4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (allZeroUpTo(6)) return true;                                       // ::a.b.c.d (deprecated compat)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedIPv4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedIPv4(embeddedV4(g[1], g[2]));    // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;                           // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                           // fe80::/10 link local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                           // fec0::/10 site local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;                           // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                   // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only
  return false;
}

function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return !isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return !isBlockedIPv6(ip);
  return false;
}

const INTERNAL_NAME_RE = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal', 'metadata.azure.com']);

function isInternalHostname(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (!h || METADATA_NAMES.has(h) || INTERNAL_NAME_RE.test(h)) return true;
  if (!net.isIP(h) && !h.includes('.')) return true; // single-label → resolves via search domains
  return false;
}

function hostAllowed(host, allowlist) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return (allowlist || []).some((entry) => {
    const e = String(entry).toLowerCase();
    if (e.startsWith('*.')) return h.endsWith(e.slice(1)) && h.length > e.length - 1;
    return h === e;
  });
}

// ---------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'private-token']);

/**
 * createSafeHttpClient() — production uses the defaults. The injectable
 * hooks exist ONLY so tests can point the network path at a local test
 * server; they are never read from the environment or from user input.
 */
function createSafeHttpClient({
  lookup = dns.lookup,
  isAddressAllowed = isPublicAddress,
  allowInsecureHttp = false,
  allowedPorts = null,
} = {}) {
  function resolveHost(hostname) {
    return new Promise((resolve, reject) => {
      if (net.isIP(hostname)) {
        resolve([{ address: hostname, family: net.isIP(hostname) }]);
        return;
      }
      lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
        if (err) reject(new SafeHttpError('DNS_FAILURE', 'Could not resolve the destination host'));
        else resolve(Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }]);
      });
    });
  }

  async function validateTarget(urlString, allowedHosts, credentialHost) {
    let u;
    try { u = new URL(urlString); } catch { throw new SafeHttpError('INVALID_URL', 'Invalid URL'); }
    if (u.protocol !== 'https:' && !(allowInsecureHttp && u.protocol === 'http:')) {
      throw new SafeHttpError('BLOCKED_DESTINATION', 'Only https destinations are allowed');
    }
    if (u.username || u.password) throw new SafeHttpError('BLOCKED_DESTINATION', 'Credentials in URLs are not allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    const okPorts = allowedPorts || [443, ...(allowInsecureHttp ? [80] : [])];
    if (u.port && !okPorts.includes(port)) throw new SafeHttpError('BLOCKED_DESTINATION', 'Destination port is not allowed');
    if (!hostAllowed(host, allowedHosts)) throw new SafeHttpError('HOST_NOT_ALLOWED', 'Destination host is not on this integration\'s allowlist');
    if (isInternalHostname(host)) throw new SafeHttpError('BLOCKED_DESTINATION', 'Internal hostnames are not allowed');
    const addrs = await resolveHost(host);
    if (!addrs.length) throw new SafeHttpError('DNS_FAILURE', 'Could not resolve the destination host');
    // EVERY resolved address must be public (defeats split / mixed answers).
    if (addrs.some((a) => !isAddressAllowed(a.address, host))) {
      throw new SafeHttpError('BLOCKED_DESTINATION', 'Destination resolves to a private or reserved address');
    }
    return { u, host, port, pinned: addrs[0], sameCredentialHost: credentialHost ? host === credentialHost : true };
  }

  function sendOnce({ target, method, headers, body, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
      const { u, host, port, pinned } = target;
      const mod = u.protocol === 'https:' ? https : http;
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const req = mod.request({
        protocol: u.protocol,
        hostname: host,
        port,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        servername: net.isIP(host) ? undefined : host,
        agent: false,
        // Pinned: connect to exactly the address that was validated.
        lookup: (_h, opts, cb) => {
          if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family || net.isIP(pinned.address) }]);
          else cb(null, pinned.address, pinned.family || net.isIP(pinned.address));
        },
      }, (res) => {
        const declared = Number(res.headers['content-length'] || 0);
        if (declared > maxBytes) {
          res.destroy();
          done(reject, new SafeHttpError('RESPONSE_TOO_LARGE', 'Response exceeded the size limit'));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            done(reject, new SafeHttpError('RESPONSE_TOO_LARGE', 'Response exceeded the size limit'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', () => done(reject, new SafeHttpError('NETWORK_ERROR', 'Network error while reading the response')));
      });
      const timer = setTimeout(() => {
        req.destroy();
        done(reject, new SafeHttpError('TIMEOUT', 'The request timed out'));
      }, timeoutMs);
      req.on('error', () => done(reject, new SafeHttpError('NETWORK_ERROR', 'Could not connect to the destination')));
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    });
  }

  /**
   * request({ url, method, headers, body, allowedHosts, allowedMethods,
   *           timeoutMs, maxBytes, maxRedirects, allowedContentTypes })
   * → { status, contentType, body (string), finalUrl, redirects }
   */
  async function request({
    url, method = 'GET', headers = {}, body, allowedHosts, allowedMethods = ['GET'],
    timeoutMs = 15000, maxBytes = 512 * 1024, maxRedirects = 3, allowedContentTypes = null,
  }) {
    const m = String(method).toUpperCase();
    if (!allowedMethods.includes(m)) throw new SafeHttpError('METHOD_NOT_ALLOWED', `Method ${m} is not allowed`);
    if (!Array.isArray(allowedHosts) || !allowedHosts.length) throw new SafeHttpError('HOST_NOT_ALLOWED', 'No allowed hosts configured');
    const deadline = Date.now() + timeoutMs;
    const cleanHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined && v !== null) cleanHeaders[k] = String(v);
    }
    let payload;
    if (body !== undefined && body !== null) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      cleanHeaders['Content-Length'] = String(payload.length);
    }
    let current = url;
    let credentialHost = null;
    let redirects = 0;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SafeHttpError('TIMEOUT', 'The request timed out');
      const target = await validateTarget(current, allowedHosts, credentialHost);
      if (!credentialHost) credentialHost = target.host;
      const hopHeaders = { ...cleanHeaders };
      if (!target.sameCredentialHost) {
        for (const k of Object.keys(hopHeaders)) if (CREDENTIAL_HEADERS.has(k.toLowerCase())) delete hopHeaders[k];
      }
      const res = await sendOnce({ target, method: m, headers: hopHeaders, body: payload, timeoutMs: Math.min(remaining, timeoutMs), maxBytes });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        if (m !== 'GET' && m !== 'HEAD') throw new SafeHttpError('REDIRECT_NOT_ALLOWED', 'Redirects are not followed for this method');
        if (redirects >= maxRedirects) throw new SafeHttpError('TOO_MANY_REDIRECTS', 'Too many redirects');
        redirects += 1;
        try { current = new URL(res.headers.location, current).toString(); } catch { throw new SafeHttpError('INVALID_URL', 'Invalid redirect location'); }
        continue; // re-validated (scheme, host allowlist, DNS, addresses) on the next loop
      }
      const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (allowedContentTypes && res.body.length && !allowedContentTypes.some((t) => (t.endsWith('/*') ? contentType.startsWith(t.slice(0, -1)) : contentType === t))) {
        throw new SafeHttpError('BAD_CONTENT_TYPE', 'Unexpected response content type');
      }
      const safeHeaders = {};
      for (const h of ['x-ratelimit-remaining', 'retry-after', 'x-message-id']) if (res.headers[h] !== undefined) safeHeaders[h] = String(res.headers[h]);
      return { status: res.status, contentType, body: res.body.toString('utf8'), finalUrl: current, redirects, headers: safeHeaders };
    }
  }

  return { request, validateTarget };
}

module.exports = {
  createSafeHttpClient, SafeHttpError, isPublicAddress, isInternalHostname, hostAllowed, isBlockedIPv4, isBlockedIPv6,
};
