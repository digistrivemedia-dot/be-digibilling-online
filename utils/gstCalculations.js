// GST Calculation Utilities

/**
 * Calculate GST amounts based on taxable amount and GST rate
 * @param {Number} taxableAmount - Amount before tax
 * @param {Number} gstRate - GST rate (0, 5, 12, 18, 28)
 * @param {String} taxType - 'CGST_SGST' or 'IGST'
 * @returns {Object} - { cgst, sgst, igst, totalTax }
 */
export const calculateGST = (taxableAmount, gstRate, taxType) => {
  const totalTax = (taxableAmount * gstRate) / 100;

  if (taxType === 'CGST_SGST') {
    return {
      cgst: totalTax / 2,
      sgst: totalTax / 2,
      igst: 0,
      totalTax
    };
  } else {
    return {
      cgst: 0,
      sgst: 0,
      igst: totalTax,
      totalTax
    };
  }
};

/**
 * Determine tax type based on supplier/customer state
 * @param {String} shopState - Shop's state from settings
 * @param {String} partyState - Customer/Supplier state
 * @returns {String} - 'CGST_SGST' or 'IGST'
 */
export const determineTaxType = (shopState, partyState) => {
  if (!shopState || !partyState || shopState.trim().toUpperCase() === partyState.trim().toUpperCase()) {
    return 'CGST_SGST';
  }
  return 'IGST';
};

/**
 * Calculate item-level GST for invoice/purchase items
 * @param {Object} item - { quantity, sellingPrice/purchasePrice, discountAmount, gstRate }
 * @param {String} taxType - 'CGST_SGST' or 'IGST'
 * @param {String} context - 'purchase' or 'invoice' (optional, defaults to 'invoice')
 * @param {String} gstScheme - 'REGULAR' or 'COMPOSITION' (optional, defaults to 'REGULAR')
 * @returns {Object} - Complete item with tax calculations
 */
export const calculateItemGST = (item, taxType, context = 'invoice', gstScheme = 'REGULAR') => {
  const { quantity, sellingPrice, purchasePrice, discountAmount = 0, discount = 0, gstRate } = item;

  // For purchases, ONLY use purchasePrice
  // For invoices (sales), ONLY use sellingPrice (throw error if missing)
  let price;
  if (context === 'purchase') {
    price = purchasePrice;
    if (!price || price <= 0) {
      throw new Error('Purchase price is required for purchase transactions');
    }
  } else {
    // For invoices, sellingPrice is MANDATORY - no fallback to purchasePrice
    price = sellingPrice;
    if (!price || price <= 0) {
      throw new Error('Selling price is required for invoice transactions');
    }
  }

  // Calculate taxable amount
  const itemTotal = price * quantity;

  // NEW: Support both discountAmount (₹) and old discount (%)
  // Priority: discountAmount (absolute ₹) > discount (percentage for backward compatibility)
  let finalDiscountAmount;
  if (discountAmount > 0) {
    // New way: absolute discount amount in rupees
    finalDiscountAmount = discountAmount;
  } else if (discount > 0) {
    // Old way: percentage discount (for backward compatibility with old invoices)
    finalDiscountAmount = (itemTotal * discount) / 100;
  } else {
    finalDiscountAmount = 0;
  }

  const taxableAmount = itemTotal - finalDiscountAmount;

  // If Composition scheme, skip GST calculation
  if (gstScheme === 'COMPOSITION') {
    return {
      ...item,
      discountAmount: finalDiscountAmount,
      taxableAmount,
      cgst: 0,
      sgst: 0,
      igst: 0,
      totalTax: 0,
      totalAmount: taxableAmount
    };
  }

  // Calculate GST (Regular scheme)
  const gst = calculateGST(taxableAmount, gstRate, taxType);

  return {
    ...item,
    discountAmount: finalDiscountAmount,
    taxableAmount,
    ...gst,
    totalAmount: taxableAmount + gst.totalTax
  };
};

/**
 * Calculate total amounts for invoice/purchase
 * @param {Array} items - Array of items with GST calculated
 * @param {Object} additionalCharges - { freight, packaging, otherCharges }
 * @param {Number} discount - Overall discount (applied BEFORE GST)
 * @param {String} gstScheme - 'REGULAR' or 'COMPOSITION' (optional, defaults to 'REGULAR')
 * @returns {Object} - { subtotal, totalTax, totalCGST, totalSGST, totalIGST, grandTotal }
 */
