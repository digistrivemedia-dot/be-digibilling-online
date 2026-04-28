import express from 'express';
import Batch from '../models/Batch.js';
import Product from '../models/Product.js';
import StockAdjustment from '../models/StockAdjustment.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';
import {
  getAvailableBatches,
  getNearExpiryBatches,
  getExpiredBatches,
  getLowStockProducts,
  updateProductTotalStock
} from '../utils/inventoryManager.js';

const router = express.Router();

router.use(protect);
router.use(tenantIsolation);

// @route   GET /api/inventory/batches
// @desc    Get all batches with product info (optimized for inventory page)
// @access  Private
router.get('/batches', async (req, res) => {
  try {
    const batches = await Batch.find({
      organizationId: req.organizationId,
      isActive: true
    })
      .select('batchNo expiryDate quantity mrp sellingPrice purchasePrice gstRate product supplier') // Only needed fields
      .populate('product', 'name genericName unit') // Only needed product fields
      .populate('supplier', 'name')
      .lean() // Convert to plain JS objects (faster, less memory)
      .sort({ expiryDate: 1, createdAt: -1 }); // Sort by expiry date, then newest first

    // Transform to match frontend expectations
    const batchesWithProductInfo = batches.map(batch => ({
      _id: batch._id,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
      quantity: batch.quantity,
      mrp: batch.mrp,
      sellingPrice: batch.sellingPrice,
      purchasePrice: batch.purchasePrice,
      gstRate: batch.gstRate,
      product: batch.product,
      productInfo: batch.product // Add productInfo field for compatibility
    }));

    res.json(batchesWithProductInfo);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/inventory/batches/product/:productId
// @desc    Get available batches for a product (FIFO sorted)
// @access  Private
router.get('/batches/product/:productId', async (req, res) => {
  try {
    const batches = await getAvailableBatches(req.params.productId, req.user._id, req.organizationId);
    res.json(batches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/inventory/batches/:id
// @desc    Get single batch details
// @access  Private
router.get('/batches/:id', async (req, res) => {
  try {
    const batch = await Batch.findOne({
      _id: req.params.id,
      organizationId: req.organizationId
    }).populate('product', 'name genericName manufacturer')
      .populate('supplier', 'name')
      .populate('purchaseInvoice', 'purchaseNumber');

    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    res.json(batch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/inventory/alerts/near-expiry
// @desc    Get batches near expiry (within 3 months by default)
// @access  Private
router.get('/alerts/near-expiry', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    const batches = await getNearExpiryBatches(req.organizationId, months);
    res.json(batches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/inventory/alerts/expired
// @desc    Get expired batches
// @access  Private
router.get('/alerts/expired', async (req, res) => {
  try {
    const batches = await getExpiredBatches(req.organizationId);
    res.json(batches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/inventory/alerts/low-stock
// @desc    Get products with low stock
// @access  Private
router.get('/alerts/low-stock', async (req, res) => {
  try {
    const products = await getLowStockProducts(req.organizationId);
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/inventory/stats
// @desc    Get inventory statistics
// @access  Private
router.get('/stats', async (req, res) => {
  try {
    const [totalProducts, totalBatches, nearExpiry, expired, lowStock, inventoryValue] = await Promise.all([
      Product.countDocuments({ organizationId: req.organizationId, isActive: true }),
      Batch.countDocuments({ organizationId: req.organizationId, isActive: true, quantity: { $gt: 0 } }),
      getNearExpiryBatches(req.organizationId, 3),
      getExpiredBatches(req.organizationId),
      getLowStockProducts(req.organizationId),
      Batch.aggregate([
        {
          $match: {
            organizationId: req.organizationId,
            isActive: true,
            quantity: { $gt: 0 }
          }
        },
        {
          $group: {
            _id: null,
            value: {
              $sum: {
                $multiply: ['$quantity', '$purchasePrice']
              }
            }
          }
        }
      ])
    ]);

    res.json({
      totalProducts,
      totalBatches,
      nearExpiryCount: nearExpiry.length,
      expiredCount: expired.length,
      lowStockCount: lowStock.length,
      totalValue: inventoryValue[0]?.value || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/inventory/valuation
// @desc    Get inventory valuation report
// @access  Private
router.get('/valuation', async (req, res) => {
  try {
    const batches = await Batch.find({
      organizationId: req.organizationId,
      isActive: true,
      quantity: { $gt: 0 }
    }).populate('product', 'name genericName category');

    const valuation = batches.map(batch => ({
      product: batch.product,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
      quantity: batch.quantity,
      purchasePrice: batch.purchasePrice,
      sellingPrice: batch.sellingPrice,
      mrp: batch.mrp,
      purchaseValue: batch.quantity * batch.purchasePrice,
      sellingValue: batch.quantity * batch.sellingPrice,
      potentialProfit: batch.quantity * (batch.sellingPrice - batch.purchasePrice)
    }));

    const totals = valuation.reduce((acc, item) => ({
      totalPurchaseValue: acc.totalPurchaseValue + item.purchaseValue,
      totalSellingValue: acc.totalSellingValue + item.sellingValue,
      totalPotentialProfit: acc.totalPotentialProfit + item.potentialProfit
    }), {
      totalPurchaseValue: 0,
      totalSellingValue: 0,
      totalPotentialProfit: 0
    });

    res.json({
      batches: valuation,
      ...totals
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/inventory/batches/:id/toggle-active
// @desc    Toggle batch active/inactive status
// @access  Private
router.put('/batches/:id/toggle-active', async (req, res) => {
  try {
    const batch = await Batch.findOne({
      _id: req.params.id,
      organizationId: req.organizationId
    });

    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    // Toggle isActive status
    batch.isActive = !batch.isActive;
    await batch.save();

    // Update product total stock (will exclude inactive batches)
    const { updateProductTotalStock } = await import('../utils/inventoryManager.js');
    await updateProductTotalStock(batch.product, batch.userId, batch.organizationId);

    res.json({
      message: `Batch ${batch.isActive ? 'activated' : 'deactivated'} successfully`,
      batch
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/inventory/batches/:id
// @desc    Update batch details (price, rack, etc.)
// @access  Private
router.put('/batches/:id', async (req, res) => {
  try {
    const batch = await Batch.findOne({
      _id: req.params.id,
      organizationId: req.organizationId
    });

    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    // Only allow updating certain fields
    const allowedUpdates = ['sellingPrice', 'mrp', 'rack'];
    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        batch[field] = req.body[field];
      }
    });

    await batch.save();
    res.json(batch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/inventory/batches/:id
// @desc    Delete batch (hard delete) and delete product if it's the last batch
// @access  Private
router.delete('/batches/:id', async (req, res) => {
  try {
    const batch = await Batch.findOne({
      _id: req.params.id,
      organizationId: req.organizationId
    });

    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    // Check if batch is referenced in any invoices, purchases, or returns
    const Invoice = (await import('../models/Invoice.js')).default;
    const Purchase = (await import('../models/Purchase.js')).default;
    const SalesReturn = (await import('../models/SalesReturn.js')).default;
    const PurchaseReturn = (await import('../models/PurchaseReturn.js')).default;

    const [invoiceCount, purchaseCount, salesReturnCount, purchaseReturnCount] = await Promise.all([
      Invoice.countDocuments({ 'items.batch': batch._id }),
      Purchase.countDocuments({ 'items.batch': batch._id }),
      SalesReturn.countDocuments({ 'items.batch': batch._id }),
      PurchaseReturn.countDocuments({ 'items.batch': batch._id })
    ]);

    const totalReferences = invoiceCount + purchaseCount + salesReturnCount + purchaseReturnCount;

    if (totalReferences > 0) {
      return res.status(400).json({
        message: `Cannot delete batch. It is referenced in ${totalReferences} transaction(s) (Invoices: ${invoiceCount}, Purchases: ${purchaseCount}, Sales Returns: ${salesReturnCount}, Purchase Returns: ${purchaseReturnCount}). Please deactivate instead.`
      });
    }

    const productId = batch.product;
    const userId = batch.userId;
    const organizationId = batch.organizationId;

    // Hard delete the batch (safe because no references exist)
    await Batch.deleteOne({ _id: batch._id });

    // Check if this was the last batch for this product
    const remainingBatches = await Batch.countDocuments({
      product: productId
    });

    if (remainingBatches === 0) {
      // Delete the product if no batches remain
      await Product.deleteOne({ _id: productId });
      return res.json({
        message: 'Batch and product deleted successfully (last batch)',
        productDeleted: true
      });
    } else {
      // Update product total stock (excluding deleted batch)
      const { updateProductTotalStock } = await import('../utils/inventoryManager.js');
      await updateProductTotalStock(productId, userId, organizationId);

      return res.json({
        message: 'Batch deleted successfully',
        productDeleted: false
      });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/inventory/top-selling
// @desc    Get top selling products with filters
// @access  Private
router.get('/top-selling', async (req, res) => {
  try {
    const { startDate, endDate, limit = 100 } = req.query;
    const Invoice = (await import('../models/Invoice.js')).default;

    // Build date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.invoiceDate = {};
      if (startDate) dateFilter.invoiceDate.$gte = new Date(startDate);
      if (endDate) dateFilter.invoiceDate.$lte = new Date(endDate);
    }

    // Aggregate to get top selling products
    const topSellingProducts = await Invoice.aggregate([
      {
        $match: {
          organizationId: req.organizationId,
          ...dateFilter
        }
      },
      // Unwind items array to process each item separately
      { $unwind: '$items' },
      // Group by product
      {
        $group: {
          _id: '$items.product',
          productName: { $first: '$items.productName' },
          serviceName: { $first: '$items.serviceName' },
          itemType: { $first: '$items.itemType' },
          totalQuantitySold: { $sum: '$items.quantity' },
          totalOrders: { $sum: 1 },
          totalRevenue: {
            $sum: {
              $multiply: ['$items.quantity', '$items.sellingPrice']
            }
          }
        }
      },
      // Lookup product details for products (not services)
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'productDetails'
        }
      },
      // Add computed fields
      {
        $addFields: {
          productInfo: { $arrayElemAt: ['$productDetails', 0] },
          displayName: {
            $cond: {
              if: { $eq: ['$itemType', 'service'] },
              then: '$serviceName',
              else: {
                $cond: {
                  if: '$productName',
                  then: '$productName',
                  else: { $arrayElemAt: ['$productDetails.name', 0] }
                }
              }
            }
          }
        }
      },
      // Sort by total quantity sold (highest first)
      { $sort: { totalQuantitySold: -1 } },
      // Limit results
      { $limit: parseInt(limit) },
      // Project final fields
      {
        $project: {
          _id: 1,
          displayName: 1,
          itemType: 1,
          totalQuantitySold: 1,
          totalOrders: 1,
          totalRevenue: 1,
          unit: '$productInfo.unit'
        }
      }
    ]);

    res.json(topSellingProducts);
  } catch (error) {
    console.error('Top selling products error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Direction lookup — used to decide whether to add or subtract from batch quantity
const TYPE_DIRECTION = {
  CONSUMED: 'out',
  PRODUCTION: 'in',
  MANUAL_ADD: 'in',
  MANUAL_REMOVE: 'out',
  DAMAGE: 'out',
  EXPIRY: 'out',
  TRANSFER: 'neutral',
};

// @route   GET /api/inventory/adjustments
// @desc    Get stock adjustment history for this org
// @access  Private
router.get('/adjustments', async (req, res) => {
  try {
    const adjustments = await StockAdjustment.find({ organizationId: req.organizationId })
      .populate('product', 'name unit')
      .populate('batch', 'batchNo')
      .sort({ date: -1, createdAt: -1 })
      .lean();
    res.json(adjustments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/inventory/adjustments
// @desc    Record a stock adjustment (updates batch quantity + product total stock)
// @access  Private
router.post('/adjustments', async (req, res) => {
  try {
    const { productId, batchId, type, quantity, date, reason, notes } = req.body;

    if (!productId) return res.status(400).json({ message: 'productId is required' });
    if (!type || !TYPE_DIRECTION[type]) return res.status(400).json({ message: 'Invalid adjustment type' });
    if (!quantity || parseFloat(quantity) <= 0) return res.status(400).json({ message: 'Quantity must be greater than 0' });
    if (!date) return res.status(400).json({ message: 'Date is required' });

    const product = await Product.findOne({ _id: productId, organizationId: req.organizationId });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const direction = TYPE_DIRECTION[type];
    const qty = parseFloat(quantity);
    let targetBatch = null;

    if (direction === 'out' || direction === 'neutral') {
      // Deduct from specific batch or FIFO oldest batch
      if (batchId) {
        targetBatch = await Batch.findOne({ _id: batchId, organizationId: req.organizationId, product: productId });
        if (!targetBatch) return res.status(404).json({ message: 'Batch not found' });
        if (targetBatch.quantity < qty) {
          return res.status(400).json({ message: `Insufficient stock in batch. Available: ${targetBatch.quantity}` });
        }
        targetBatch.quantity -= qty;
        await targetBatch.save();
      } else {
        // FIFO across all batches
        const batches = await Batch.find({
          organizationId: req.organizationId,
          product: productId,
          isActive: true,
          quantity: { $gt: 0 },
        }).sort({ expiryDate: 1, createdAt: 1 });

        const totalAvailable = batches.reduce((s, b) => s + b.quantity, 0);
        if (totalAvailable < qty) {
          return res.status(400).json({ message: `Insufficient total stock. Available: ${totalAvailable}` });
        }

        let remaining = qty;
        for (const batch of batches) {
          if (remaining <= 0) break;
          const deduct = Math.min(batch.quantity, remaining);
          batch.quantity -= deduct;
          remaining -= deduct;
          await batch.save();
          if (!targetBatch) targetBatch = batch; // record first batch for the log
        }
      }
    } else {
      // direction === 'in': add to specific batch or newest active batch
      if (batchId) {
        targetBatch = await Batch.findOne({ _id: batchId, organizationId: req.organizationId, product: productId });
        if (!targetBatch) return res.status(404).json({ message: 'Batch not found' });
        targetBatch.quantity += qty;
        await targetBatch.save();
      } else {
        // Add to the most recently created active batch
        targetBatch = await Batch.findOne({
          organizationId: req.organizationId,
          product: productId,
          isActive: true,
        }).sort({ createdAt: -1 });

        if (!targetBatch) {
          return res.status(400).json({ message: 'No active batch found for this product. Please add stock via a purchase first.' });
        }
        targetBatch.quantity += qty;
        await targetBatch.save();
      }
    }

    // Recompute product total stock from all batches
    await updateProductTotalStock(productId, req.user._id, req.organizationId);

    // Persist the adjustment record
    const adjustment = await StockAdjustment.create({
      organizationId: req.organizationId,
      userId: req.user._id,
      product: productId,
      batch: targetBatch?._id || null,
      type,
      direction,
      quantity: qty,
      date: new Date(date),
      reason: reason || '',
      notes: notes || '',
    });

    await adjustment.populate('product', 'name unit');
    await adjustment.populate('batch', 'batchNo');

    res.status(201).json(adjustment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
