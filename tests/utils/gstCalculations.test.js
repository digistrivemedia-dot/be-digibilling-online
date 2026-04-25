import { describe, it, expect } from 'vitest';
import {
  calculateGST,
  determineTaxType,
  calculateItemGST,
  calculateTotals,
  validateGSTIN,
  getFinancialYear,
} from '../../utils/gstCalculations.js';

// ─── calculateGST ────────────────────────────────────────────────────────────

describe('calculateGST', () => {
  it('splits into CGST+SGST for intra-state', () => {
    const result = calculateGST(1000, 18, 'CGST_SGST');
    expect(result.totalTax).toBe(180);
    expect(result.cgst).toBe(90);
    expect(result.sgst).toBe(90);
    expect(result.igst).toBe(0);
  });

  it('puts full tax into IGST for inter-state', () => {
    const result = calculateGST(1000, 18, 'IGST');
    expect(result.totalTax).toBe(180);
    expect(result.igst).toBe(180);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
  });

  it('returns zero tax for 0% GST rate', () => {
    const result = calculateGST(1000, 0, 'CGST_SGST');
    expect(result.totalTax).toBe(0);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
  });

  it('handles 5% GST correctly', () => {
    const result = calculateGST(1000, 5, 'CGST_SGST');
    expect(result.totalTax).toBe(50);
    expect(result.cgst).toBe(25);
    expect(result.sgst).toBe(25);
  });

  it('handles 28% GST correctly', () => {
    const result = calculateGST(1000, 28, 'IGST');
    expect(result.totalTax).toBe(280);
    expect(result.igst).toBe(280);
  });
});

// ─── determineTaxType ─────────────────────────────────────────────────────────

describe('determineTaxType', () => {
  it('returns CGST_SGST when both states are same', () => {
    expect(determineTaxType('Maharashtra', 'Maharashtra')).toBe('CGST_SGST');
  });

  it('returns IGST when states differ', () => {
    expect(determineTaxType('Maharashtra', 'Delhi')).toBe('IGST');
  });

  it('is case-insensitive', () => {
    expect(determineTaxType('maharashtra', 'MAHARASHTRA')).toBe('CGST_SGST');
  });

  it('returns CGST_SGST when shop state is missing', () => {
    expect(determineTaxType(null, 'Delhi')).toBe('CGST_SGST');
  });

  it('returns CGST_SGST when customer state is missing', () => {
    expect(determineTaxType('Maharashtra', null)).toBe('CGST_SGST');
  });
});

// ─── calculateItemGST ─────────────────────────────────────────────────────────

describe('calculateItemGST', () => {
  it('calculates invoice item with 18% GST, no discount', () => {
    const item = { quantity: 2, sellingPrice: 500, gstRate: 18 };
    const result = calculateItemGST(item, 'CGST_SGST', 'invoice', 'REGULAR');

    expect(result.taxableAmount).toBe(1000);
    expect(result.totalTax).toBeCloseTo(180);
    expect(result.cgst).toBeCloseTo(90);
    expect(result.sgst).toBeCloseTo(90);
    expect(result.totalAmount).toBeCloseTo(1180);
  });

  it('applies item-level absolute discount (₹) before GST', () => {
    // ₹1000 item - ₹100 discount = ₹900 taxable, 18% GST = ₹162 tax
    const item = { quantity: 2, sellingPrice: 500, gstRate: 18, discountAmount: 100 };
    const result = calculateItemGST(item, 'CGST_SGST', 'invoice', 'REGULAR');

    expect(result.taxableAmount).toBe(900);
    expect(result.totalTax).toBeCloseTo(162);
    expect(result.totalAmount).toBeCloseTo(1062);
  });

  it('returns zero tax for Composition scheme', () => {
    const item = { quantity: 1, sellingPrice: 1000, gstRate: 18 };
    const result = calculateItemGST(item, 'CGST_SGST', 'invoice', 'COMPOSITION');

    expect(result.totalTax).toBe(0);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
    expect(result.taxableAmount).toBe(1000);
  });

  it('throws if sellingPrice is missing for invoice context', () => {
    const item = { quantity: 1, gstRate: 18 };
    expect(() => calculateItemGST(item, 'CGST_SGST', 'invoice', 'REGULAR')).toThrow();
  });

  it('throws if purchasePrice is missing for purchase context', () => {
    const item = { quantity: 1, gstRate: 18 };
    expect(() => calculateItemGST(item, 'CGST_SGST', 'purchase', 'REGULAR')).toThrow();
  });

  it('uses IGST instead of CGST+SGST for inter-state', () => {
    const item = { quantity: 1, sellingPrice: 1000, gstRate: 18 };
    const result = calculateItemGST(item, 'IGST', 'invoice', 'REGULAR');

    expect(result.totalTax).toBeCloseTo(180);
    expect(result.igst).toBeCloseTo(180);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
  });

  it('supports old percentage discount field (backward compatibility)', () => {
    // Old invoices stored discount as % not ₹ — item: ₹1000, 10% → taxable ₹900
    const item = { quantity: 2, sellingPrice: 500, gstRate: 18, discount: 10 };
    const result = calculateItemGST(item, 'CGST_SGST', 'invoice', 'REGULAR');

    expect(result.taxableAmount).toBe(900);
    expect(result.totalTax).toBeCloseTo(162, 1);
  });
});

