import express from 'express';
import PurchaseReturn from '../models/PurchaseReturn.js';
import Purchase from '../models/Purchase.js';
import Supplier from '../models/Supplier.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';
import { calculateItemGST, calculateTotals } from '../utils/gstCalculations.js';
import { deductBatchStock } from '../utils/inventoryManager.js';
import { postPurchaseReturnToLedger } from '../utils/ledgerHelper.js';

const router = express.Router();

// Apply authentication and tenant isolation to all routes
router.use(protect);
router.use(tenantIsolation);

// @route   GET /api/purchase-returns/stats
// @desc    Get purchase return statistics
// @access  Private
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Calculate first day of current month
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    const orgFilter = addOrgFilter(req);

    const [totalReturns, totalAmount, thisMonth] = await Promise.all([
      PurchaseReturn.countDocuments(orgFilter),
      PurchaseReturn.aggregate([
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
      PurchaseReturn.aggregate([
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
      thisMonth: thisMonth[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/purchase-returns
// @desc    Get all purchase returns
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, supplier } = req.query;
    let query = addOrgFilter(req);

    if (startDate && endDate) {
      query.returnDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    if (supplier) query.supplier = supplier;

    const returns = await PurchaseReturn.find(query)
      .populate('supplier', 'name gstin')
      .populate('originalPurchase', 'purchaseNumber')
      .sort({ createdAt: -1 });

    res.json(returns);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/purchase-returns/:id
// @desc    Get single purchase return
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('supplier')
      .populate('originalPurchase')
      .populate('items.product')
      .populate('items.batch');

    if (!purchaseReturn) {
      return res.status(404).json({ message: 'Purchase return not found' });
    }

    res.json(purchaseReturn);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Valid reason codes (must match PurchaseReturn model enum)
const VALID_PURCHASE_RETURN_REASONS = ['DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'QUALITY_ISSUE', 'EXCESS_STOCK', 'OTHER'];

// @route   POST /api/purchase-returns
// @desc    Create purchase return (Debit Note)
// @access  Private
router.post('/', async (req, res) => {
  let session = null;
  try {
    const { originalPurchase: purchaseId, items, reason, reasonDescription } = req.body;
    const orgId = req.organizationId || req.user.organizationId;

    // BUG-009: Validate reason before any DB writes
    if (!reason || !VALID_PURCHASE_RETURN_REASONS.includes(reason)) {
      return res.status(400).json({
        message: `Invalid return reason. Must be one of: ${VALID_PURCHASE_RETURN_REASONS.join(', ')}`
      });
    }

    // Validate original purchase
    const purchase = await Purchase.findOne(addOrgFilter(req, { _id: purchaseId }))
      .populate('supplier');
    if (!purchase) {
      return res.status(404).json({ message: 'Original purchase not found' });
    }

    // ── Pre-validate all items (no DB writes yet) ─────────────────────────────
    const validatedItems = [];
    for (const item of items) {
      const batchId = item.batch?._id || item.batch;
      const productId = item.product?._id || item.product;

      let originalItem;
      if (batchId) {
        originalItem = purchase.items.find(pi => pi.batch && pi.batch.toString() === batchId.toString());
      } else {
        originalItem = purchase.items.find(pi => pi.product.toString() === productId.toString());
      }
      if (!originalItem) {
        return res.status(400).json({ message: 'Item not found in original purchase' });
      }
      if (item.quantity > originalItem.quantity) {
        return res.status(400).json({ message: `Cannot return more than purchased quantity for item` });
      }

      const itemWithGST = calculateItemGST({
        ...item,
        purchasePrice: originalItem.purchasePrice,
        gstRate: originalItem.gstRate
      }, purchase.taxType, 'purchase');

      validatedItems.push({ item, itemWithGST, originalItem, batchId });
    }

    const processedItems = validatedItems.map(({ itemWithGST, originalItem, batchId }) => ({
      ...itemWithGST,
      product: originalItem.product,
      productName: originalItem.productName,
      batch: batchId || null,
      batchNo: originalItem.batchNo,
      expiryDate: originalItem.expiryDate,
      hsnCode: originalItem.hsnCode,
      unit: originalItem.unit
    }));

    const totals = calculateTotals(processedItems, {}, 0);

    // ── START TRANSACTION ─────────────────────────────────────────────────────
    session = await PurchaseReturn.startSession();
    session.startTransaction();

    // Deduct returned stock from batches
    for (const { item, batchId } of validatedItems) {
      if (batchId) {
        await deductBatchStock(batchId, item.quantity, session);
      }
    }

    // Create purchase return document
    const purchaseReturn = new PurchaseReturn({
      userId: req.user._id,
      organizationId: orgId,
      supplier: purchase.supplier._id,
      supplierName: purchase.supplierName,
      supplierGstin: purchase.supplierGstin,
      originalPurchase: purchase._id,
      originalPurchaseNumber: purchase.purchaseNumber,
      reason,
      reasonDescription,
      items: processedItems,
      taxType: purchase.taxType,
      ...totals
    });
    await purchaseReturn.save({ session });

    // Update original purchase
    purchase.isReturned = true;
    purchase.returnedAmount += totals.grandTotal;
    await purchase.save({ session });

    // Update supplier balance
    if (purchase.supplier?._id) {
      await Supplier.findByIdAndUpdate(purchase.supplier._id, {
        $inc: { currentBalance: -totals.grandTotal, totalReturns: totals.grandTotal }
      }, { session });
    }

    // Post to ledger
    const ledgerEntries = await postPurchaseReturnToLedger(purchaseReturn, req.user._id, orgId, session);
    purchaseReturn.ledgerEntries = ledgerEntries.map(entry => entry._id);
    await purchaseReturn.save({ session });

    await session.commitTransaction();
    res.status(201).json(purchaseReturn);
  } catch (error) {
    if (session) await session.abortTransaction();
    console.error('Purchase return error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) session.endSession();
  }
});

export default router;
