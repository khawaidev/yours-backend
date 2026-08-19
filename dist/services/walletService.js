"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletService = void 0;
const config_1 = require("../config");
class WalletService {
    /**
     * Get current balance for user
     */
    static async getBalance(userId) {
        const { data } = await config_1.supabaseAdmin
            .from('wallets')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();
        if (data)
            return data;
        // Create wallet with welcome credits (50 credits)
        const { data: newWallet, error } = await config_1.supabaseAdmin
            .from('wallets')
            .insert({ user_id: userId, credits: 50.0, bonus_credits: 0.0 })
            .select()
            .single();
        if (error)
            throw new Error(`Wallet creation error: ${error.message}`);
        return newWallet;
    }
    /**
     * Deduct or add credits using an atomic ledger transaction
     */
    static async processTransaction(userId, type, amount, // positive for credit addition, negative for deduction
    description, referenceId) {
        const wallet = await this.getBalance(userId);
        const newBalance = wallet.credits + amount;
        if (newBalance < 0) {
            throw new Error('Insufficient wallet credits balance');
        }
        // Update wallet balance
        const { error: walletError } = await config_1.supabaseAdmin
            .from('wallets')
            .update({ credits: newBalance, updated_at: new Date().toISOString() })
            .eq('user_id', userId);
        if (walletError)
            throw new Error(`Wallet balance update failed: ${walletError.message}`);
        // Insert transaction ledger record
        const { data: tx, error: txError } = await config_1.supabaseAdmin
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
        if (txError)
            throw new Error(`Ledger recording failed: ${txError.message}`);
        return { wallet: { ...wallet, credits: newBalance }, transaction: tx };
    }
}
exports.WalletService = WalletService;
