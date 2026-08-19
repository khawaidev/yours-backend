"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PricingService = exports.FALLBACK_TOKEN_PACKS = void 0;
const config_1 = require("../config");
const FALLBACK_PRICING = {
    US: { region: 'US', country_codes: ['US'], plus_price: 9.99, premium_price: 9.99, premium_annual_price: 79.99, premium_annual_monthly_price: 6.67, premium_save_percent: 33.3, premium_free_months: 1, image_pack_price: 4.99, voice_pack_price: 3.99, currency: 'USD', currency_symbol: '$' },
    CA: { region: 'Canada', country_codes: ['CA'], plus_price: 12.99, premium_price: 12.99, premium_annual_price: 104.99, premium_annual_monthly_price: 8.75, premium_save_percent: 32.7, premium_free_months: 1, image_pack_price: 6.49, voice_pack_price: 4.99, currency: 'CAD', currency_symbol: 'C$' },
    GB: { region: 'UK', country_codes: ['GB', 'UK'], plus_price: 8.99, premium_price: 8.99, premium_annual_price: 71.99, premium_annual_monthly_price: 6.0, premium_save_percent: 33.3, premium_free_months: 1, image_pack_price: 4.49, voice_pack_price: 3.49, currency: 'GBP', currency_symbol: '£' },
    AU: { region: 'Australia', country_codes: ['AU'], plus_price: 14.99, premium_price: 14.99, premium_annual_price: 119.99, premium_annual_monthly_price: 10.0, premium_save_percent: 33.3, premium_free_months: 1, image_pack_price: 7.49, voice_pack_price: 5.99, currency: 'AUD', currency_symbol: 'A$' },
    IN: { region: 'India', country_codes: ['IN'], plus_price: 299.00, premium_price: 399.00, premium_annual_price: 3199.00, premium_annual_monthly_price: 266.00, premium_save_percent: 33.3, premium_free_months: 1, image_pack_price: 199.00, voice_pack_price: 199.00, currency: 'INR', currency_symbol: '₹' },
    BR: { region: 'Brazil', country_codes: ['BR'], plus_price: 29.90, premium_price: 29.90, premium_annual_price: 239.90, premium_annual_monthly_price: 19.99, premium_save_percent: 33.3, premium_free_months: 1, image_pack_price: 14.90, voice_pack_price: 11.90, currency: 'BRL', currency_symbol: 'R$' },
    MX: { region: 'Mexico', country_codes: ['MX'], plus_price: 129.00, premium_price: 129.00, premium_annual_price: 1029.00, premium_annual_monthly_price: 85.75, premium_save_percent: 33.5, premium_free_months: 1, image_pack_price: 69.00, voice_pack_price: 49.00, currency: 'MXN', currency_symbol: 'MX$' },
    PH: { region: 'Philippines', country_codes: ['PH'], plus_price: 299.00, premium_price: 299.00, premium_annual_price: 2399.00, premium_annual_monthly_price: 199.92, premium_save_percent: 33.1, premium_free_months: 1, image_pack_price: 149.00, voice_pack_price: 119.00, currency: 'PHP', currency_symbol: '₱' },
    ID: { region: 'Indonesia', country_codes: ['ID'], plus_price: 99000.00, premium_price: 149000.00, premium_annual_price: 1199000.00, premium_annual_monthly_price: 99916.67, premium_save_percent: 32.9, premium_free_months: 1, image_pack_price: 49000.00, voice_pack_price: 39000.00, currency: 'IDR', currency_symbol: 'Rp' },
    TR: { region: 'Turkey', country_codes: ['TR'], plus_price: 249.00, premium_price: 249.00, premium_annual_price: 1999.00, premium_annual_monthly_price: 166.58, premium_save_percent: 33.1, premium_free_months: 1, image_pack_price: 129.00, voice_pack_price: 99.00, currency: 'TRY', currency_symbol: '₺' },
    ZA: { region: 'South Africa', country_codes: ['ZA'], plus_price: 199.00, premium_price: 199.00, premium_annual_price: 1599.00, premium_annual_monthly_price: 133.25, premium_save_percent: 33.0, premium_free_months: 1, image_pack_price: 99.00, voice_pack_price: 79.00, currency: 'ZAR', currency_symbol: 'R' },
};
exports.FALLBACK_TOKEN_PACKS = [
    { id: 'tokens_250', tokens: 250, usd: 2.49, inr: 99 },
    { id: 'tokens_750', tokens: 750, usd: 5.99, inr: 199 },
    { id: 'tokens_2000', tokens: 2000, usd: 12.99, inr: 499 },
    { id: 'tokens_5000', tokens: 5000, usd: 24.99, inr: 999 },
    { id: 'tokens_12000', tokens: 12000, usd: 49.99, inr: 1999 },
];
// In-memory cache so price cards don't hit Supabase on every render. The cache
// is intentionally short-lived (5 min) and can be force-refreshed by the pay
// button so the checkout always uses the current DB price.
const CACHE_TTL_MS = 5 * 60 * 1000;
let regionsCache = null;
let packsCache = null;
function round2(n) {
    return Math.round(n * 100) / 100;
}
/** Fill any missing derived pricing fields (for DB rows created before the
 *  annual-price columns existed). */
