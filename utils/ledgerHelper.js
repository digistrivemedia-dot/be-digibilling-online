import Ledger from '../models/Ledger.js';
import { getFinancialYear } from './gstCalculations.js';

/**
 * Post purchase entry to ledger (Double Entry)
 * @param {Object} purchase - Purchase document
 * @param {String} userId
 * @returns {Array} - Created ledger entries
 */
export const postPurchaseToLedger = async (purchase, userId, organizationId, session = null) => {
  const entries = [];
  const fy = getFinancialYear(purchase.purchaseDate);

  // Debit: Purchases Account
  entries.push({
    account: 'PURCHASES',
    type: 'DEBIT',
    amount: purchase.subtotal,
    party: 'SUPPLIER',
    partyId: purchase.supplier,
    partyModel: 'Supplier',
    partyName: purchase.supplierName,
    description: `Purchase from ${purchase.supplierName} - ${purchase.purchaseNumber}`
  });

  // Debit: GST Input Tax Credit
  if (purchase.taxType === 'CGST_SGST') {
    entries.push({
      account: 'GST_INPUT_CGST',
      type: 'DEBIT',
      amount: purchase.totalCGST,
      party: 'SUPPLIER',
      partyId: purchase.supplier,
      partyModel: 'Supplier',
      partyName: purchase.supplierName,
      description: `CGST on ${purchase.purchaseNumber}`
    });

    entries.push({
      account: 'GST_INPUT_SGST',
      type: 'DEBIT',
      amount: purchase.totalSGST,
      party: 'SUPPLIER',
      partyId: purchase.supplier,
      partyModel: 'Supplier',
      partyName: purchase.supplierName,
      description: `SGST on ${purchase.purchaseNumber}`
    });
  } else {
    entries.push({
      account: 'GST_INPUT_IGST',
      type: 'DEBIT',
      amount: purchase.totalIGST,
      party: 'SUPPLIER',
      partyId: purchase.supplier,
      partyModel: 'Supplier',
      partyName: purchase.supplierName,
      description: `IGST on ${purchase.purchaseNumber}`
    });
  }

  // Credit: Accounts Payable (if unpaid) or Cash/Bank (if paid) or both (if partial)
  if (purchase.paymentStatus === 'PAID') {
    // Fully paid - credit cash/bank
    const account = purchase.paymentMethod === 'CASH' ? 'CASH' : 'BANK';
    entries.push({
      account,
      type: 'CREDIT',
      amount: purchase.grandTotal,
      party: 'SUPPLIER',
      partyId: purchase.supplier,
      partyModel: 'Supplier',
      partyName: purchase.supplierName,
      description: `Payment for ${purchase.purchaseNumber} via ${purchase.paymentMethod}`
    });
  } else if (purchase.paymentStatus === 'PARTIAL') {
    // Partial payment - credit both cash/bank (for paid) and accounts payable (for balance)
    const account = purchase.paymentMethod === 'CASH' ? 'CASH' : 'BANK';

    // Credit cash/bank for paid amount
    if (purchase.paidAmount > 0) {
      entries.push({
        account,
        type: 'CREDIT',
        amount: purchase.paidAmount,
        party: 'SUPPLIER',
        partyId: purchase.supplier,
        partyModel: 'Supplier',
        partyName: purchase.supplierName,
        description: `Partial payment for ${purchase.purchaseNumber} via ${purchase.paymentMethod}`
      });
    }

    // Credit accounts payable for balance amount
    if (purchase.balanceAmount > 0) {
      entries.push({
        account: 'ACCOUNTS_PAYABLE',
        type: 'CREDIT',
        amount: purchase.balanceAmount,
        party: 'SUPPLIER',
        partyId: purchase.supplier,
        partyModel: 'Supplier',
        partyName: purchase.supplierName,
        description: `Balance due for ${purchase.purchaseNumber}`
      });
    }
  } else {
    // Unpaid - credit accounts payable
    entries.push({
      account: 'ACCOUNTS_PAYABLE',
      type: 'CREDIT',
      amount: purchase.grandTotal,
      party: 'SUPPLIER',
      partyId: purchase.supplier,
      partyModel: 'Supplier',
      partyName: purchase.supplierName,
      description: `Purchase on credit - ${purchase.purchaseNumber}`
    });
  }

  return await Ledger.createDoubleEntry(organizationId, userId, entries, {
    referenceType: 'PURCHASE',
    referenceId: purchase._id,
    referenceModel: 'Purchase',
    referenceNumber: purchase.purchaseNumber,
    description: `Purchase Entry - ${purchase.purchaseNumber}`,
    date: purchase.purchaseDate,
    financialYear: fy
  }, session);
};

