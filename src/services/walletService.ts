import { supabaseAdmin } from '../config';

export class WalletService {
  /**
   * Get current balance for user
   */
  static async getBalance(userId: string) {
    const { data } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (data) return data;

    // Create wallet with welcome credits (100 credits)
    const { data: newWallet, error } = await supabaseAdmin
      .from('wallets')
      .insert({ user_id: userId, credits: 100.0, bonus_credits: 0.0 })
      .select()
      .single();

    if (error) throw new Error(`Wallet creation error: ${error.message}`);
    return newWallet;
  }

  /**
   * Deduct or add credits using an atomic ledger transaction
   */
  static async processTransaction(
    userId: string,
    type: 'purchase' | 'reward' | 'image_generation' | 'gift' | 'refund',
    amount: number, // positive for credit addition, negative for deduction
    description?: string,
    referenceId?: string
  ) {
    const wallet = await this.getBalance(userId);
    const newBalance = wallet.credits + amount;

    if (newBalance < 0) {
      throw new Error('Insufficient wallet credits balance');
    }

    // Update wallet balance
    const { error: walletError } = await supabaseAdmin
      .from('wallets')
      .update({ credits: newBalance, updated_at: new Date().toISOString() })
      .eq('user_id', userId);

    if (walletError) throw new Error(`Wallet balance update failed: ${walletError.message}`);

    // Insert transaction ledger record
    const { data: tx, error: txError } = await supabaseAdmin
      .from('wallet_transactions')
      .insert({
        user_id: userId,
        type,
        amount,
        balance_after: newBalance,
        description: description || `${type} transaction`,
        reference_id: referenceId || null,
      })
      .select()
      .single();

    if (txError) throw new Error(`Ledger recording failed: ${txError.message}`);
    return { wallet: { ...wallet, credits: newBalance }, transaction: tx };
  }
}
