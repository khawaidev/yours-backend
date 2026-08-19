"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREMIUM_PLANS = exports.TOKEN_PACKS = void 0;
exports.isRazorpayConfigured = isRazorpayConfigured;
exports.createPaymentOrder = createPaymentOrder;
exports.verifyPaymentSignature = verifyPaymentSignature;
exports.confirmPayment = confirmPayment;
exports.getSubscription = getSubscription;
const crypto_1 = __importDefault(require("crypto"));
const razorpay_1 = __importDefault(require("razorpay"));
const config_1 = require("../config");
const walletService_1 = require("./walletService");
const pricingService_1 = require("./pricingService");
// Token packs sold on the recharge page (hard fallback; DB `token_packs` wins).
exports.TOKEN_PACKS = [
    { id: 'tokens_250', tokens: 250, usd: 2.49, inr: 99 },
    { id: 'tokens_750', tokens: 750, usd: 5.99, inr: 199 },
    { id: 'tokens_2000', tokens: 2000, usd: 12.99, inr: 499 },
    { id: 'tokens_5000', tokens: 5000, usd: 24.99, inr: 999 },
    { id: 'tokens_12000', tokens: 12000, usd: 49.99, inr: 1999 },
];
// Premium subscription plans (hard fallback; DB `pricing_regions` wins).
exports.PREMIUM_PLANS = [
    { id: 'premium_monthly', period: 'monthly', usd: 9.99, inr: 399, months: 1 },
    { id: 'premium_annual', period: 'annual', usd: 79.99, inr: 3199, months: 12 },
];
function getRazorpay() {
    return new razorpay_1.default({
        key_id: config_1.CONFIG.RAZORPAY.KEY_ID,
        key_secret: config_1.CONFIG.RAZORPAY.KEY_SECRET,
    });
}
function isRazorpayConfigured() {
    return Boolean(config_1.CONFIG.RAZORPAY.KEY_ID && config_1.CONFIG.RAZORPAY.KEY_SECRET);
}
/** Price in the smallest currency unit (paise / cents). */
function toSmallestUnit(amount) {
    return Math.round(amount * 100);
}
/**
 * Create a Razorpay order for a token pack or premium plan.
 *
 * @param userId          The purchasing user
 * @param itemId          'tokens_5000', 'premium_annual', etc.
 * @param countryCode     ISO-2 country (IN → INR, else USD)
 * @param receiptId       Optional client-supplied receipt string
 */
async function createPaymentOrder(userId, itemId, countryCode = 'US', receiptId) {
    if (!isRazorpayConfigured()) {
        throw new Error('Razorpay is not configured');
    }
    const country = (countryCode || 'US').toUpperCase();
    const currency = country === 'IN' ? 'INR' : 'USD';
    const packs = await pricingService_1.PricingService.getTokenPacks();
    const pack = packs.find((p) => p.id === itemId) || exports.TOKEN_PACKS.find((p) => p.id === itemId);
    const plan = exports.PREMIUM_PLANS.find((p) => p.id === itemId);
    let amount;
    let itemType;
    let description;
    if (pack) {
        amount = currency === 'INR' ? pack.inr : pack.usd;
        itemType = 'tokens';
        description = `${pack.tokens} Love Tokens`;
    }
    else if (plan) {
        // Resolve the premium price from the DB regional pricing (cached), so the
        // charged amount always matches the current published price.
        let premiumAmount;
        try {
            const region = await pricingService_1.PricingService.getPricingForCountry(country);
            premiumAmount =
                plan.period === 'annual'
                    ? region.premium_annual_price
                    : region.premium_price;
        }
        catch {
            premiumAmount = undefined;
        }
        amount =
            premiumAmount ??
                (currency === 'INR' ? plan.inr : plan.usd);
        itemType = 'premium';
        description =
            plan.period === 'annual' ? 'Premium (Annual)' : 'Premium (Monthly)';
    }
    else {
        throw new Error('Unknown item');
    }
    const order = await getRazorpay().orders.create({
        amount: toSmallestUnit(amount),
        currency,
        receipt: receiptId || `rcpt_${Date.now()}`,
        notes: {
            userId,
            itemId,
            itemType,
            country,
        },
    });
    return {
        orderId: order.id,
        amount,
        amountInSmallestUnit: toSmallestUnit(amount),
        currency,
        itemType,
        itemId,
        description,
        keyId: config_1.CONFIG.RAZORPAY.KEY_ID,
    };
}
/**
 * Verify a Razorpay payment signature.
 * Standard implementation: HMAC-SHA256(order_id|payment_id, key_secret) base64.
 */
function verifyPaymentSignature(orderId, paymentId, signature) {
    if (!orderId || !paymentId || !signature)
        return false;
    const body = `${orderId}|${paymentId}`;
    const expected = crypto_1.default
        .createHmac('sha256', config_1.CONFIG.RAZORPAY.KEY_SECRET)
        .update(body)
        .digest('hex');
    const received = Buffer.from(signature, 'base64').toString('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}
/**
 * Confirm a paid order and apply the purchase:
 * - Token pack  → credits the user's wallet
 * - Premium plan → upserts an active subscription
 */
async function confirmPayment(userId, orderId, paymentId, signature, itemId) {
    if (!verifyPaymentSignature(orderId, paymentId, signature)) {
        throw new Error('Invalid payment signature');
    }
    // Idempotency: skip if this payment was already applied.
    const { data: existing } = await config_1.supabaseAdmin
        .from('wallet_transactions')
        .select('id')
        .eq('reference_type', 'razorpay_payment')
        .eq('reference_id', paymentId)
        .maybeSingle();
    if (existing) {
        return { success: true, alreadyApplied: true };
    }
    const packs = await pricingService_1.PricingService.getTokenPacks();
    const pack = packs.find((p) => p.id === itemId) || exports.TOKEN_PACKS.find((p) => p.id === itemId);
    const plan = exports.PREMIUM_PLANS.find((p) => p.id === itemId);
    if (pack) {
        const result = await walletService_1.WalletService.processTransaction(userId, 'purchase', pack.tokens, `${pack.tokens} Love Tokens`, paymentId);
        // Tag the ledger entry as a razorpay purchase.
        await config_1.supabaseAdmin
            .from('wallet_transactions')
            .update({ reference_type: 'razorpay_payment' })
            .eq('id', result.transaction.id);
        return { success: true, wallet: result.wallet };
    }
    if (plan) {
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + plan.months);
        const { data: sub, error: subError } = await config_1.supabaseAdmin
            .from('subscriptions')
            .upsert({
            user_id: userId,
            plan_type: plan.id,
            status: 'active',
            current_period_start: now.toISOString(),
            current_period_end: periodEnd.toISOString(),
            cancel_at_period_end: false,
            updated_at: now.toISOString(),
        }, { onConflict: 'user_id' })
            .select()
            .single();
        if (subError)
            throw new Error(`Subscription update failed: ${subError.message}`);
        // Record a ledger entry for the premium purchase.
        const result = await walletService_1.WalletService.processTransaction(userId, 'purchase', 0, `Premium (${plan.period})`, paymentId);
        await config_1.supabaseAdmin
            .from('wallet_transactions')
            .update({ reference_type: 'razorpay_payment' })
            .eq('id', result.transaction.id);
        return { success: true, subscription: sub };
    }
    throw new Error('Unknown item');
}
/**
 * Fetch the current subscription for a user (if any).
 */
async function getSubscription(userId) {
    const { data } = await config_1.supabaseAdmin
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || null;
}
