/**
 * Global error responses (final-hardening fix).
 *
 * Before: every error that reached the global handler became HTTP 500 —
 * including requests from a disallowed CORS origin and malformed / oversized
 * JSON bodies (client errors). That polluted error logs and 5xx metrics and
 * hid policy refusals. Now:
 *   - disallowed CORS origin → 403 CORS_ORIGIN_DENIED (still no CORS headers)
 *   - body-parser client errors (invalid JSON, too large, bad charset) → their 4xx
 *   - everything else → 500 with a generic message (never err.message)
 * The response body never contains internal error text.
 */
'use strict';

const CORS_DENIED = 'CORS_ORIGIN_DENIED';

function corsOriginDenied() {
  const err = new Error('Origin not allowed by CORS');
  err.status = 403;
  err.code = CORS_DENIED;
  return err;
}

const BODY_ERRORS = {
  'entity.parse.failed': [400, 'INVALID_JSON', 'Request body is not valid JSON'],
  'entity.too.large': [413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'],
  'encoding.unsupported': [415, 'UNSUPPORTED_ENCODING', 'Unsupported request encoding'],
  'charset.unsupported': [415, 'UNSUPPORTED_CHARSET', 'Unsupported request charset'],
  'request.aborted': [400, 'REQUEST_ABORTED', 'Request was aborted'],
};

function createGlobalErrorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return function globalErrorHandler(err, req, res, next) {
    const requestId = req.requestId || null;
    if (err && err.code === CORS_DENIED) {
      logger.warn?.(`CORS origin denied | Route: ${req.path} | request ${requestId || '-'}`);
      return res.status(403).json({ success: false, error: 'Origin not allowed', code: CORS_DENIED, requestId });
    }
    const body = err && err.type && BODY_ERRORS[err.type];
    if (body) {
      logger.warn?.(`${body[1]} | Route: ${req.path} | request ${requestId || '-'}`);
      return res.status(body[0]).json({ success: false, error: body[2], code: body[1], requestId });
    }
    logger.error?.(`${err && err.message} | Route: ${req.path} | request ${requestId || '-'}`);
    return res.status(500).json({ success: false, error: 'Something went wrong', requestId });
  };
}

module.exports = { corsOriginDenied, createGlobalErrorHandler, CORS_DENIED };
