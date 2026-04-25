import { describe, it, expect } from 'vitest';
import {
  calculateGST,
  determineTaxType,
  calculateItemGST,
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
    expect(result.totalTax).toBeCloseTo(180);   // field is totalTax, not taxAmount
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

    expect(result.totalTax).toBe(0);            // field is totalTax
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
});
