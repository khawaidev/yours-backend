"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const walletService_1 = require("../services/walletService");
const config_1 = require("../config");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * GET /api/v1/wallet
 * Get wallet balance and transaction ledger history
 */
router.get('/', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const wallet = await walletService_1.WalletService.getBalance(userId);
        const { data: transactions } = await config_1.supabaseAdmin
            .from('wallet_transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(20);
        return res.json({ success: true, wallet, transactions: transactions || [] });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/wallet/transaction
 * Process credit transaction.
 * ADMIN ONLY: the bearer token must be the service-role key. This endpoint can
 * mint credits, so regular users must never be able to call it.
 */
router.post('/transaction', auth_1.requireAdmin, async (req, res) => {
    try {
        const { userId, type, amount, description, referenceId } = req.body;
        if (!userId || !type || amount === undefined) {
            return res.status(400).json({ success: false, error: 'userId, type, and amount required' });
        }
        const result = await walletService_1.WalletService.processTransaction(userId, type, amount, description, referenceId);
        return res.json({ success: true, ...result });
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/wallet/spend
 * Deduct credits (gifts, image generation, etc.) using the atomic ledger.
 * Fails when the user does not have enough credits.
 */
router.post('/spend', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, amount, description, type } = req.body;
        const cost = Number(amount);
        if (!userId || !Number.isFinite(cost) || cost <= 0) {
            return res.status(400).json({ success: false, error: 'userId and a positive amount are required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const ledgerType = (type || 'gift');
        const result = await walletService_1.WalletService.processTransaction(userId, ledgerType, -cost, description || `${ledgerType} spend`);
        return res.json({ success: true, ...result });
    }
    catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});
exports.default = router;
