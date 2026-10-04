import { timingSafeEqual } from 'node:crypto';

/** Check HTTP and WebSocket requests against this exact, ephemeral app origin. */
export function authorizeDesktopRequest(req, { token, origin, websocket = false }) {
  if (!origin || !token) return false;
  const expected = new URL(origin);
  if (req.headers.host !== expected.host) return false;
  const remote = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const suppliedOrigin = req.headers.origin;
  if ((websocket || suppliedOrigin) && suppliedOrigin !== origin) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const actual = Buffer.from(value.slice(7));
  const secret = Buffer.from(token);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}

export function desktopMiddleware(getCredentials) {
  return (req, res, next) => {
    if (!authorizeDesktopRequest(req, getCredentials())) {
      return res.status(403).json({ error: 'This service is private to the desktop app' });
    }
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (req.body?.isLocal) return res.status(400).json({ error: 'Desktop nodes must use remote SSH; local Mac collection is unavailable' });
    next();
  };
}
