"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pricingService_1 = require("../services/pricingService");
const router = (0, express_1.Router)();
/** Force a cache refresh when `?fresh=1|true` is present. */
function shouldRefresh(req) {
    const v = req.query.fresh;
    return v === '1' || v === 'true';
}
/**
 * GET /api/v1/pricing/regions
 * Returns pricing for specified country or all supported pricing regions.
 * Prices come from the DB (`pricing_regions`) and are cached in memory for
 * 5 minutes. Pass `?fresh=1` (used by the pay button) to re-read the DB so
 * the checkout always shows/charges the current published price.
 */
router.get('/regions', async (req, res) => {
    try {
        if (shouldRefresh(req))
            pricingService_1.PricingService.refresh();
        const country = req.query.country;
        if (country) {
            const pricing = await pricingService_1.PricingService.getPricingForCountry(country);
            return res.json({ success: true, pricing });
        }
        const regions = await pricingService_1.PricingService.getAllRegions();
        return res.json({ success: true, regions });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/pricing/token-packs
 * Token top-up packs (DB `token_packs`, cached). Supports `?fresh=1`.
 */
router.get('/token-packs', async (req, res) => {
    try {
        if (shouldRefresh(req))
            pricingService_1.PricingService.refresh();
        const packs = await pricingService_1.PricingService.getTokenPacks();
        return res.json({ success: true, packs });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