export const calculateTotals = (items, additionalCharges = {}, discount = 0, gstScheme = 'REGULAR') => {
  const subtotal = items.reduce((sum, item) => sum + item.taxableAmount, 0);

  // Apply discount BEFORE GST calculation
  const subtotalAfterDiscount = subtotal - discount;

  // Calculate discount ratio for proportional distribution
  const discountRatio = subtotal > 0 ? subtotalAfterDiscount / subtotal : 1;

  // If Composition scheme, no tax
  let totalTax = 0;
  let totalCGST = 0;
  let totalSGST = 0;
  let totalIGST = 0;

  if (gstScheme !== 'COMPOSITION') {
    // Recalculate tax on discounted amounts proportionally
    items.forEach(item => {
      const itemAfterDiscount = item.taxableAmount * discountRatio;
      const itemTax = item.totalTax * discountRatio;

      totalTax += itemTax;
      totalCGST += (item.cgst || 0) * discountRatio;
      totalSGST += (item.sgst || 0) * discountRatio;
      totalIGST += (item.igst || 0) * discountRatio;
    });
  }

  const { freight = 0, packaging = 0, otherCharges = 0 } = additionalCharges;
  const additionalTotal = freight + packaging + otherCharges;

  const grandTotal = subtotalAfterDiscount + totalTax + additionalTotal;
  const roundOff = Math.round(grandTotal) - grandTotal;

  return {
    subtotal,
    totalTax,
    totalCGST,
    totalSGST,
    totalIGST,
    discount,
    additionalCharges: additionalTotal,
    roundOff,
    grandTotal: Math.round(grandTotal)
  };
};

// ⚠️  UNUSED FUNCTION — not imported anywhere in the codebase (verified April 2026)
// TODO: Either use this somewhere or delete it.
/**
 * Reverse calculate price from MRP including GST
 * @param {Number} mrp - Maximum Retail Price (including GST)
 * @param {Number} gstRate - GST rate
 * @returns {Number} - Price before GST
 */
export const reverseCalculateGST = (mrp, gstRate) => {
  return mrp / (1 + gstRate / 100);
};

/**
 * Validate GSTIN format
 * @param {String} gstin - GSTIN number
 * @returns {Boolean}
 */
export const validateGSTIN = (gstin) => {
  if (!gstin) return false;
  const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  return gstinRegex.test(gstin);
};

// ⚠️  UNUSED FUNCTION — not imported anywhere in the codebase (verified April 2026)
// TODO: Either use this somewhere or delete it.
/**
 * Extract state code from GSTIN
 * @param {String} gstin - GSTIN number
 * @returns {String} - State code (first 2 digits)
 */
export const getStateCodeFromGSTIN = (gstin) => {
  if (!gstin || gstin.length < 2) return null;
  return gstin.substring(0, 2);
};

/**
 * Get financial year from date
 * @param {Date} date
 * @returns {String} - Format: "2024-2025"
 */
export const getFinancialYear = (date = new Date()) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;

  if (month >= 4) {
    return `${year}-${year + 1}`;
  }
  return `${year - 1}-${year}`;
};

// ⚠️  UNUSED FUNCTION — not imported anywhere in the codebase (verified April 2026)
// TODO: Either use this somewhere or delete it.
/**
 * Get financial year date range
 * @param {String} fy - Financial year string "2024-2025"
 * @returns {Object} - { startDate, endDate }
 */
export const getFinancialYearRange = (fy) => {
  const [startYear] = fy.split('-').map(Number);
  return {
    startDate: new Date(startYear, 3, 1), // April 1
    endDate: new Date(startYear + 1, 2, 31) // March 31
  };
};

// ⚠️  UNUSED FUNCTION — not imported anywhere in the codebase (verified April 2026)
// TODO: Either wire this into invoice PDF templates or delete it.
//       Note: the function had a bug (amount vs num reassignment) that was fixed
//       during testing even though it was never called — if you use it, it now works correctly.
/**
 * Convert number to words (for invoice)
 * @param {Number} amount
 * @returns {String}
 */
export const amountToWords = (amount) => {
  if (amount === 0) return 'Zero Rupees Only';

  // Includes teens so we never need a separate teens array
  const ones = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen'
  ];
  const tensWords = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  // Inner helper — converts 1-999 to word parts ONLY (no "Rupees Only" suffix).
  // The outer function is the only one that adds "Rupees Only".
  const toWords = (n) => {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tensWords[Math.floor(n / 10)] + ' ' + (ones[n % 10] ? ones[n % 10] + ' ' : '');
    return ones[Math.floor(n / 100)] + ' Hundred ' + toWords(n % 100);
  };

  let num = Math.floor(amount);
  const paise = Math.round((amount - num) * 100);
  let words = '';

  if (num >= 10000000) {
    words += toWords(Math.floor(num / 10000000)) + 'Crore ';
    num = num % 10000000;
  }
  if (num >= 100000) {
    words += toWords(Math.floor(num / 100000)) + 'Lakh ';
    num = num % 100000;
  }
  if (num >= 1000) {
    words += toWords(Math.floor(num / 1000)) + 'Thousand ';
    num = num % 1000;
  }
  if (num > 0) {
    words += toWords(num);
  }

  words = words.trim() + ' Rupees';

  if (paise > 0) {
    words += ' and ' + toWords(paise).trim() + ' Paise';
  }

  return words.trim() + ' Only';
};

export default {
  calculateGST,
  determineTaxType,
  calculateItemGST,
  calculateTotals,
  reverseCalculateGST,
  validateGSTIN,
  getStateCodeFromGSTIN,
  getFinancialYear,
  getFinancialYearRange,
  amountToWords
};