/**
 * Post sales/invoice entry to ledger (Double Entry)
 * @param {Object} invoice - Invoice document
 * @param {String} userId
 * @param {String} organizationId
 * @returns {Array} - Created ledger entries
 */
export const postSalesToLedger = async (invoice, userId, organizationId, session = null) => {
  const entries = [];
  const fy = getFinancialYear(invoice.invoiceDate);

  // Debit: Cash/Bank/Accounts Receivable
  if (invoice.paymentStatus === 'PAID') {
    const account = invoice.paymentMethod === 'CASH' ? 'CASH' : 'BANK';
    entries.push({
      account,
      type: 'DEBIT',
      amount: invoice.grandTotal,
      party: 'CUSTOMER',
      partyId: invoice.customer,
      partyModel: 'Customer',
      partyName: invoice.customerName,
      description: `Payment received for ${invoice.invoiceNumber} via ${invoice.paymentMethod}`
    });
  } else {
    entries.push({
      account: 'ACCOUNTS_RECEIVABLE',
      type: 'DEBIT',
      amount: invoice.grandTotal,
      party: 'CUSTOMER',
      partyId: invoice.customer,
      partyModel: 'Customer',
      partyName: invoice.customerName,
      description: `Sale on credit - ${invoice.invoiceNumber}`
    });
  }

  // Credit: Sales Account
  entries.push({
    account: 'SALES',
    type: 'CREDIT',
    amount: invoice.subtotal,
    party: 'CUSTOMER',
    partyId: invoice.customer,
    partyModel: 'Customer',
    partyName: invoice.customerName,
    description: `Sale to ${invoice.customerName} - ${invoice.invoiceNumber}`
  });

  // Credit: GST Output Tax
  if (invoice.taxType === 'CGST_SGST') {
    entries.push({
      account: 'GST_PAYABLE_CGST',
      type: 'CREDIT',
      amount: invoice.totalCGST,
      party: 'CUSTOMER',
      partyId: invoice.customer,
      partyModel: 'Customer',
      partyName: invoice.customerName,
      description: `CGST on ${invoice.invoiceNumber}`
    });

    entries.push({
      account: 'GST_PAYABLE_SGST',
      type: 'CREDIT',
      amount: invoice.totalSGST,
      party: 'CUSTOMER',
      partyId: invoice.customer,
      partyModel: 'Customer',
      partyName: invoice.customerName,
      description: `SGST on ${invoice.invoiceNumber}`
    });
  } else {
    entries.push({
      account: 'GST_PAYABLE_IGST',
      type: 'CREDIT',
      amount: invoice.totalIGST,
      party: 'CUSTOMER',
      partyId: invoice.customer,
      partyModel: 'Customer',
      partyName: invoice.customerName,
      description: `IGST on ${invoice.invoiceNumber}`
    });
  }

  // For COGS tracking
  if (invoice.cogs && invoice.cogs > 0) {
    // Debit: Cost of Goods Sold
    entries.push({
      account: 'COST_OF_GOODS_SOLD',
      type: 'DEBIT',
      amount: invoice.cogs,
      party: 'SELF',
      description: `COGS for ${invoice.invoiceNumber}`
    });

    // Credit: Inventory
    entries.push({
      account: 'INVENTORY',
      type: 'CREDIT',
      amount: invoice.cogs,
      party: 'SELF',
      description: `Inventory reduction for ${invoice.invoiceNumber}`
    });
  }

  return await Ledger.createDoubleEntry(organizationId, userId, entries, {
    referenceType: 'INVOICE',
    referenceId: invoice._id,
    referenceModel: 'Invoice',
    referenceNumber: invoice.invoiceNumber,
    description: `Sales Entry - ${invoice.invoiceNumber}`,
    date: invoice.invoiceDate,
    financialYear: fy
  }, session);
};

/**
 * Post expense entry to ledger
 * @param {Object} expense - Expense document
 * @param {String} userId
 * @param {String} organizationId
 * @returns {Array} - Created ledger entries
 */
