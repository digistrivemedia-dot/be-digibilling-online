import express from 'express';
import Purchase from '../models/Purchase.js';
import Supplier from '../models/Supplier.js';
import Product from '../models/Product.js';
import ShopSettings from '../models/ShopSettings.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';
import { calculateItemGST, calculateTotals, determineTaxType } from '../utils/gstCalculations.js';
import { findOrCreateBatchForPurchase } from '../utils/inventoryManager.js';
import { postPurchaseToLedger } from '../utils/ledgerHelper.js';

const router = express.Router();

// Apply authentication and tenant isolation to all routes
router.use(protect);
router.use(tenantIsolation);

// @route   GET /api/purchases
// @desc    Get all purchases
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, supplier, paymentStatus } = req.query;
    let query = addOrgFilter(req);

    if (startDate && endDate) {
      query.purchaseDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    if (supplier) query.supplier = supplier;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    const purchases = await Purchase.find(query)
      .populate('supplier', 'name gstin phone')
      .sort({ createdAt: -1 });

    res.json(purchases);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/purchases/stats
// @desc    Get purchase statistics
// @access  Private
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Calculate first day of current month
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    const orgFilter = addOrgFilter(req);

    const [todayPurchases, totalPending, purchaseCount, thisMonth, totalAmount] = await Promise.all([
      Purchase.aggregate([
        {
          $match: {
            ...orgFilter,
            purchaseDate: { $gte: today }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$grandTotal' }
          }
        }
      ]),
      Purchase.aggregate([
        {
          $match: {
            ...orgFilter,
            paymentStatus: { $in: ['UNPAID', 'PARTIAL'] }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$balanceAmount' }
          }
        }
      ]),
      Purchase.countDocuments(orgFilter),
      Purchase.aggregate([
        {
          $match: {
            ...orgFilter,
            purchaseDate: { $gte: firstDayOfMonth }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$grandTotal' }
          }
        }
      ]),
      Purchase.aggregate([
        {
          $match: orgFilter
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
      todayPurchases: todayPurchases[0]?.total || 0,
      totalPending: totalPending[0]?.total || 0,
      totalPurchases: purchaseCount,
      thisMonth: thisMonth[0]?.total || 0,
      totalAmount: totalAmount[0]?.total || 0,
      pendingPayment: totalPending[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/purchases/:id
// @desc    Get single purchase
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const purchase = await Purchase.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('supplier')
      .populate('items.product')
      .populate('items.batch');

    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    res.json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/purchases
// @desc    Create purchase entry
// @access  Private
router.post('/', async (req, res) => {
  let session = null;
  try {
    const { supplier: supplierId, items, ...purchaseData } = req.body;
    const orgId = req.organizationId || req.user.organizationId;

    // ── Validate supplier ──────────────────────────────────────────────────────
    if (!supplierId || supplierId === '') {
      return res.status(400).json({ message: 'Please select a supplier' });
    }
    const supplier = await Supplier.findOne(addOrgFilter(req, { _id: supplierId }));
    if (!supplier) {
      return res.status(404).json({ message: 'Supplier not found' });
    }

    // ── Validate items ────────────────────────────────────────────────────────
    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Please add at least one item to the purchase' });
    }

    // ── Pre-validate all items and compute GST (no DB writes yet) ────────────
    const shopSettings = await ShopSettings.findOne(addOrgFilter(req));
    const taxType = determineTaxType(shopSettings?.state, supplier.state);

    const itemsWithGST = [];
    const zeroPriceWarnings = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.product || item.product === '') {
        return res.status(400).json({ message: `Please select a product for item #${i + 1}` });
      }
      if (!item.quantity || item.quantity <= 0) {
        return res.status(400).json({ message: `Please enter a valid quantity for item #${i + 1}` });
      }
      const product = await Product.findOne(addOrgFilter(req, { _id: item.product }));
      if (!product) {
        return res.status(400).json({ message: `Product not found for item #${i + 1}. Please select a valid product.` });
      }
      // BUG-018: Warn if purchasePrice is 0 (COGS will be 0, P&L profit may be overstated)
      if (!item.purchasePrice || item.purchasePrice <= 0) {
        zeroPriceWarnings.push(`Item #${i + 1} (${product.name}): purchase price is 0 — COGS will not be tracked for this item.`);
      }
      const itemWithGST = calculateItemGST({ ...item, purchasePrice: item.purchasePrice }, taxType, 'purchase');
      itemsWithGST.push({ item, itemWithGST, product });
    }

    // ── Calculate totals ───────────────────────────────────────────────────────
    const preProcessed = itemsWithGST.map(({ itemWithGST }) => itemWithGST);
    const totals = calculateTotals(preProcessed, {
      freight: purchaseData.freight || 0,
      packaging: purchaseData.packaging || 0,
      otherCharges: purchaseData.otherCharges || 0
    }, purchaseData.discount || 0);

    const paidAmount = purchaseData.paidAmount || 0;
    const balanceAmount = totals.grandTotal - paidAmount;
    const paymentStatus = balanceAmount <= 0 ? 'PAID' : (paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    // ── START TRANSACTION — all DB writes below are atomic ───────────────────
    session = await Purchase.startSession();
    session.startTransaction();

    const Batch = (await import('../models/Batch.js')).default;

    // Create/update batches inside transaction
    const processedItems = [];
    for (const { item, itemWithGST, product } of itemsWithGST) {
      const batch = await findOrCreateBatchForPurchase(
        { ...item, ...itemWithGST },
        req.user._id,
        orgId,
        supplierId,
        null, // purchaseId set after Purchase.create
        session
      );
      processedItems.push({
        ...itemWithGST,
        product: product._id,
        productName: product.name,
        batch: batch._id,
        batchNo: batch.batchNo,
        expiryDate: batch.expiryDate,
        hsnCode: product.hsnCode || item.hsnCode,
        unit: product.unit
      });
    }

    // Create purchase document
    const purchase = new Purchase({
      userId: req.user._id,
      organizationId: orgId,
      supplier: supplier._id,
      supplierName: supplier.name,
      supplierGstin: supplier.gstin,
      supplierInvoiceNo: purchaseData.billNumber,
      supplierInvoiceDate: purchaseData.billDate,
      purchaseDate: purchaseData.purchaseDate,
      dueDate: purchaseData.dueDate,
      freight: purchaseData.freightCharges || purchaseData.freight || 0,
      packaging: purchaseData.packagingCharges || purchaseData.packaging || 0,
      otherCharges: purchaseData.otherCharges || 0,
      discount: purchaseData.discount || 0,
      paymentMethod: purchaseData.paymentMode || purchaseData.paymentMethod,
      paymentTerms: purchaseData.paymentTerms,
      notes: purchaseData.notes,
      items: processedItems,
      taxType,
      ...totals,
      paymentStatus,
      paidAmount,
      balanceAmount
    });
    await purchase.save({ session });

    // Link batches back to this purchase
    for (const item of processedItems) {
      await Batch.findByIdAndUpdate(item.batch, { purchaseInvoice: purchase._id }, { session });
    }

    // Update supplier totals
    await Supplier.findByIdAndUpdate(supplier._id, {
      $inc: { currentBalance: balanceAmount, totalPurchases: totals.grandTotal }
    }, { session });

    // Post to ledger
    const ledgerEntries = await postPurchaseToLedger(purchase, req.user._id, orgId, session);
    purchase.ledgerEntries = ledgerEntries.map(entry => entry._id);

    // Initial payment ledger entries
    if (paidAmount > 0) {
      const Ledger = (await import('../models/Ledger.js')).default;
      const paymentLedgerEntries = await Ledger.createDoubleEntry(orgId, req.user._id, [
        {
          account: 'ACCOUNTS_PAYABLE',
          type: 'DEBIT',
          amount: paidAmount,
          party: 'SUPPLIER',
          partyId: supplier._id,
          partyModel: 'Supplier',
          partyName: supplier.name,
          description: `Initial payment for ${purchase.purchaseNumber}`
        },
        {
          account: purchaseData.paymentMethod === 'CASH' ? 'CASH' : 'BANK',
          type: 'CREDIT',
          amount: paidAmount,
          description: `Initial payment for ${purchase.purchaseNumber} via ${purchaseData.paymentMethod || 'CREDIT'}`
        }
      ], {
        referenceType: 'PAYMENT',
        referenceId: purchase._id,
        referenceModel: 'Purchase',
        referenceNumber: purchase.purchaseNumber
      }, session);

      purchase.payments.push({
        amount: paidAmount,
        paymentMethod: purchaseData.paymentMethod || 'CASH',
        paymentDate: purchaseData.purchaseDate || new Date(),
        referenceNumber: purchaseData.billNumber || '',
        notes: 'Initial payment during purchase creation',
        createdBy: req.user._id,
        createdAt: new Date(),
        ledgerEntries: paymentLedgerEntries.map(e => e._id)
      });
    }

    await purchase.save({ session });
    await session.commitTransaction();

    const response = purchase.toObject();
    if (zeroPriceWarnings.length > 0) response.warnings = zeroPriceWarnings;
    res.status(201).json(response);
  } catch (error) {
    if (session) await session.abortTransaction();
    console.error('Purchase creation error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) session.endSession();
  }
});

// @route   PUT /api/purchases/:id
// @desc    Edit purchase (quantity, supplier, rate, etc.)
// @access  Private
router.put('/:id', async (req, res) => {
  let session = null;

  try {
    const { supplier: supplierId, items, ...purchaseData } = req.body;

    // Get existing purchase with full details
    const oldPurchase = await Purchase.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('items.product')
      .populate('items.batch');

    if (!oldPurchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    // CRITICAL: Cannot edit purchase if it has returns
    if (oldPurchase.isReturned) {
      return res.status(400).json({
        message: 'Cannot edit purchase with returns. This would cause accounting inconsistencies.'
      });
    }

    // Validate supplier if changed
    let supplier = null;
    if (supplierId && supplierId !== oldPurchase.supplier.toString()) {
      supplier = await Supplier.findOne(addOrgFilter(req, { _id: supplierId }));
      if (!supplier) {
        return res.status(404).json({ message: 'Supplier not found' });
      }
    } else {
      supplier = await Supplier.findById(oldPurchase.supplier);
      if (!supplier) {
        return res.status(404).json({
          message: 'Original supplier not found. It may have been deleted. Please select a new supplier.'
        });
      }
    }

    // Validate items array
    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Please add at least one item' });
    }

    // Check that products are not changed (only quantities and other fields can change)
    for (let i = 0; i < items.length; i++) {
      const newItem = items[i];
      const oldItem = oldPurchase.items[i];

      if (!oldItem || newItem.product.toString() !== oldItem.product._id.toString()) {
        return res.status(400).json({
          message: 'Cannot change products in purchase. Only quantity, rate, and other details can be edited.'
        });
      }
    }

    if (items.length !== oldPurchase.items.length) {
      return res.status(400).json({
        message: 'Cannot add or remove items. Only edit existing items.'
      });
    }

    // Get shop settings for tax type determination
    const shopSettings = await ShopSettings.findOne(addOrgFilter(req));
    const taxType = determineTaxType(shopSettings?.state, supplier.state);

    // IMPORTANT: Preserve old charges if not provided in request
    const freight = purchaseData.freight !== undefined ? purchaseData.freight : oldPurchase.freight;
    const packaging = purchaseData.packaging !== undefined ? purchaseData.packaging : oldPurchase.packaging;
    const otherCharges = purchaseData.otherCharges !== undefined ? purchaseData.otherCharges : oldPurchase.otherCharges;
    const discount = purchaseData.discount !== undefined ? purchaseData.discount : oldPurchase.discount;

    // Validate charges are not negative BEFORE any database writes
    if (freight < 0) {
      return res.status(400).json({ message: 'Freight charges cannot be negative' });
    }
    if (packaging < 0) {
      return res.status(400).json({ message: 'Packaging charges cannot be negative' });
    }
    if (otherCharges < 0) {
      return res.status(400).json({ message: 'Other charges cannot be negative' });
    }
    if (discount < 0) {
      return res.status(400).json({ message: 'Discount cannot be negative' });
    }

    // Process each item, validate, and prepare batch updates (WITHOUT saving yet)
    const Batch = (await import('../models/Batch.js')).default;
    const processedItems = [];
    const inventoryAdjustments = [];
    const batchUpdates = []; // Store batch updates to apply later

    for (let i = 0; i < items.length; i++) {
      const newItemData = items[i];
      const oldItem = oldPurchase.items[i];
      const product = oldItem.product;

      // Validate product still exists
      if (!product || !product._id) {
        return res.status(400).json({
          message: `Product for item #${i + 1} not found. It may have been deleted. Cannot edit this purchase.`
        });
      }

      // Validate quantities are positive
      if (newItemData.quantity <= 0) {
        return res.status(400).json({
          message: `Quantity for item #${i + 1} (${product.name}) must be greater than 0`
        });
      }
      if (newItemData.freeQuantity && newItemData.freeQuantity < 0) {
        return res.status(400).json({
          message: `Free quantity for item #${i + 1} (${product.name}) cannot be negative`
        });
      }

      // Validate prices are not negative
      if (newItemData.purchasePrice !== undefined && newItemData.purchasePrice < 0) {
        return res.status(400).json({
          message: `Purchase price for item #${i + 1} (${product.name}) cannot be negative`
        });
      }
      if (newItemData.sellingPrice !== undefined && newItemData.sellingPrice < 0) {
        return res.status(400).json({
          message: `Selling price for item #${i + 1} (${product.name}) cannot be negative`
        });
      }
      if (newItemData.mrp !== undefined && newItemData.mrp < 0) {
        return res.status(400).json({
          message: `MRP for item #${i + 1} (${product.name}) cannot be negative`
        });
      }

      // Calculate quantity difference (including free quantity)
      const oldTotalQty = oldItem.quantity + (oldItem.freeQuantity || 0);
      const newTotalQty = newItemData.quantity + (newItemData.freeQuantity || 0);
      const qtyDifference = newTotalQty - oldTotalQty;

      // Calculate GST for item
      const itemWithGST = calculateItemGST({
        ...newItemData,
        purchasePrice: newItemData.purchasePrice
      }, taxType, 'purchase');

      // Fetch batch (read-only, no save yet)
      const batch = await Batch.findById(oldItem.batch);
      if (!batch) {
        return res.status(404).json({ message: `Batch not found for item #${i + 1}` });
      }

      // Calculate new batch values
      const newBatchQuantity = batch.quantity + qtyDifference;
      const newBatchPurchasePrice = newItemData.purchasePrice !== undefined ? newItemData.purchasePrice : batch.purchasePrice;
      const newBatchSellingPrice = newItemData.sellingPrice !== undefined ? newItemData.sellingPrice : batch.sellingPrice;
      const newBatchMrp = newItemData.mrp !== undefined ? newItemData.mrp : batch.mrp;
      const newBatchGstRate = itemWithGST.gstRate !== undefined ? itemWithGST.gstRate : batch.gstRate;

      // Calculate new expiry date
      let newBatchExpiryDate = batch.expiryDate;
      if (newItemData.expiryDate) {
        const newExpiry = new Date(newItemData.expiryDate);
        const oldExpiry = oldItem.expiryDate ? new Date(oldItem.expiryDate) : null;
        if (!oldExpiry || newExpiry.getTime() !== oldExpiry.getTime()) {
          newBatchExpiryDate = newExpiry;
        }
      }

      // Determine new batch active status
      let newBatchIsActive = batch.isActive;
      let newBatchDepletedAt = batch.depletedAt;

      if (newBatchQuantity > 0) {
        newBatchIsActive = true;
        newBatchDepletedAt = null;
      } else if (newBatchQuantity === 0) {
        newBatchIsActive = false;
        newBatchDepletedAt = new Date();
      } else {
        // Negative quantity - keep active
        newBatchIsActive = true;
        newBatchDepletedAt = null;
        console.warn(`Warning: Batch ${batch.batchNo} will have negative inventory: ${newBatchQuantity}`);
      }

      // Store batch update to apply later
      batchUpdates.push({
        batch,
        quantity: newBatchQuantity,
        purchasePrice: newBatchPurchasePrice,
        sellingPrice: newBatchSellingPrice,
        mrp: newBatchMrp,
        gstRate: newBatchGstRate,
        expiryDate: newBatchExpiryDate,
        isActive: newBatchIsActive,
        depletedAt: newBatchDepletedAt
      });

      // Track inventory adjustment
      inventoryAdjustments.push({
        product: product._id,
        productName: product.name,
        batch: batch._id,
        batchNo: batch.batchNo,
        oldQuantity: oldTotalQty,
        newQuantity: newTotalQty,
        difference: qtyDifference
      });

      processedItems.push({
        ...itemWithGST,
        product: product._id,
        productName: product.name,
        batch: batch._id,
        batchNo: batch.batchNo,
        expiryDate: newBatchExpiryDate,
        hsnCode: product.hsnCode || newItemData.hsnCode,
        unit: product.unit
      });
    }

    // Calculate new totals BEFORE any writes

    const totals = calculateTotals(
      processedItems,
      {
        freight,
        packaging,
        otherCharges
      },
      discount
    );

    // Calculate balance amount
    // IMPORTANT: Calculate paidAmount from payments array to maintain consistency
    // Payments should only be managed through the /payments routes
    const paidAmount = oldPurchase.payments && oldPurchase.payments.length > 0
      ? oldPurchase.payments.reduce((sum, payment) => sum + payment.amount, 0)
      : 0;

    const balanceAmount = totals.grandTotal - paidAmount;
    const paymentStatus = balanceAmount <= 0 ? 'PAID' : (paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    // ========================================
    // ALL VALIDATIONS PASSED - START TRANSACTION AND DATABASE WRITES
    // ========================================

    // Start MongoDB session for transaction support
    session = await Purchase.startSession();
    session.startTransaction();

    // Apply all batch updates using findByIdAndUpdate to avoid __v optimistic-lock
    // conflicts that can silently no-op batch.save({ session }) inside a transaction.
    for (const batchUpdate of batchUpdates) {
      await Batch.findByIdAndUpdate(batchUpdate.batch._id, {
        $set: {
          quantity: batchUpdate.quantity,
          purchasePrice: batchUpdate.purchasePrice,
          sellingPrice: batchUpdate.sellingPrice,
          mrp: batchUpdate.mrp,
          gstRate: batchUpdate.gstRate,
          expiryDate: batchUpdate.expiryDate,
          isActive: batchUpdate.isActive,
          depletedAt: batchUpdate.depletedAt
        }
      }, { session });
    }

    // Update product stock quantities
    const { updateProductTotalStock } = await import('../utils/inventoryManager.js');
    for (const adjustment of inventoryAdjustments) {
      await updateProductTotalStock(
        adjustment.product,
        req.user._id,
        req.organizationId || req.user.organizationId,
        session
      );
    }

    // Calculate supplier ledger adjustment
    const supplierChanged = oldPurchase.supplier.toString() !== supplier._id.toString();

    if (supplierChanged) {
      // Different suppliers - update both separately
      const oldSupplier = await Supplier.findById(oldPurchase.supplier);

      // Reverse old supplier ledger
      if (oldSupplier) {
        oldSupplier.currentBalance -= oldPurchase.balanceAmount;
        oldSupplier.totalPurchases -= oldPurchase.grandTotal;
        await oldSupplier.save({ session });
      }

      // Update new supplier ledger
      supplier.currentBalance += balanceAmount;
      supplier.totalPurchases += totals.grandTotal;
      await supplier.save({ session });
    } else {
      // Same supplier - calculate net change
      const balanceChange = balanceAmount - oldPurchase.balanceAmount;
      const totalChange = totals.grandTotal - oldPurchase.grandTotal;

      supplier.currentBalance += balanceChange;
      supplier.totalPurchases += totalChange;
      await supplier.save({ session });
    }

    // Delete old ledger entries
    const LedgerModel = (await import('../models/Ledger.js')).default;
    if (oldPurchase.ledgerEntries && oldPurchase.ledgerEntries.length > 0) {
      await LedgerModel.deleteMany({ _id: { $in: oldPurchase.ledgerEntries } }, { session });
    }

    // Save old values for audit trail BEFORE updating
    const auditData = {
      oldGrandTotal: oldPurchase.grandTotal,
      oldBalanceAmount: oldPurchase.balanceAmount,
      oldSupplier: oldPurchase.supplierName,
      inventoryAdjustments
    };

    // Update purchase document
    oldPurchase.supplier = supplier._id;
    oldPurchase.supplierName = supplier.name;
    oldPurchase.supplierGstin = supplier.gstin;
    oldPurchase.supplierInvoiceNo = purchaseData.billNumber !== undefined ? purchaseData.billNumber : oldPurchase.supplierInvoiceNo;
    oldPurchase.supplierInvoiceDate = purchaseData.billDate !== undefined ? purchaseData.billDate : oldPurchase.supplierInvoiceDate;
    oldPurchase.purchaseDate = purchaseData.purchaseDate !== undefined ? purchaseData.purchaseDate : oldPurchase.purchaseDate;
    oldPurchase.dueDate = purchaseData.dueDate !== undefined ? purchaseData.dueDate : oldPurchase.dueDate;
    oldPurchase.freight = freight;
    oldPurchase.packaging = packaging;
    oldPurchase.otherCharges = otherCharges;
    oldPurchase.discount = discount;
    oldPurchase.paymentMethod = purchaseData.paymentMethod !== undefined ? purchaseData.paymentMethod : oldPurchase.paymentMethod;
    oldPurchase.paymentTerms = purchaseData.paymentTerms !== undefined ? purchaseData.paymentTerms : oldPurchase.paymentTerms;
    oldPurchase.notes = purchaseData.notes !== undefined ? purchaseData.notes : oldPurchase.notes;
    oldPurchase.items = processedItems;
    oldPurchase.taxType = taxType;
    oldPurchase.subtotal = totals.subtotal;
    oldPurchase.totalTax = totals.totalTax;
    oldPurchase.totalCGST = totals.totalCGST;
    oldPurchase.totalSGST = totals.totalSGST;
    oldPurchase.totalIGST = totals.totalIGST;
    oldPurchase.grandTotal = totals.grandTotal;
    oldPurchase.roundOff = totals.roundOff;
    oldPurchase.paymentStatus = paymentStatus;
    oldPurchase.paidAmount = paidAmount;
    oldPurchase.balanceAmount = balanceAmount;

    // Create new ledger entries
    const ledgerEntries = await postPurchaseToLedger(
      oldPurchase,
      req.user._id,
      req.organizationId || req.user.organizationId,
      session
    );
    oldPurchase.ledgerEntries = ledgerEntries.map(entry => entry._id);

    // Add audit trail
    if (!oldPurchase.editHistory) {
      oldPurchase.editHistory = [];
    }
    oldPurchase.editHistory.push({
      editedBy: req.user._id,
      editedAt: new Date(),
      changes: {
        ...auditData,
        newGrandTotal: totals.grandTotal,
        newBalanceAmount: balanceAmount,
        newSupplier: supplier.name
      }
    });

    await oldPurchase.save({ session });

    // Commit the transaction - all changes saved atomically
    await session.commitTransaction();

    res.json({
      success: true,
      purchase: oldPurchase,
      message: 'Purchase updated successfully',
      warnings: inventoryAdjustments
        .filter(adj => adj.difference < 0 && (adj.newQuantity < 0))
        .map(adj => `Warning: ${adj.productName} has negative inventory`)
    });
  } catch (error) {
    // Rollback the transaction on any error - no changes saved
    if (session) {
      await session.abortTransaction();
    }
    console.error('Purchase edit error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    // End the session if it was created
    if (session) {
      session.endSession();
    }
  }
});

// @route   PUT /api/purchases/:id/payment
// @desc    Update payment status (Legacy - for backward compatibility)
// @access  Private
router.put('/:id/payment', protect, async (req, res) => {
  try {
    const { paymentMethod, paidAmount, paymentDetails } = req.body;

    const purchase = await Purchase.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    const oldBalance = purchase.balanceAmount;
    const newPaidAmount = purchase.paidAmount + (paidAmount || 0);
    const newBalance = purchase.grandTotal - newPaidAmount;

    purchase.paidAmount = newPaidAmount;
    purchase.balanceAmount = newBalance;
    purchase.paymentStatus = newBalance <= 0 ? 'PAID' : (newPaidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    if (paymentMethod) purchase.paymentMethod = paymentMethod;
    if (paymentDetails) purchase.paymentDetails = paymentDetails;

    await purchase.save();

    // Update supplier balance
    const supplier = await Supplier.findById(purchase.supplier);
    if (supplier) {
      supplier.currentBalance = supplier.currentBalance - oldBalance + newBalance;
      await supplier.save();
    }

    res.json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/purchases/:id/payments
// @desc    Add a new payment to purchase
// @access  Private
router.post('/:id/payments', async (req, res) => {
  let session = null;

  try {
    const { amount, paymentMethod, paymentDate, referenceNumber, notes } = req.body;

    // Validate input
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Payment amount must be greater than 0' });
    }

    if (!paymentMethod) {
      return res.status(400).json({ message: 'Payment method is required' });
    }

    // Get purchase with tenant isolation
    const purchase = await Purchase.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('supplier');

    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    // Validate payment amount doesn't exceed balance
    if (amount > purchase.balanceAmount) {
      return res.status(400).json({
        message: `Payment amount (₹${amount}) cannot exceed balance amount (₹${purchase.balanceAmount})`
      });
    }

    // Start transaction
    session = await Purchase.startSession();
    session.startTransaction();

    // Create payment entry
    const payment = {
      amount,
      paymentMethod,
      paymentDate: paymentDate || new Date(),
      referenceNumber,
      notes,
      createdBy: req.user._id,
      createdAt: new Date()
    };

    // Create ledger entry for this payment
    const Ledger = (await import('../models/Ledger.js')).default;
    const ledgerEntries = await Ledger.createDoubleEntry(
      req.organizationId || req.user.organizationId,
      req.user._id,
      [
        {
          account: 'ACCOUNTS_PAYABLE',
          type: 'DEBIT',
          amount: amount,
          party: 'SUPPLIER',
          partyId: purchase.supplier._id,
          partyModel: 'Supplier',
          partyName: purchase.supplier.name || purchase.supplierName,
          description: `Payment for ${purchase.purchaseNumber}`
        },
        {
          account: paymentMethod === 'CASH' ? 'CASH' : 'BANK',
          type: 'CREDIT',
          amount: amount,
          description: `Payment for ${purchase.purchaseNumber} via ${paymentMethod}`
        }
      ],
      {
        referenceType: 'PAYMENT',
        referenceId: purchase._id,
        referenceModel: 'Purchase',
        referenceNumber: purchase.purchaseNumber
      },
      session
    );

    // Store both ledger entry IDs (debit and credit)
    payment.ledgerEntries = ledgerEntries.map(entry => entry._id);

    // Initialize payments array if it doesn't exist (for old purchases)
    if (!purchase.payments) {
      purchase.payments = [];
    }

    // Initialize paidAmount and balanceAmount if they don't exist (for old purchases)
    if (purchase.paidAmount === undefined || purchase.paidAmount === null) {
      purchase.paidAmount = 0;
    }
    if (purchase.balanceAmount === undefined || purchase.balanceAmount === null) {
      purchase.balanceAmount = purchase.grandTotal;
    }

    // Add payment to purchase
    purchase.payments.push(payment);

    // Update purchase totals
    const oldPaidAmount = purchase.paidAmount;
    const oldBalanceAmount = purchase.balanceAmount;

    purchase.paidAmount = oldPaidAmount + amount;
    purchase.balanceAmount = oldBalanceAmount - amount;
    purchase.paymentStatus = purchase.balanceAmount <= 0 ? 'PAID' : 'PARTIAL';

    await purchase.save({ session });

    // Update supplier balance (fetch within session to avoid race conditions)
    const supplier = await Supplier.findById(purchase.supplier._id).session(session);
    if (supplier) {
      supplier.currentBalance -= amount; // Reduce supplier balance
      await supplier.save({ session });
    }

    // Commit transaction
    await session.commitTransaction();

    res.status(201).json({
      success: true,
      payment: purchase.payments[purchase.payments.length - 1],
      purchase: {
        paidAmount: purchase.paidAmount,
        balanceAmount: purchase.balanceAmount,
        paymentStatus: purchase.paymentStatus
      },
      message: 'Payment added successfully'
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }
    console.error('Add payment error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

// @route   PUT /api/purchases/:id/payments/:paymentId
// @desc    Edit a payment
// @access  Private
router.put('/:id/payments/:paymentId', async (req, res) => {
  let session = null;

  try {
    const { amount, paymentMethod, paymentDate, referenceNumber, notes } = req.body;

    // Validate input
    if (amount !== undefined && amount <= 0) {
      return res.status(400).json({ message: 'Payment amount must be greater than 0' });
    }

    // Get purchase with tenant isolation
    const purchase = await Purchase.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('supplier');

    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    // Initialize payments array if it doesn't exist (for old purchases)
    if (!purchase.payments) {
      purchase.payments = [];
    }

    // Find the payment
    const payment = purchase.payments.id(req.params.paymentId);
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    // Calculate what the new balance would be
    const oldPaymentAmount = payment.amount;
    const newPaymentAmount = amount !== undefined ? amount : oldPaymentAmount;
    const amountDifference = newPaymentAmount - oldPaymentAmount;

    // Check if new amount is valid
    const currentBalanceWithoutThisPayment = purchase.balanceAmount + oldPaymentAmount;
    if (newPaymentAmount > currentBalanceWithoutThisPayment) {
      return res.status(400).json({
        message: `Payment amount (₹${newPaymentAmount}) cannot exceed available balance (₹${currentBalanceWithoutThisPayment})`
      });
    }

    // Start transaction
    session = await Purchase.startSession();
    session.startTransaction();

    // Delete all old ledger entries (both debit and credit)
    const Ledger = (await import('../models/Ledger.js')).default;
    if (payment.ledgerEntries && payment.ledgerEntries.length > 0) {
      await Ledger.deleteMany({ _id: { $in: payment.ledgerEntries } }, { session });
    } else if (payment.ledgerEntry) {
      // Backward compatibility for old payments with single ledgerEntry
      await Ledger.deleteMany({ _id: payment.ledgerEntry }, { session });
    }

    // Update payment details
    if (amount !== undefined) payment.amount = amount;
    if (paymentMethod !== undefined) payment.paymentMethod = paymentMethod;
    if (paymentDate !== undefined) payment.paymentDate = paymentDate;
    if (referenceNumber !== undefined) payment.referenceNumber = referenceNumber;
    if (notes !== undefined) payment.notes = notes;

    // Create new ledger entries (debit and credit)
    const ledgerEntries = await Ledger.createDoubleEntry(
      req.organizationId || req.user.organizationId,
      req.user._id,
      [
        {
          account: 'ACCOUNTS_PAYABLE',
          type: 'DEBIT',
          amount: payment.amount,
          party: 'SUPPLIER',
          partyId: purchase.supplier._id,
          partyModel: 'Supplier',
          partyName: purchase.supplier.name || purchase.supplierName,
          description: `Payment for ${purchase.purchaseNumber}`
        },
        {
          account: payment.paymentMethod === 'CASH' ? 'CASH' : 'BANK',
          type: 'CREDIT',
          amount: payment.amount,
          description: `Payment for ${purchase.purchaseNumber} via ${payment.paymentMethod}`
        }
      ],
      {
        referenceType: 'PAYMENT',
        referenceId: purchase._id,
        referenceModel: 'Purchase',
        referenceNumber: purchase.purchaseNumber
      },
      session
    );

    // Store both ledger entry IDs (debit and credit)
    payment.ledgerEntries = ledgerEntries.map(entry => entry._id);

    // Initialize paidAmount and balanceAmount if they don't exist (for old purchases)
    if (purchase.paidAmount === undefined || purchase.paidAmount === null) {
      purchase.paidAmount = 0;
    }
    if (purchase.balanceAmount === undefined || purchase.balanceAmount === null) {
      purchase.balanceAmount = purchase.grandTotal;
    }

    // Update purchase totals
    purchase.paidAmount += amountDifference;
    purchase.balanceAmount -= amountDifference;
    purchase.paymentStatus = purchase.balanceAmount <= 0 ? 'PAID' : (purchase.paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    await purchase.save({ session });

    // Update supplier balance (fetch within session to avoid race conditions)
    const supplier = await Supplier.findById(purchase.supplier._id).session(session);
    if (supplier) {
      supplier.currentBalance -= amountDifference;
      await supplier.save({ session });
    }

    // Commit transaction
    await session.commitTransaction();

    res.json({
      success: true,
      payment,
      purchase: {
        paidAmount: purchase.paidAmount,
        balanceAmount: purchase.balanceAmount,
        paymentStatus: purchase.paymentStatus
      },
      message: 'Payment updated successfully'
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }
    console.error('Edit payment error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

// @route   DELETE /api/purchases/:id/payments/:paymentId
// @desc    Delete a payment
// @access  Private
router.delete('/:id/payments/:paymentId', async (req, res) => {
  let session = null;

  try {
    // Get purchase with tenant isolation
    const purchase = await Purchase.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('supplier');

    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    // Initialize payments array if it doesn't exist (for old purchases)
    if (!purchase.payments) {
      purchase.payments = [];
    }

    // Find the payment
    const payment = purchase.payments.id(req.params.paymentId);
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    const paymentAmount = payment.amount;

    // Start transaction
    session = await Purchase.startSession();
    session.startTransaction();

    // Delete all ledger entries (both debit and credit)
    const Ledger = (await import('../models/Ledger.js')).default;
    if (payment.ledgerEntries && payment.ledgerEntries.length > 0) {
      await Ledger.deleteMany({ _id: { $in: payment.ledgerEntries } }, { session });
    } else if (payment.ledgerEntry) {
      // Backward compatibility for old payments with single ledgerEntry
      await Ledger.deleteMany({ _id: payment.ledgerEntry }, { session });
    }

    // Remove payment from array
    purchase.payments.pull(req.params.paymentId);

    // Initialize paidAmount and balanceAmount if they don't exist (for old purchases)
    if (purchase.paidAmount === undefined || purchase.paidAmount === null) {
      purchase.paidAmount = 0;
    }
    if (purchase.balanceAmount === undefined || purchase.balanceAmount === null) {
      purchase.balanceAmount = purchase.grandTotal;
    }

    // Update purchase totals
    purchase.paidAmount -= paymentAmount;
    purchase.balanceAmount += paymentAmount;
    purchase.paymentStatus = purchase.balanceAmount >= purchase.grandTotal ? 'UNPAID' : (purchase.paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    await purchase.save({ session });

    // Update supplier balance (fetch within session to avoid race conditions)
    const supplier = await Supplier.findById(purchase.supplier._id).session(session);
    if (supplier) {
      supplier.currentBalance += paymentAmount;
      await supplier.save({ session });
    }

    // Commit transaction
    await session.commitTransaction();

    res.json({
      success: true,
      purchase: {
        paidAmount: purchase.paidAmount,
        balanceAmount: purchase.balanceAmount,
        paymentStatus: purchase.paymentStatus
      },
      message: 'Payment deleted successfully'
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }
    console.error('Delete payment error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

// @route   DELETE /api/purchases/:id
// @desc    Delete purchase and associated products (batches)
// @access  Private
router.delete('/:id', async (req, res) => {
  let session = null;

  try {
    // Get purchase with tenant isolation and full details
    const purchase = await Purchase.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('supplier')
      .populate('items.batch')
      .populate('items.product');

    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    // Check if purchase has returns
    if (purchase.isReturned) {
      return res.status(400).json({
        message: 'Cannot delete purchase with returns. Delete returns first.'
      });
    }

    // Block deletion if any stock from this purchase has already been sold.
    // Each purchase item stores how much it contributed to its batch.
    // If the batch's current quantity is less than that contribution, some
    // units were already consumed by invoices and deleting would corrupt stock.
    for (const item of purchase.items) {
      if (!item.batch) continue;
      const purchaseQty = item.quantity + (item.freeQuantity || 0);
      const currentBatchQty = item.batch.quantity ?? 0;
      if (currentBatchQty < purchaseQty) {
        return res.status(400).json({
          message: `Cannot delete: stock from batch "${item.batch.batchNo || item.batch._id}" has already been partially sold. This purchase added ${purchaseQty} units but only ${currentBatchQty} remain. Delete or edit the related invoices first.`
        });
      }
    }

    // Start transaction
    session = await Purchase.startSession();
    session.startTransaction();

    const Batch = (await import('../models/Batch.js')).default;
    const { updateProductTotalStock } = await import('../utils/inventoryManager.js');

    // Subtract only this purchase's contribution from each batch.
    // Do NOT delete the batch outright — it may be shared with other purchases
    // that used the same batchNo + product combination.
    const updatedProductIds = new Set();
    for (const item of purchase.items) {
      if (!item.batch) continue;

      const purchaseQty = item.quantity + (item.freeQuantity || 0);
      const newQty = (item.batch.quantity ?? 0) - purchaseQty;

      if (newQty <= 0) {
        // This purchase was the sole contributor — deactivate the batch
        await Batch.findByIdAndUpdate(
          item.batch._id,
          { $set: { quantity: 0, isActive: false, depletedAt: new Date() } },
          { session }
        );
      } else {
        // Shared batch — reduce by exactly what this purchase added
        await Batch.findByIdAndUpdate(
          item.batch._id,
          { $inc: { quantity: -purchaseQty } },
          { session }
        );
      }

      if (item.product?._id) updatedProductIds.add(item.product._id.toString());
    }

    // Recompute product stock from remaining active batches
    for (const productId of updatedProductIds) {
      await updateProductTotalStock(
        productId,
        req.user._id,
        req.organizationId || req.user.organizationId,
        session
      );
    }

    // Delete ledger entries
    const Ledger = (await import('../models/Ledger.js')).default;
    if (purchase.ledgerEntries && purchase.ledgerEntries.length > 0) {
      await Ledger.deleteMany({ _id: { $in: purchase.ledgerEntries } }, { session });
    }

    // Delete payment ledger entries
    if (purchase.payments && purchase.payments.length > 0) {
      for (const payment of purchase.payments) {
        if (payment.ledgerEntries && payment.ledgerEntries.length > 0) {
          await Ledger.deleteMany({ _id: { $in: payment.ledgerEntries } }, { session });
        }
      }
    }

    // Update supplier totals
    const supplier = await Supplier.findById(purchase.supplier._id).session(session);
    if (supplier) {
      supplier.currentBalance -= purchase.balanceAmount;
      supplier.totalPurchases -= purchase.grandTotal;
      await supplier.save({ session });
    }

    // Delete the purchase
    await Purchase.deleteOne({ _id: purchase._id }, { session });

    // Commit transaction
    await session.commitTransaction();

    res.json({
      success: true,
      message: 'Purchase and associated products deleted successfully'
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }
    console.error('Delete purchase error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

export default router;
