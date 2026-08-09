import { Router } from 'express';
import { WalletService } from '../services/walletService';
import { supabaseAdmin } from '../config';

const router = Router();

/**
 * GET /api/v1/wallet
 * Get wallet balance and transaction ledger history
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const wallet = await WalletService.getBalance(userId);
    const { data: transactions } = await supabaseAdmin
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    return res.json({ success: true, wallet, transactions: transactions || [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/wallet/transaction
 * Process credit transaction
 */
router.post('/transaction', async (req, res) => {
  try {
    const { userId, type, amount, description, referenceId } = req.body;
    if (!userId || !type || amount === undefined) {
      return res.status(400).json({ success: false, error: 'userId, type, and amount required' });
    }

    const result = await WalletService.processTransaction(userId, type, amount, description, referenceId);
    return res.json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
