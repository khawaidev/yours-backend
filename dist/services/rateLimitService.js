"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkMessagingRateLimit = checkMessagingRateLimit;
exports.messagingRateLimiter = messagingRateLimiter;
const paymentService_1 = require("./paymentService");
/**
 * Server-side rate limiting for messaging-page AI actions (text, image,
 * video/portrait, and audio voice-note requests).
 *
 * Enforced entirely in the backend so users can't bypass it from the browser.
 * Rates are tracked per user in memory using fixed windows:
 *   - Free users:  5 requests / minute,  50 requests / day
 *   - Premium:    10 requests / minute,  unlimited / day under a generous
 *                  fair-usage ceiling (configurable, default 1000 / day)
 *
 * "Messaging action" = any request that makes the AI do work in a chat:
 *   - POST /api/v1/conversations/:id/messages   (text + attached image)
 *   - POST /api/v1/characters/:id/generate-image (video/portrait requests)
 *   - POST /api/v1/characters/:id/generate-voice (audio voice-note requests)
 */
// ---- Config (tune via env if the operator wants) ----
const FREE_MINUTE_LIMIT = Number(process.env.MSG_RATE_FREE_PER_MINUTE ?? 5);
const FREE_DAY_LIMIT = Number(process.env.MSG_RATE_FREE_PER_DAY ?? 50);
const PREMIUM_MINUTE_LIMIT = Number(process.env.MSG_RATE_PREMIUM_PER_MINUTE ?? 10);
// Premium is "unlimited" per day in marketing terms; this is the reasonable
// fair-usage ceiling that stops a single account from running away with the
// infra. It is far above any legitimate daily conversation volume.
const PREMIUM_DAY_FAIR_USE_LIMIT = Number(process.env.MSG_RATE_PREMIUM_DAY_FAIR_USE ?? 1000);
// Subscriber status is cached briefly to avoid hammering Supabase per request.
const PREMIUM_CHECK_TTL_MS = 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** In-memory counters. Key: `${window}:${userId}:${windowStart}` */
const counters = new Map();
/** Per-user premium resolution cache. Key: userId */
const premiumCache = new Map();
/** True when the user has an active subscription (not cancelled, not expired). */
async function isPremiumUser(userId) {
    const cached = premiumCache.get(userId);
    if (cached && cached.expiresAt > Date.now())
        return cached.isPremium;
    let isPremium = false;
    try {
        const sub = await (0, paymentService_1.getSubscription)(userId);
        isPremium =
            !!sub &&
                sub.status === 'active' &&
                !sub.cancel_at_period_end &&
                (!sub.current_period_end || new Date(sub.current_period_end).getTime() > Date.now());
    }
    catch (err) {
        // Fail open to free-tier limits rather than blocking chat during a DB blip.
        console.warn('[rateLimit] premium check failed, treating as free:', err?.message);
    }
    premiumCache.set(userId, { isPremium, expiresAt: Date.now() + PREMIUM_CHECK_TTL_MS });
    return isPremium;
}
function windowStart(now, windowMs) {
    return Math.floor(now / windowMs) * windowMs;
}
function key(tier, userId, start) {
    return `${tier}:${userId}:${start}`;
}
function resetAt(now, windowMs) {
    return windowStart(now, windowMs) + windowMs;
}
/** Throw away buckets from expired windows so memory stays bounded. caches TTL too. */
function sweep(now) {
    const cutoff = now - DAY_MS;
    for (const k of counters.keys()) {
        const start = Number(k.slice(k.lastIndexOf(':') + 1));
        if (start < cutoff)
            counters.delete(k);
    }
    for (const [userId, c] of premiumCache) {
        if (c.expiresAt <= now)
            premiumCache.delete(userId);
    }
}
if (typeof setInterval !== 'undefined') {
    setInterval(() => sweep(Date.now()), 60 * 1000).unref?.();
}
/**
 * Enforce messaging rate limits for a user. Call BEFORE performing the AI work.
 * When `allowed` is false the caller MUST NOT proceed and SHOULD respond 429.
 */
async function checkMessagingRateLimit(userId) {
    const now = Date.now();
    const isPremium = await isPremiumUser(userId);
    const minuteLimit = isPremium ? PREMIUM_MINUTE_LIMIT : FREE_MINUTE_LIMIT;
    const dayLimit = isPremium ? PREMIUM_DAY_FAIR_USE_LIMIT : FREE_DAY_LIMIT;
    const minuteStart = windowStart(now, MINUTE_MS);
    const dayStart = windowStart(now, DAY_MS);
    const minuteKey = key('minute', userId, minuteStart);
    const dayKey = key('day', userId, dayStart);
    const minuteCount = counters.get(minuteKey) || 0;
    const dayCount = counters.get(dayKey) || 0;
    if (dayCount >= dayLimit) {
        return {
            allowed: false,
            status: 429,
            retryAfterSeconds: Math.ceil((resetAt(now, DAY_MS) - now) / 1000),
            limit: dayLimit,
            remaining: 0,
        };
    }
    if (minuteCount >= minuteLimit) {
        return {
            allowed: false,
            status: 429,
            retryAfterSeconds: Math.ceil((resetAt(now, MINUTE_MS) - now) / 1000),
            limit: minuteLimit,
            remaining: 0,
        };
    }
    counters.set(minuteKey, minuteCount + 1);
    counters.set(dayKey, dayCount + 1);
    return {
        allowed: true,
        limit: minuteLimit,
        remaining: minuteLimit - minuteCount - 1,
    };
}
/** Express middleware (factory wrapper) for the messaging AI endpoints. */
function messagingRateLimiter(req, res, next) {
    // Prefer the verified auth user (set by requireAuth) so the limiter can't be
    // bypassed by rotating a client-supplied userId. Falls back to the claimed
    // userId for backwards compatibility when no session is present.
    const userId = req.authUserId ||
        (req.body && req.body.userId) ||
        (typeof req.query.userId === 'string' ? req.query.userId : '');
    // No userId → let the route's own validation handle it (limiter needs an
    // account to rate-limit). Every messaging-page caller sends a userId.
    if (!userId)
        return next();
    checkMessagingRateLimit(userId)
        .then((decision) => {
        if (!decision.allowed) {
            res.setHeader('Retry-After', String(decision.retryAfterSeconds || 60));
            return res.status(decision.status || 429).json({
                success: false,
                error: decision.limit === FREE_DAY_LIMIT || decision.limit === PREMIUM_DAY_FAIR_USE_LIMIT
                    ? 'Daily messaging rate limit reached. Please come back tomorrow — or upgrade to Premium for more.'
                    : 'Rate limit exceeded for messaging. Please wait a moment before sending another message.',
                rateLimit: {
                    limit: decision.limit,
                    remaining: decision.remaining,
                    resetInSeconds: decision.retryAfterSeconds,
                },
            });
        }
        next();
    })
        .catch(() => next());
}
