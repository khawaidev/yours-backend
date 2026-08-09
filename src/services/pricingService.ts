import { supabaseAdmin } from '../config';

export interface RegionalPricing {
  region: string;
  country_codes: string[];
  plus_price: number;
  premium_price: number;
  image_pack_price: number;
  voice_pack_price: number;
  currency: string;
  currency_symbol: string;
}

const FALLBACK_PRICING: Record<string, RegionalPricing> = {
  US: { region: 'US', country_codes: ['US'], plus_price: 9.99, premium_price: 19.99, image_pack_price: 4.99, voice_pack_price: 3.99, currency: 'USD', currency_symbol: '$' },
  CA: { region: 'Canada', country_codes: ['CA'], plus_price: 12.99, premium_price: 25.99, image_pack_price: 6.49, voice_pack_price: 4.99, currency: 'CAD', currency_symbol: 'C$' },
  GB: { region: 'UK', country_codes: ['GB', 'UK'], plus_price: 8.99, premium_price: 17.99, image_pack_price: 4.49, voice_pack_price: 3.49, currency: 'GBP', currency_symbol: '£' },
  AU: { region: 'Australia', country_codes: ['AU'], plus_price: 14.99, premium_price: 29.99, image_pack_price: 7.49, voice_pack_price: 5.99, currency: 'AUD', currency_symbol: 'A$' },
  IN: { region: 'India', country_codes: ['IN'], plus_price: 499.00, premium_price: 999.00, image_pack_price: 249.00, voice_pack_price: 199.00, currency: 'INR', currency_symbol: '₹' },
  BR: { region: 'Brazil', country_codes: ['BR'], plus_price: 29.90, premium_price: 59.90, image_pack_price: 14.90, voice_pack_price: 11.90, currency: 'BRL', currency_symbol: 'R$' },
  MX: { region: 'Mexico', country_codes: ['MX'], plus_price: 129.00, premium_price: 249.00, image_pack_price: 69.00, voice_pack_price: 49.00, currency: 'MXN', currency_symbol: 'MX$' },
  PH: { region: 'Philippines', country_codes: ['PH'], plus_price: 299.00, premium_price: 599.00, image_pack_price: 149.00, voice_pack_price: 119.00, currency: 'PHP', currency_symbol: '₱' },
  ID: { region: 'Indonesia', country_codes: ['ID'], plus_price: 99000.00, premium_price: 199000.00, image_pack_price: 49000.00, voice_pack_price: 39000.00, currency: 'IDR', currency_symbol: 'Rp' },
  TR: { region: 'Turkey', country_codes: ['TR'], plus_price: 249.00, premium_price: 499.00, image_pack_price: 129.00, voice_pack_price: 99.00, currency: 'TRY', currency_symbol: '₺' },
  ZA: { region: 'South Africa', country_codes: ['ZA'], plus_price: 199.00, premium_price: 399.00, image_pack_price: 99.00, voice_pack_price: 79.00, currency: 'ZAR', currency_symbol: 'R' },
};

export class PricingService {
  /**
   * Fetch all configured pricing regions from DB or fallback memory
   */
  static async getAllRegions(): Promise<RegionalPricing[]> {
    try {
      const { data, error } = await supabaseAdmin.from('pricing_regions').select('*');
      if (error || !data || data.length === 0) {
        return Object.values(FALLBACK_PRICING);
      }
      return data;
    } catch {
      return Object.values(FALLBACK_PRICING);
    }
  }

  /**
   * Resolve specific pricing for user's country code
   */
  static async getPricingForCountry(countryCode: string = 'US'): Promise<RegionalPricing> {
    const code = countryCode.toUpperCase();
    try {
      const { data } = await supabaseAdmin
        .from('pricing_regions')
        .select('*')
        .contains('country_codes', [code])
        .single();
      
      if (data) return data;
    } catch {
      // ignore db error, use fallback
    }

    return FALLBACK_PRICING[code] || FALLBACK_PRICING['US'];
  }
}