export const postExpenseToLedger = async (expense, userId, organizationId) => {
  const entries = [];
  const fy = getFinancialYear(expense.date);

  // Map expense category to account
  const expenseAccountMap = {
    'RENT': 'RENT_EXPENSE',
    'SALARY': 'SALARY_EXPENSE',
    'ELECTRICITY': 'ELECTRICITY_EXPENSE',
    'WATER': 'WATER_EXPENSE',
    'INTERNET': 'INTERNET_EXPENSE',
    'TELEPHONE': 'TELEPHONE_EXPENSE',
    'MAINTENANCE': 'MAINTENANCE_EXPENSE',
    'STATIONERY': 'STATIONERY_EXPENSE',
    'TRANSPORT': 'TRANSPORT_EXPENSE',
    'FUEL': 'FUEL_EXPENSE',
    'INSURANCE': 'INSURANCE_EXPENSE',
    'LICENSE_FEES': 'LICENSE_FEES_EXPENSE',
    'PROFESSIONAL_FEES': 'PROFESSIONAL_FEES_EXPENSE',
    'BANK_CHARGES': 'BANK_CHARGES',
    'REPAIRS': 'REPAIRS_EXPENSE',
    'ADVERTISING': 'ADVERTISING_EXPENSE',
    'MISCELLANEOUS': 'MISCELLANEOUS_EXPENSE'
  };

  const expenseAccount = expenseAccountMap[expense.category] || 'MISCELLANEOUS_EXPENSE';

  // Debit: Expense Account
  entries.push({
    account: expenseAccount,
    type: 'DEBIT',
    amount: expense.amount,
    party: 'OTHER',
    partyName: expense.paidTo,
    description: `${expense.category} - ${expense.description}`
  });

  // If GST applicable, debit GST Input
  if (expense.isGSTApplicable && expense.gstAmount > 0) {
    if (expense.cgst > 0) {
      entries.push({
        account: 'GST_INPUT_CGST',
        type: 'DEBIT',
        amount: expense.cgst,
        party: 'OTHER',
        partyName: expense.paidTo,
        description: `CGST on ${expense.description}`
      });

      entries.push({
        account: 'GST_INPUT_SGST',
        type: 'DEBIT',
        amount: expense.sgst,
        party: 'OTHER',
        partyName: expense.paidTo,
        description: `SGST on ${expense.description}`
      });
    } else if (expense.igst > 0) {
      entries.push({
        account: 'GST_INPUT_IGST',
        type: 'DEBIT',
        amount: expense.igst,
        party: 'OTHER',
        partyName: expense.paidTo,
        description: `IGST on ${expense.description}`
      });
    }
  }

  // Credit: Cash/Bank
  const paymentAccount = expense.paymentMethod === 'CASH' ? 'CASH' : 'BANK';
  entries.push({
    account: paymentAccount,
    type: 'CREDIT',
    amount: expense.totalAmount,
    party: 'OTHER',
    partyName: expense.paidTo,
    description: `Payment for ${expense.description} via ${expense.paymentMethod}`
  });

  return await Ledger.createDoubleEntry(organizationId, userId, entries, {
    referenceType: 'EXPENSE',
    referenceId: expense._id,
    referenceModel: 'Expense',
    referenceNumber: expense.expenseNumber,
    description: `Expense Entry - ${expense.description}`,
    date: expense.date,
    financialYear: fy
  });
};

/**
 * Post payment entry to ledger
 * @param {Object} payment - Payment document
 * @param {String} userId
 * @param {String} organizationId
 * @returns {Array} - Created ledger entries
 */
export const postPaymentToLedger = async (payment, userId, organizationId, session = null) => {
  const entries = [];
  const fy = getFinancialYear(payment.date);

  const paymentAccount = payment.paymentMethod === 'CASH' ? 'CASH' : 'BANK';

  if (payment.type === 'RECEIVED') {
    // Money received from customer
    entries.push({
      account: paymentAccount,
      type: 'DEBIT',
      amount: payment.amount,
      party: 'CUSTOMER',
      partyId: payment.party,
      partyModel: 'Customer',
      partyName: payment.partyName,
      description: `Payment received from ${payment.partyName}`
    });

    entries.push({
      account: 'ACCOUNTS_RECEIVABLE',
      type: 'CREDIT',
      amount: payment.amount,
      party: 'CUSTOMER',
      partyId: payment.party,
      partyModel: 'Customer',
      partyName: payment.partyName,
      description: `Settlement for ${payment.partyName}`
    });
  } else {
    // Money paid to supplier
    entries.push({
      account: 'ACCOUNTS_PAYABLE',
      type: 'DEBIT',
      amount: payment.amount,
      party: 'SUPPLIER',
      partyId: payment.party,
      partyModel: 'Supplier',
      partyName: payment.partyName,
      description: `Payment to ${payment.partyName}`
    });

    entries.push({
      account: paymentAccount,
      type: 'CREDIT',
      amount: payment.amount,
      party: 'SUPPLIER',
      partyId: payment.party,
      partyModel: 'Supplier',
      partyName: payment.partyName,
      description: `Payment made to ${payment.partyName}`
    });
  }

  return await Ledger.createDoubleEntry(organizationId, userId, entries, {
    referenceType: 'PAYMENT',
    referenceId: payment._id,
    referenceModel: 'Payment',
    referenceNumber: payment.paymentNumber,
    description: `Payment Entry - ${payment.paymentNumber}`,
    date: payment.date,
    financialYear: fy
  }, session);
};

