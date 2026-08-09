import { Router } from 'express';
import { PricingService } from '../services/pricingService';

const router = Router();

/**
 * GET /api/v1/pricing/regions
 * Returns pricing for specified country or all supported pricing regions
 */
router.get('/regions', async (req, res) => {
  try {
    const country = req.query.country as string;
    if (country) {
      const pricing = await PricingService.getPricingForCountry(country);
      return res.json({ success: true, pricing });
    }

    const regions = await PricingService.getAllRegions();
    return res.json({ success: true, regions });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
