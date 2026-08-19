"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const paymentService_1 = require("../services/paymentService");
const pricingService_1 = require("../services/pricingService");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * GET /api/v1/payments/catalog
 * Returns the token packs + premium plans and whether Razorpay is configured.
 * Token pack prices come from the DB (`token_packs`, cached); pass `?fresh=1`
 * to bypass the cache. Driving the client's purchase sheet.
 */
router.get('/catalog', async (req, res) => {
    try {
        if (req.query.fresh === '1' || req.query.fresh === 'true') {
            pricingService_1.PricingService.refresh();
        }
        const tokenPacks = await pricingService_1.PricingService.getTokenPacks();
        return res.json({
            success: true,
            configured: (0, paymentService_1.isRazorpayConfigured)(),
            tokenPacks,
            premiumPlans: paymentService_1.PREMIUM_PLANS,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/payments/subscription?userId=...
 * Fetch the user's current premium subscription.
 */
router.get('/subscription', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const subscription = await (0, paymentService_1.getSubscription)(userId);
        return res.json({ success: true, subscription });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/payments/order
 * Create a Razorpay order for a token pack or premium plan.
 * Body: { userId, itemId, country? }
 */
router.post('/order', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, itemId, country, receipt } = req.body;
        if (!userId || !itemId) {
            return res.status(400).json({ success: false, error: 'userId and itemId required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const order = await (0, paymentService_1.createPaymentOrder)(userId, itemId, country, receipt);
        return res.json({ success: true, order });
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/payments/verify
 * Verify the Razorpay payment signature and apply the purchase.
 * Body: { userId, orderId, paymentId, signature, itemId }
 */
router.post('/verify', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, orderId, paymentId, signature, itemId } = req.body;
        if (!userId || !orderId || !paymentId || !signature || !itemId) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const result = await (0, paymentService_1.confirmPayment)(userId, orderId, paymentId, signature, itemId);
        return res.json(result);
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});
exports.default = router;
