import express from 'express';
import Product from '../models/Product.js';
import Batch from '../models/Batch.js';
import { protect } from '../middleware/auth.js';
import tenantIsolation, { addOrgFilter } from '../middleware/tenantIsolation.js';
import { requirePermission } from '../middleware/requireSuperAdmin.js';
import { createBatch, updateProductTotalStock } from '../utils/inventoryManager.js';

const router = express.Router();

// Apply authentication and tenant isolation to all routes
router.use(protect);
router.use(tenantIsolation);

// IMPORTANT: Specific routes must come BEFORE /:id route to avoid conflicts

// @route   GET /api/products/with-batches
// @desc    Get all products with their batches (with pagination, search, filters, sorting)
// @access  Private
router.get('/with-batches', async (req, res) => {
  try {
    const {
      search,
      itemStatus,
      category,
      page = 1,
      limit = 15,
      sortBy = 'name',
      sortOrder = 'asc'
    } = req.query;

    // Build base query
    const baseQuery = addOrgFilter(req, { isActive: true });
    let query = { ...baseQuery };
    const additionalFilters = {};

    // Item status filter
    if (itemStatus) {
      additionalFilters.itemStatus = itemStatus;
    }

    // Category filter
    if (category) {
      additionalFilters.category = category;
    }

    // Apply additional filters
    query = { ...query, ...additionalFilters };

    // Search filter (product name or HSN code)
    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { name: searchRegex },
        { hsnCode: searchRegex }
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const totalProducts = await Product.countDocuments(query);

    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Fetch products with pagination
    const products = await Product.find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum)
      .lean();

    // For each product, fetch ALL batches (active + inactive) for display
    const productsWithBatches = await Promise.all(
      products.map(async (product) => {
        const batches = await Batch.find({
          product: product._id,
          organizationId: req.organizationId
          // Note: Fetch ALL batches (active + inactive) so UI can show inactive with toggle
        })
          .sort({ createdAt: 1 }) // FIFO order
          .lean();

        return {
          ...product,
          batches: batches || []
        };
      })
    );

    // Send response with pagination metadata
    res.json({
      products: productsWithBatches,
      pagination: {
        total: totalProducts,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalProducts / limitNum),
        hasNextPage: pageNum < Math.ceil(totalProducts / limitNum),
        hasPrevPage: pageNum > 1
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/products/batches-for-invoice
// @desc    Get all active batches grouped by product for invoice dropdown
// @access  Private
router.get('/batches-for-invoice', async (req, res) => {
  try {
    // 1. Normal batched products — active batches with stock > 0
    const batches = await Batch.find(
      addOrgFilter(req, {
        isActive: true,
        quantity: { $gt: 0 }
      })
    )
      .populate('product', 'name hsnCode unit trackInventory')
      .sort({ product: 1, createdAt: 1 })
      .lean();

    const batchOptions = batches
      .filter(batch => batch.product) // guard against orphaned batches
      .map(batch => ({
        batchId: batch._id,
        productId: batch.product._id,
        productName: batch.product.name,
        batchNo: batch.batchNo || 'N/A',
        sellingPrice: batch.sellingPrice,
        mrp: batch.mrp,
        gstRate: batch.gstRate,
        availableQuantity: batch.quantity,
        expiryDate: batch.expiryDate,
        unit: batch.product.unit,
        hsnCode: batch.product.hsnCode,
        trackInventory: true,
        label: `${batch.product.name} - ₹${batch.sellingPrice} (Batch: ${batch.batchNo || 'N/A'}, Stock: ${batch.quantity}${batch.expiryDate ? `, Exp: ${new Date(batch.expiryDate).toLocaleDateString('en-GB')}` : ''})`
      }));

    // 2. Products with serial numbers — return as grouped product with available serials
    const productsWithSerials = await Product.find(
      addOrgFilter(req, {
        isActive: true,
        serialNumbers: { $exists: true, $ne: [] }
      })
    ).lean();

    const serialProductOptions = [];
    for (const product of productsWithSerials) {
      // Get available (unsold) serial numbers
      const availableSerials = (product.serialNumbers || []).filter(
        sn => !(product.soldSerialNumbers || []).includes(sn)
      );

      // Only show product if it has available serials
      if (availableSerials.length > 0) {
        // Try to find the batch for this product
        const productBatch = await Batch.findOne({
          product: product._id,
          organizationId: req.organizationId,
          isActive: true
        }).lean();

        serialProductOptions.push({
          batchId: productBatch?._id || null,
          productId: product._id,
          productName: product.name,
          batchNo: productBatch?.batchNo || null,
          sellingPrice: productBatch?.sellingPrice || product.sellingPrice,
          mrp: productBatch?.mrp || product.mrp,
          gstRate: productBatch?.gstRate || product.gstRate,
          availableQuantity: availableSerials.length, // Total available serials
          availableSerials: availableSerials, // Array of available serial numbers
          expiryDate: productBatch?.expiryDate || null,
          unit: product.unit,
          hsnCode: product.hsnCode,
          trackInventory: true,
          hasSerial: true,
          label: `${product.name} - ₹${productBatch?.sellingPrice || product.sellingPrice} (${availableSerials.length} available)`
        });
      }
    }

    // 3. Non-inventory products (trackInventory: false) — always show, no batch needed
    const nonInventoryProducts = await Product.find(
      addOrgFilter(req, { isActive: true, trackInventory: false })
    ).lean();

    const nonInventoryOptions = nonInventoryProducts.map(product => ({
      batchId: null,                   // No batch
      productId: product._id,
      productName: product.name,
      batchNo: null,
      sellingPrice: product.sellingPrice,
      mrp: product.mrp,
      gstRate: product.gstRate,
      availableQuantity: null,         // Unlimited / not tracked
      expiryDate: null,
      unit: product.unit,
      hsnCode: product.hsnCode,
      trackInventory: false,
      label: `${product.name} - ₹${product.sellingPrice} (No stock tracking)`
    }));

    res.json([...batchOptions, ...serialProductOptions, ...nonInventoryOptions]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/products
// @desc    Get all products
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { search, lowStock } = req.query;
    let query = addOrgFilter(req, { isActive: true });

    if (search) {
      query.$text = { $search: search };
    }

    if (lowStock === 'true') {
      const products = await Product.find(query);
      const lowStockProducts = products.filter(p => p.stockQuantity <= p.minStockLevel);
      return res.json(lowStockProducts);
    }

    const products = await Product.find(query).sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/products/:id
// @desc    Get single product
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findOne(
      addOrgFilter(req, { _id: req.params.id })
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/products
// @desc    Create product
// @access  Private (requires permission)
router.post('/', requirePermission('canManageProducts'), async (req, res) => {
  try {
    const { stockQuantity, batchNo, expiryDate, ...productData } = req.body;

    // Create product with ZERO stock initially
    const product = await Product.create({
      ...productData,
      stockQuantity: 0,
      trackInventory: productData.trackInventory !== false, // default true
      organizationId: req.organizationId,
      userId: req.user._id
    });

    // Only create initial batch if inventory is tracked AND stock > 0
    if (product.trackInventory && stockQuantity && stockQuantity > 0) {
      // Auto-generate batch number if not provided
      const finalBatchNo = batchNo && batchNo.trim()
        ? batchNo.trim()
        : `AUTO-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Default expiry date to 1 year from now if not provided
      const finalExpiryDate = expiryDate
        ? new Date(expiryDate)
        : new Date(new Date().setFullYear(new Date().getFullYear() + 1));

      await createBatch({
        organizationId: req.organizationId,
        userId: req.user._id,
        product: product._id,
        batchNo: finalBatchNo,
        expiryDate: finalExpiryDate,
        manufacturingDate: productData.manufacturingDate || null,
        mrp: product.mrp,
        purchasePrice: product.purchasePrice,
        sellingPrice: product.sellingPrice,
        gstRate: product.gstRate,
        quantity: stockQuantity,
        purchaseInvoice: null, // No purchase reference for initial stock
        supplier: null,
        rack: product.rack || ''
      });

      // createBatch automatically calls updateProductTotalStock
      // So product.stockQuantity will be updated to match batch quantity
    }

    // Fetch updated product (with correct stockQuantity if batch was created)
    const updatedProduct = await Product.findById(product._id);
    res.status(201).json(updatedProduct);

  } catch (error) {
    console.error('Product creation error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/products/:id
// @desc    Update product
// @access  Private (requires permission)
router.put('/:id', requirePermission('canManageProducts'), async (req, res) => {
  try {
    // stockQuantity is managed exclusively by inventory operations (invoices, purchases,
    // stock adjustments). Never allow direct overwrite via product edit — it would
    // cause the product's stock count to diverge from actual batch quantities.
    const { stockQuantity, ...safeBody } = req.body;

    const product = await Product.findOneAndUpdate(
      addOrgFilter(req, { _id: req.params.id }),
      safeBody,
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/products/:id
// @desc    Delete product (soft delete)
// @access  Private (requires permission)
router.delete('/:id', requirePermission('canManageProducts'), async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate(
      addOrgFilter(req, { _id: req.params.id }),
      { isActive: false },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/products/sync-stock
// @desc    Recompute stockQuantity for all products in this org from actual batch totals.
//          Use this to fix any data inconsistency caused by direct product edits that
//          overwrote the computed stock quantity.
// @access  Private
router.post('/sync-stock', async (req, res) => {
  try {
    const products = await Product.find({ organizationId: req.organizationId, isActive: true });
    const results = [];

    for (const product of products) {
      const newQty = await updateProductTotalStock(product._id, req.user._id, req.organizationId);
      results.push({ name: product.name, stockQuantity: newQty });
    }

    res.json({ message: `Synced stock for ${results.length} products`, products: results });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
