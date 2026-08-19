"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requireOwnership = requireOwnership;
exports.requireAdmin = requireAdmin;
const config_1 = require("../config");
/** Authenticate the request via a Bearer token. 401 when absent/invalid. */
async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    try {
        const { data, error } = await config_1.supabaseAdmin.auth.getUser(token);
        if (error || !data.user) {
            return res.status(401).json({ success: false, error: 'Invalid or expired session' });
        }
        req.authUserId = data.user.id;
        next();
    }
    catch (err) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session' });
    }
}
/**
 * Reject when the claimed userId doesn't match the authenticated user.
 * Responds with the error itself; returns false (and the caller must abort).
 */
function requireOwnership(req, res, claimedUserId) {
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
function requireAdmin(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const serviceKey = config_1.CONFIG.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
        return res.status(503).json({ success: false, error: 'Admin access is not configured' });
    }
    if (token !== serviceKey) {
        return res.status(401).json({ success: false, error: 'Admin authentication required' });
    }
    next();
}