// ─── calculateTotals ─────────────────────────────────────────────────────────
// Called AFTER calculateItemGST has processed each item.
// Expects items that already have: taxableAmount, cgst, sgst, igst, totalTax.

describe('calculateTotals', () => {
  const makeItem = (sellingPrice, quantity, gstRate, taxType = 'CGST_SGST') =>
    calculateItemGST({ sellingPrice, quantity, gstRate }, taxType, 'invoice', 'REGULAR');

  it('sums subtotal and tax across multiple items', () => {
    const items = [
      makeItem(1000, 1, 18),  // ₹1000 taxable, ₹180 tax
      makeItem(500, 2, 5),    // ₹1000 taxable, ₹50 tax
    ];
    const result = calculateTotals(items, {}, 0, 'REGULAR');

    expect(result.subtotal).toBe(2000);
    expect(result.totalTax).toBeCloseTo(230, 1);
    expect(result.grandTotal).toBe(2230);
  });

  it('applies invoice-level discount BEFORE tax recalculation', () => {
    // ₹1000 subtotal, ₹100 discount → ₹900 taxable base, 18% = ₹162 tax, total = ₹1062
    const items = [makeItem(1000, 1, 18)];
    const result = calculateTotals(items, {}, 100, 'REGULAR');

    expect(result.discount).toBe(100);
    expect(result.totalTax).toBeCloseTo(162, 1);
    expect(result.grandTotal).toBe(1062);
  });

  it('adds freight and packaging charges to grand total', () => {
    const items = [makeItem(1000, 1, 18)];
    const charges = { freight: 100, packaging: 50, otherCharges: 25 };
    const result = calculateTotals(items, charges, 0, 'REGULAR');

    expect(result.additionalCharges).toBe(175);
    expect(result.grandTotal).toBe(1180 + 175);
  });

  it('Composition scheme — zero tax on all items', () => {
    const items = [
      calculateItemGST({ sellingPrice: 1000, quantity: 1, gstRate: 18 }, 'CGST_SGST', 'invoice', 'COMPOSITION'),
    ];
    const result = calculateTotals(items, {}, 0, 'COMPOSITION');

    expect(result.totalTax).toBe(0);
    expect(result.grandTotal).toBe(1000);
  });

  it('rounds grandTotal to nearest rupee', () => {
    const items = [makeItem(101, 1, 18)];
    const result = calculateTotals(items, {}, 0, 'REGULAR');

    expect(Number.isInteger(result.grandTotal)).toBe(true);
  });

  it('splits CGST and SGST correctly in totals', () => {
    const items = [makeItem(1000, 1, 18, 'CGST_SGST')];
    const result = calculateTotals(items, {}, 0, 'REGULAR');

    expect(result.totalCGST).toBeCloseTo(90, 1);
    expect(result.totalSGST).toBeCloseTo(90, 1);
    expect(result.totalIGST).toBe(0);
  });

  it('puts all tax into IGST for inter-state', () => {
    const items = [makeItem(1000, 1, 18, 'IGST')];
    const result = calculateTotals(items, {}, 0, 'REGULAR');

    expect(result.totalIGST).toBeCloseTo(180, 1);
    expect(result.totalCGST).toBe(0);
    expect(result.totalSGST).toBe(0);
  });

  it('returns roundOff field (never more than ₹1)', () => {
    const items = [makeItem(101, 1, 18)];
    const result = calculateTotals(items, {}, 0, 'REGULAR');

    expect(result).toHaveProperty('roundOff');
    expect(Math.abs(result.roundOff)).toBeLessThan(1);
  });
});

// ─── validateGSTIN ────────────────────────────────────────────────────────────

describe('validateGSTIN', () => {
  it('accepts a valid GSTIN', () => {
    expect(validateGSTIN('27AAPFU0939F1ZV')).toBe(true);
    expect(validateGSTIN('29GGGGG1314R9Z6')).toBe(true);
  });

  it('rejects null or empty', () => {
    expect(validateGSTIN(null)).toBe(false);
    expect(validateGSTIN('')).toBe(false);
    expect(validateGSTIN(undefined)).toBe(false);
  });

  it('rejects GSTIN that is too short', () => {
    expect(validateGSTIN('27AAPFU0939F1Z')).toBe(false);
  });

  it('rejects GSTIN without Z in 14th position', () => {
    expect(validateGSTIN('27AAPFU0939F1AV')).toBe(false);
  });

  it('rejects GSTIN with lowercase letters', () => {
    expect(validateGSTIN('27aapfu0939f1zv')).toBe(false);
  });
});

// ─── getFinancialYear ─────────────────────────────────────────────────────────

describe('getFinancialYear', () => {
  it('April to March is the same FY', () => {
    expect(getFinancialYear(new Date('2025-04-01'))).toBe('2025-2026');
    expect(getFinancialYear(new Date('2025-12-31'))).toBe('2025-2026');
    expect(getFinancialYear(new Date('2026-03-31'))).toBe('2025-2026');
  });

  it('January to March belongs to the previous FY start year', () => {
    expect(getFinancialYear(new Date('2026-01-15'))).toBe('2025-2026');
    expect(getFinancialYear(new Date('2026-03-31'))).toBe('2025-2026');
  });

  it('April 1 is the first day of a new FY', () => {
    expect(getFinancialYear(new Date('2026-04-01'))).toBe('2026-2027');
  });

  it('returns a valid FY string when called with no argument', () => {
    expect(getFinancialYear()).toMatch(/^\d{4}-\d{4}$/);
  });
});
