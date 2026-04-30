import express from 'express';
import SalesReturn from '../models/SalesReturn.js';
import Invoice from '../models/Invoice.js';
import Customer from '../models/Customer.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';
import { calculateItemGST, calculateTotals } from '../utils/gstCalculations.js';
import { addBatchStock, canRestockBatch } from '../utils/inventoryManager.js';
import { postSalesReturnToLedger } from '../utils/ledgerHelper.js';

const router = express.Router();

// Apply authentication and tenant isolation to all routes
router.use(protect);
router.use(tenantIsolation);

// @route   GET /api/sales-returns/stats
// @desc    Get sales return statistics
// @access  Private
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Calculate first day of current month
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    const orgFilter = addOrgFilter(req);

    const [totalReturns, totalAmount, totalRefunded, thisMonth] = await Promise.all([
      SalesReturn.countDocuments(orgFilter),
      SalesReturn.aggregate([
        {
          $match: orgFilter
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$grandTotal' }
          }
        }
      ]),
      SalesReturn.aggregate([
        {
          $match: {
            ...orgFilter,
            refundStatus: 'COMPLETED'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$refundedAmount' }
          }
        }
      ]),
      SalesReturn.aggregate([
        {
          $match: {
            ...orgFilter,
            returnDate: { $gte: firstDayOfMonth }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$grandTotal' }
          }
        }
      ])
    ]);

    res.json({
      totalReturns,
      totalAmount: totalAmount[0]?.total || 0,
      totalRefunded: totalRefunded[0]?.total || 0,
      thisMonth: thisMonth[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sales-returns
// @desc    Get all sales returns
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, customer } = req.query;
    let query = addOrgFilter(req);

    if (startDate && endDate) {
      query.returnDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    if (customer) query.customer = customer;

    const returns = await SalesReturn.find(query)
      .populate('customer', 'name phone')
      .populate('originalInvoice', 'invoiceNumber')
      .sort({ createdAt: -1 });

    res.json(returns);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sales-returns/:id
// @desc    Get single sales return
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const salesReturn = await SalesReturn.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('customer')
      .populate('originalInvoice')
      .populate('items.product')
      .populate('items.batch');

    if (!salesReturn) {
      return res.status(404).json({ message: 'Sales return not found' });
    }

    res.json(salesReturn);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Valid reason codes (must match SalesReturn model enum)
const VALID_SALES_RETURN_REASONS = ['DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'NOT_NEEDED', 'SIDE_EFFECTS', 'OTHER'];

// @route   POST /api/sales-returns
// @desc    Create sales return (Credit Note)
// @access  Private
router.post('/', async (req, res) => {
  let session = null;
  try {
    const { originalInvoice: invoiceId, items, reason, reasonDescription, refundMethod } = req.body;
    const orgId = req.organizationId || req.user.organizationId;

    // BUG-009: Validate reason before any DB writes
    if (!reason || !VALID_SALES_RETURN_REASONS.includes(reason)) {
      return res.status(400).json({
        message: `Invalid return reason. Must be one of: ${VALID_SALES_RETURN_REASONS.join(', ')}`
      });
    }

    // Validate original invoice
    const invoice = await Invoice.findOne(addOrgFilter(req, { _id: invoiceId }))
      .populate('customer');
    if (!invoice) {
      return res.status(404).json({ message: 'Original invoice not found' });
    }

    // ── Pre-validate items and determine restock eligibility (no DB writes yet) ─
    const validatedItems = [];
    for (const item of items) {
      let originalItem;
      if (item.batch) {
        originalItem = invoice.items.find(ii => ii.batch && ii.batch.toString() === item.batch.toString());
      } else {
        originalItem = invoice.items.find(
          ii => ii.product.toString() === item.product.toString() && (ii.returnedQuantity || 0) < ii.quantity
        );
      }
      if (!originalItem) {
        return res.status(400).json({ message: 'Item not found in original invoice' });
      }

      const alreadyReturned = originalItem.returnedQuantity || 0;
      if (item.quantity > (originalItem.quantity - alreadyReturned)) {
        return res.status(400).json({ message: `Cannot return more than sold quantity for item` });
      }

      const itemWithGST = calculateItemGST({
        ...item,
        sellingPrice: originalItem.sellingPrice,
        gstRate: originalItem.gstRate
      }, invoice.taxType, 'invoice');

      // Determine restock eligibility — check now, apply inside transaction
      let canRestock = false;
      if (item.batch) {
        canRestock = await canRestockBatch(item.batch);
      }
      const shouldRestock = canRestock && reason !== 'EXPIRED' && reason !== 'DAMAGED';

      validatedItems.push({ item, itemWithGST, originalItem, alreadyReturned, canRestock, shouldRestock });
    }

    const processedItems = validatedItems.map(({ item, itemWithGST, originalItem, canRestock, shouldRestock }) => ({
      ...itemWithGST,
      product: originalItem.product,
      productName: originalItem.productName,
      batch: item.batch || null,
      batchNo: originalItem.batchNo || item.batchNo,
      expiryDate: originalItem.expiryDate,
      hsnCode: originalItem.hsnCode,
      unit: originalItem.unit,
      canRestock,
      restocked: shouldRestock
    }));

    const totals = calculateTotals(processedItems, {}, 0);

    // ── START TRANSACTION ─────────────────────────────────────────────────────
    session = await SalesReturn.startSession();
    session.startTransaction();

    // Restock eligible batches
    for (const { item, shouldRestock } of validatedItems) {
      if (shouldRestock && item.batch) {
        await addBatchStock(item.batch, item.quantity, session);
      }
    }

    // Create sales return document
    const salesReturn = new SalesReturn({
      userId: req.user._id,
      organizationId: orgId,
      customer: invoice.customer?._id,
      customerName: invoice.customerName,
      customerPhone: invoice.customerPhone,
      customerGstin: invoice.customerGstin,
      originalInvoice: invoice._id,
      originalInvoiceNumber: invoice.invoiceNumber,
      reason,
      reasonDescription,
      refundMethod,
      refundStatus: refundMethod ? 'COMPLETED' : 'PENDING',
      refundedAmount: refundMethod ? totals.grandTotal : 0,
      items: processedItems,
      taxType: invoice.taxType,
      ...totals
    });
    await salesReturn.save({ session });

    // Update original invoice returned quantities and flags
    for (const { originalItem, item, alreadyReturned } of validatedItems) {
      originalItem.returnedQuantity = alreadyReturned + item.quantity;
    }
    const allItemsFullyReturned = invoice.items.every(ii => (ii.returnedQuantity || 0) >= ii.quantity);
    invoice.isReturned = allItemsFullyReturned;
    invoice.partiallyReturned = !allItemsFullyReturned && invoice.items.some(ii => (ii.returnedQuantity || 0) > 0);
    invoice.returnedAmount += totals.grandTotal;
    await invoice.save({ session });

    // Update customer balance
    if (invoice.customer?._id) {
      await Customer.findByIdAndUpdate(invoice.customer._id, {
        $inc: { outstandingBalance: -totals.grandTotal }
      }, { session });
    }

    // Post to ledger
    const ledgerEntries = await postSalesReturnToLedger(salesReturn, req.user._id, orgId, session);
    salesReturn.ledgerEntries = ledgerEntries.map(entry => entry._id);
    await salesReturn.save({ session });

    await session.commitTransaction();
    res.status(201).json(salesReturn);
  } catch (error) {
    if (session) await session.abortTransaction();
    console.error('Sales return error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) session.endSession();
  }
});

// @route   PUT /api/sales-returns/:id/refund
// @desc    Update refund status
// @access  Private
router.put('/:id/refund', async (req, res) => {
  try {
    const { refundMethod, refundedAmount } = req.body;

    const salesReturn = await SalesReturn.findOne(addOrgFilter(req, { _id: req.params.id }));

    if (!salesReturn) {
      return res.status(404).json({ message: 'Sales return not found' });
    }

    salesReturn.refundMethod = refundMethod;
    salesReturn.refundedAmount = refundedAmount || salesReturn.grandTotal;
    salesReturn.refundStatus = 'COMPLETED';

    await salesReturn.save();

    res.json(salesReturn);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