function normalizeRegion(row) {
    const fallback = FALLBACK_PRICING[row.region] || FALLBACK_PRICING['US'];
    const premium = Number(row.premium_price ?? fallback.premium_price ?? 9.99);
    const annual = Number(row.premium_annual_price ?? fallback.premium_annual_price ?? round2(premium * 12));
    const monthlyEquiv = Number(row.premium_annual_monthly_price ?? fallback.premium_annual_monthly_price ?? round2(annual / 12));
    const savePct = Number(row.premium_save_percent ??
        fallback.premium_save_percent ??
        Math.round((1 - annual / (premium * 12)) * 1000) / 10);
    return {
        region: row.region,
        country_codes: Array.isArray(row.country_codes) ? row.country_codes : [row.region],
        plus_price: Number(row.plus_price ?? fallback.plus_price ?? premium),
        premium_price: premium,
        premium_annual_price: annual,
        premium_annual_monthly_price: monthlyEquiv,
        premium_save_percent: savePct,
        premium_free_months: Number(row.premium_free_months ?? fallback.premium_free_months ?? 1),
        image_pack_price: Number(row.image_pack_price ?? fallback.image_pack_price ?? 0),
        voice_pack_price: Number(row.voice_pack_price ?? fallback.voice_pack_price ?? 0),
        currency: row.currency || fallback.currency || 'USD',
        currency_symbol: row.currency_symbol || fallback.currency_symbol || '$',
    };
}
function normalizePack(row) {
    return {
        id: row.id,
        tokens: Number(row.tokens),
        usd: Number(row.usd),
        inr: Number(row.inr),
    };
}
class PricingService {
    /** Drop the in-memory pricing cache so the next read hits the DB. */
    static refresh() {
        regionsCache = null;
        packsCache = null;
    }
    /** All configured regions — DB rows merged with the fallback catalog so no
     *  supported country disappears when the table is partially seeded. */
    static async getAllRegions() {
        const now = Date.now();
        if (regionsCache && now - regionsCache.ts < CACHE_TTL_MS) {
            return regionsCache.regions;
        }
        let dbRegions = [];
        try {
            const { data, error } = await config_1.supabaseAdmin.from('pricing_regions').select('*');
            if (!error && data && data.length > 0) {
                dbRegions = data.map(normalizeRegion);
            }
        }
        catch {
            // fall back below
        }
        const dbKeys = new Set();
        for (const r of dbRegions) {
            dbKeys.add(r.region);
            for (const c of r.country_codes || [])
                dbKeys.add(c);
        }
        const merged = [...dbRegions];
        for (const f of Object.values(FALLBACK_PRICING)) {
            // Skip any fallback region whose region name or country codes are already
            // covered by a DB row (avoids e.g. DB "IN" + fallback "India" duplicates).
            let covered = dbKeys.has(f.region);
            if (!covered) {
                for (const c of f.country_codes || []) {
                    if (dbKeys.has(c)) {
                        covered = true;
                        break;
                    }
                }
            }
            if (!covered)
                merged.push(f);
        }
        regionsCache = { ts: now, regions: merged };
        return merged;
    }
    /** Resolve pricing for a country code (ISO-2). */
    static async getPricingForCountry(countryCode = 'US') {
        const code = (countryCode || 'US').toUpperCase();
        const regions = await PricingService.getAllRegions();
        return regions.find((r) => r.region === code) || FALLBACK_PRICING[code] || FALLBACK_PRICING['US'];
    }
    /** Token top-up packs (DB source of truth, cached). */
    static async getTokenPacks() {
        const now = Date.now();
        if (packsCache && now - packsCache.ts < CACHE_TTL_MS) {
            return packsCache.packs;
        }
        let packs = [];
        try {
            const { data, error } = await config_1.supabaseAdmin
                .from('token_packs')
                .select('id, tokens, usd, inr')
                .eq('is_active', true)
                .order('display_order', { ascending: true });
            if (!error && data && data.length > 0) {
                packs = data.map(normalizePack);
            }
        }
        catch {
            // fall back below
        }
        if (packs.length === 0)
            packs = exports.FALLBACK_TOKEN_PACKS;
        packsCache = { ts: now, packs };
        return packs;
    }
}
exports.PricingService = PricingService;
