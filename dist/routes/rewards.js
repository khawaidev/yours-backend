"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const walletService_1 = require("../services/walletService");
const paymentService_1 = require("../services/paymentService");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Love-token reward for each consecutive day of a 7-day login streak.
const DAY_REWARDS = [25, 25, 25, 50, 50, 75, 100];
function todayStr(d = new Date()) {
    return d.toISOString().slice(0, 10);
}
function yesterdayStr(d = new Date()) {
    return new Date(d.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
async function getRecord(userId) {
    const { data } = await config_1.supabaseAdmin
        .from('daily_rewards')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
    return data || null;
}
/**
 * GET /api/v1/rewards/daily?userId=...
 * Current daily login-reward state.
 *  - canClaim:     today's reward is still available
 *  - claimedToday: already claimed today
 *  - cycleDay:     1..7 — day associated with today's claim, or the next
 *                  claimable day (1 if the streak is fresh or the cycle reset)
 *  - claimedCount: days already claimed in the current 7-day cycle (0..7)
 *  - streak:       total consecutive claimed days
 *  - rewards:      the 7 reward amounts (index 0 = day 1)
 */
router.get('/daily', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = String(req.query.userId || '');
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId query param required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const rec = await getRecord(userId);
        const today = todayStr();
        let streak = rec ? rec.streak : 0;
        let claimedToday = !!(rec && rec.last_claim_date === today);
        let consecutive = !!(rec && rec.last_claim_date === yesterdayStr());
        if (claimedToday) {
            // They already claimed today: streak includes today.
        }
        else if (consecutive) {
            // Streak continues; next claim is streak+1.
        }
        else {
            // Broken streak or never claimed: next claim restarts at day 1.
            streak = 0;
        }
        let cycleDay;
        let claimedCount;
        if (claimedToday) {
            cycleDay = ((streak - 1) % 7) + 1;
            claimedCount = cycleDay;
        }
        else {
            cycleDay = (streak % 7) + 1;
            claimedCount = cycleDay - 1;
        }
        return res.json({
            success: true,
            reward: {
                canClaim: !claimedToday,
                claimedToday,
                cycleDay,
                claimedCount,
                streak,
                rewards: DAY_REWARDS,
            },
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/rewards/daily/claim
 * Claim today's daily login reward. Credits the wallet and auto-advances the
 * 7-day streak. Only one claim per user per calendar day.
 */
router.post('/daily/claim', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        // Premium (2x reward) is decided server-side from the user's subscription.
        // A client-supplied `pro` flag is never trusted.
        let pro = false;
        try {
            const sub = await (0, paymentService_1.getSubscription)(userId);
            pro =
                !!sub &&
                    sub.status === 'active' &&
                    !sub.cancel_at_period_end &&
                    (!sub.current_period_end || new Date(sub.current_period_end).getTime() > Date.now());
        }
        catch (err) {
            console.warn('[rewards] premium check failed, using standard reward:', err?.message);
        }
        const rec = await getRecord(userId);
        const today = todayStr();
        if (rec && rec.last_claim_date === today) {
            return res.status(400).json({ success: false, error: 'Daily reward already claimed today' });
        }
        const consecutive = !!(rec && rec.last_claim_date === yesterdayStr());
        const streak = consecutive ? (rec.streak + 1) : 1;
        const day = ((streak - 1) % 7) + 1;
        const amount = DAY_REWARDS[day - 1] * (pro ? 2 : 1);
        const { error: recErr } = await config_1.supabaseAdmin.from('daily_rewards').upsert({
            user_id: userId,
            streak,
            last_claim_date: today,
            updated_at: new Date().toISOString(),
        });
        if (recErr)
            throw new Error(recErr.message);
        const result = await walletService_1.WalletService.processTransaction(userId, 'reward', amount, pro ? `Daily login reward (2x PRO) — Day ${day}` : `Daily login reward — Day ${day}`, `daily-reward-${today}`);
        return res.json({
            success: true,
            claimed: { day, amount, streak, pro: !!pro },
            wallet: result.wallet,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