/**
 * Post purchase return to ledger
 * @param {Object} purchaseReturn - PurchaseReturn document
 * @param {String} userId
 * @param {String} organizationId
 * @returns {Array} - Created ledger entries
 */
export const postPurchaseReturnToLedger = async (purchaseReturn, userId, organizationId, session = null) => {
  const entries = [];
  const fy = getFinancialYear(purchaseReturn.returnDate);

  // Credit: Purchases Return Account
  entries.push({
    account: 'PURCHASE_RETURN',
    type: 'CREDIT',
    amount: purchaseReturn.subtotal,
    party: 'SUPPLIER',
    partyId: purchaseReturn.supplier,
    partyModel: 'Supplier',
    partyName: purchaseReturn.supplierName,
    description: `Purchase return to ${purchaseReturn.supplierName} - ${purchaseReturn.debitNoteNumber}`
  });

  // Credit: GST Input reversal
  if (purchaseReturn.taxType === 'CGST_SGST') {
    entries.push({
      account: 'GST_INPUT_CGST',
      type: 'CREDIT',
      amount: purchaseReturn.totalCGST,
      party: 'SUPPLIER',
      partyId: purchaseReturn.supplier,
      partyModel: 'Supplier',
      partyName: purchaseReturn.supplierName,
      description: `CGST reversal on ${purchaseReturn.debitNoteNumber}`
    });

    entries.push({
      account: 'GST_INPUT_SGST',
      type: 'CREDIT',
      amount: purchaseReturn.totalSGST,
      party: 'SUPPLIER',
      partyId: purchaseReturn.supplier,
      partyModel: 'Supplier',
      partyName: purchaseReturn.supplierName,
      description: `SGST reversal on ${purchaseReturn.debitNoteNumber}`
    });
  } else {
    entries.push({
      account: 'GST_INPUT_IGST',
      type: 'CREDIT',
      amount: purchaseReturn.totalIGST,
      party: 'SUPPLIER',
      partyId: purchaseReturn.supplier,
      partyModel: 'Supplier',
      partyName: purchaseReturn.supplierName,
      description: `IGST reversal on ${purchaseReturn.debitNoteNumber}`
    });
  }

  // Debit: Accounts Payable
  entries.push({
    account: 'ACCOUNTS_PAYABLE',
    type: 'DEBIT',
    amount: purchaseReturn.grandTotal,
    party: 'SUPPLIER',
    partyId: purchaseReturn.supplier,
    partyModel: 'Supplier',
    partyName: purchaseReturn.supplierName,
    description: `Debit note - ${purchaseReturn.debitNoteNumber}`
  });

  return await Ledger.createDoubleEntry(organizationId, userId, entries, {
    referenceType: 'PURCHASE_RETURN',
    referenceId: purchaseReturn._id,
    referenceModel: 'PurchaseReturn',
    referenceNumber: purchaseReturn.debitNoteNumber,
    description: `Purchase Return - ${purchaseReturn.debitNoteNumber}`,
    date: purchaseReturn.returnDate,
    financialYear: fy
  }, session);
};

/**
 * Post sales return to ledger
 * @param {Object} salesReturn - SalesReturn document
 * @param {String} userId
 * @returns {Array} - Created ledger entries
 */
