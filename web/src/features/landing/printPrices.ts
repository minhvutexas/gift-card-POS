/**
 * Printed (physical) gift card price list — selling prices in USD.
 * Source: Printing_Products.xlsx (sheets "Thẻ Quà Tặng" and "Phiếu Quà Tặng").
 * Every card is 3.375" × 2.125" PVC. Custom cards add a one-time setup fee.
 */
export type Tier = readonly [qty: number, price: number];

export const SETUP_FEE = 35;

export type Thickness = '30' | '35' | '40';
export type Finish = 'plain' | 'foil' | 'shimmer' | 'shimmerFoil' | 'holo' | 'holoFoil';
export const FINISHES: Finish[] = ['plain', 'foil', 'shimmer', 'shimmerFoil', 'holo', 'holoFoil'];

const Q = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 5000] as const;
const tiers = (prices: number[], qtys: readonly number[] = Q): Tier[] => prices.map((p, i) => [qtys[i]!, p] as const);

export const CARD_PRICES: Record<Thickness, Partial<Record<Finish, Tier[]>>> = {
  '30': {
    plain: tiers([103.5, 155.25, 232.88, 388.13, 569.25, 672.75, 931.5, 1138.5, 1242, 1837.13], [50, ...Q]),
  },
  '35': {
    plain: tiers([207, 362.25, 517.5, 724.5, 931.5, 1293.75, 1552.5, 1837.13, 2742.75]),
    foil: tiers([258.75, 414, 569.25, 776.25, 983.25, 1397.25, 1630.13, 1940.63, 2975.63]),
    shimmer: tiers([284.63, 439.88, 595.13, 776.25, 957.38, 1397.25, 1630.13, 1940.63, 2975.63]),
    shimmerFoil: tiers([310.5, 465.75, 621, 802.13, 983.25, 1500.75, 1785.38, 2225.25, 3234.38]),
    holo: tiers([362.25, 491.63, 672.75, 879.75, 1086.75, 1526.63, 1811.25, 2147.63, 3777.75]),
    holoFoil: tiers([414, 595.13, 724.5, 905.63, 1164.38, 1604.25, 1992.38, 2380.5, 4036.5]),
  },
  '40': {
    plain: tiers([232.88, 388.13, 543.38, 750.38, 957.38, 1319.63, 1578.38, 1863, 2768.63]),
    foil: tiers([310.5, 465.75, 595.13, 802.13, 957.38, 1449, 1733.63, 2070, 3130.88]),
    shimmer: tiers([310.5, 465.75, 595.13, 802.13, 957.38, 1449, 1733.63, 2070, 3130.88]),
    shimmerFoil: tiers([388.13, 553.73, 688.28, 879.75, 1086.75, 1526.63, 1837.13, 2147.63, 3182.63]),
    holo: tiers([414, 595.13, 750.38, 983.25, 1164.38, 1604.25, 1992.38, 2380.5, 4010.63]),
    holoFoil: tiers([465.75, 621, 802.13, 1060.88, 1267.88, 1733.63, 2199.38, 2587.5, 4321.13]),
  },
};

/** Ready-printed design (no salon logo), 30 mil. */
export const STOCK_CARDS: Tier[] = [
  [50, 51.75],
  [75, 77.63],
  [100, 103.5],
];

/** Gift certificate 8.5" × 3.75", matte. [qty, no tear-off, with tear-off stub] */
export const CERTIFICATES: readonly (readonly [number, number, number | null])[] = [
  [50, 66.73, null],
  [100, 108.64, null],
  [250, 181.63, null],
  [500, 344.64, 398.31],
  [750, 429.2, null],
  [1000, 490.59, 628.45],
  [1500, 550.3, 741.47],
  [2000, 631.35, 822.2],
  [2500, 705.2, 932.74],
  [5000, 1024.65, 1273.05],
];

/** Envelopes: min 100, only with another product. Price each. */
export const CARD_ENVELOPES: Tier[] = tiers([20.7, 51.75, 103.5, 139.73, 186.3, 248.4, 310.5, 388.13, 517.5]); // 4" × 3"
export const CERT_ENVELOPES = [
  ['plainWhite', 0.15],
  ['bow', 0.2],
  ['plainColor', 0.31],
  ['logoOne', 0.51],
  ['logoBoth', 0.62],
] as const;

export const usd = (n: number, digits = 2) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
