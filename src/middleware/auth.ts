import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin, CONFIG } from '../config';

/**
 * Server-side authentication middleware.
 *
 * Every protected endpoint verifies the caller's Supabase access token
 * (Authorization: Bearer <jwt>) with the Supabase Auth API, then confirms the
 * `userId` the caller claims in the body/query actually belongs to that token.
 * This stops the previous design where any client could impersonate any user.
 */

export interface AuthedRequest extends Request {
  /** The verified Supabase user id from the bearer token. */
  authUserId?: string;
}

/** Authenticate the request via a Bearer token. 401 when absent/invalid. */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired session' });
    }
    req.authUserId = data.user.id;
    next();
  } catch (err: any) {
    return res.status(401).json({ success: false, error: 'Invalid or expired session' });
  }
}

/**
 * Reject when the claimed userId doesn't match the authenticated user.
 * Responds with the error itself; returns false (and the caller must abort).
 */
export function requireOwnership(
  req: AuthedRequest,
  res: Response,
  claimedUserId: string | null | undefined
): boolean {
  if (!req.authUserId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return false;
  }
  if (!claimedUserId || claimedUserId !== req.authUserId) {
    res.status(403).json({ success: false, error: 'Forbidden: you can only act on your own account' });
    return false;
  }
  return true;
}

/**
 * Admin-only guard: the bearer token must be the Supabase service-role key
 * (which only exists in backend/.env). Used for operations regular users
 * must never reach (e.g. direct wallet crediting).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const serviceKey = CONFIG.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return res.status(503).json({ success: false, error: 'Admin access is not configured' });
  }
  if (token !== serviceKey) {
    return res.status(401).json({ success: false, error: 'Admin authentication required' });
  }
  next();
}