export const postSalesReturnToLedger = async (salesReturn, userId, organizationId, session = null) => {
  const entries = [];
  const fy = getFinancialYear(salesReturn.returnDate);

  // Debit: Sales Return Account
  entries.push({
    account: 'SALES_RETURN',
    type: 'DEBIT',
    amount: salesReturn.subtotal,
    party: 'CUSTOMER',
    partyId: salesReturn.customer,
    partyModel: 'Customer',
    partyName: salesReturn.customerName,
    description: `Sales return from ${salesReturn.customerName} - ${salesReturn.creditNoteNumber}`
  });

  // Debit: GST Output reversal
  if (salesReturn.taxType === 'CGST_SGST') {
    entries.push({
      account: 'GST_PAYABLE_CGST',
      type: 'DEBIT',
      amount: salesReturn.totalCGST,
      party: 'CUSTOMER',
      partyId: salesReturn.customer,
      partyModel: 'Customer',
      partyName: salesReturn.customerName,
      description: `CGST reversal on ${salesReturn.creditNoteNumber}`
    });

    entries.push({
      account: 'GST_PAYABLE_SGST',
      type: 'DEBIT',
      amount: salesReturn.totalSGST,
      party: 'CUSTOMER',
      partyId: salesReturn.customer,
      partyModel: 'Customer',
      partyName: salesReturn.customerName,
      description: `SGST reversal on ${salesReturn.creditNoteNumber}`
    });
  } else {
    entries.push({
      account: 'GST_PAYABLE_IGST',
      type: 'DEBIT',
      amount: salesReturn.totalIGST,
      party: 'CUSTOMER',
      partyId: salesReturn.customer,
      partyModel: 'Customer',
      partyName: salesReturn.customerName,
      description: `IGST reversal on ${salesReturn.creditNoteNumber}`
    });
  }

  // Credit: Accounts Receivable or Cash/Bank
  if (salesReturn.refundStatus === 'COMPLETED') {
    const account = salesReturn.refundMethod === 'CASH' ? 'CASH' : 'BANK';
    entries.push({
      account,
      type: 'CREDIT',
      amount: salesReturn.grandTotal,
      party: 'CUSTOMER',
      partyId: salesReturn.customer,
      partyModel: 'Customer',
      partyName: salesReturn.customerName,
      description: `Refund for ${salesReturn.creditNoteNumber} via ${salesReturn.refundMethod}`
    });
  } else {
    entries.push({
      account: 'ACCOUNTS_RECEIVABLE',
      type: 'CREDIT',
      amount: salesReturn.grandTotal,
      party: 'CUSTOMER',
      partyId: salesReturn.customer,
      partyModel: 'Customer',
      partyName: salesReturn.customerName,
      description: `Credit note - ${salesReturn.creditNoteNumber}`
    });
  }

  return await Ledger.createDoubleEntry(organizationId, userId, entries, {
    referenceType: 'SALES_RETURN',
    referenceId: salesReturn._id,
    referenceModel: 'SalesReturn',
    referenceNumber: salesReturn.creditNoteNumber,
    description: `Sales Return - ${salesReturn.creditNoteNumber}`,
    date: salesReturn.returnDate,
    financialYear: fy
  }, session);
};

/**
 * Get account balance
 * @param {String} userId
 * @param {String} account - Account name
 * @param {Date} asOnDate - Optional date
 * @returns {Number} - Balance (positive for debit balance, negative for credit balance)
 */
export const getAccountBalance = async (userId, account, asOnDate = new Date()) => {
  const query = {
    userId,
    account,
    date: { $lte: asOnDate }
  };

  const entries = await Ledger.find(query);

  let balance = 0;
  entries.forEach(entry => {
    if (entry.type === 'DEBIT') {
      balance += entry.amount;
    } else {
      balance -= entry.amount;
    }
  });

  return balance;
};

/**
 * Get party ledger (customer or supplier)
 * @param {String} userId
 * @param {String} partyType - 'CUSTOMER' or 'SUPPLIER'
 * @param {String} partyId
 * @param {Object} dateRange - { startDate, endDate }
 * @returns {Array} - Ledger entries
 */
export const getPartyLedger = async (userId, partyType, partyId, dateRange = {}) => {
  const query = {
    userId,
    party: partyType,
    partyId
  };

  if (dateRange.startDate) query.date = { $gte: dateRange.startDate };
  if (dateRange.endDate) query.date = { ...query.date, $lte: dateRange.endDate };

  return await Ledger.find(query).sort({ date: 1, createdAt: 1 });
};

export default {
  postPurchaseToLedger,
  postSalesToLedger,
  postExpenseToLedger,
  postPaymentToLedger,
  postPurchaseReturnToLedger,
  postSalesReturnToLedger,
  getAccountBalance,
  getPartyLedger
};
