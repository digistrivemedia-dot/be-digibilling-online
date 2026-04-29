import express from 'express';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import Customer from '../models/Customer.js';
import ShopSettings from '../models/ShopSettings.js';
import Batch from '../models/Batch.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';
import { calculateItemGST, calculateTotals, determineTaxType } from '../utils/gstCalculations.js';
import { getBatchesForSale, deductBatchStock, addBatchStock, calculateCOGS } from '../utils/inventoryManager.js';
import { postSalesToLedger } from '../utils/ledgerHelper.js';
import Ledger from '../models/Ledger.js';
import { generateInvoicePDF } from '../utils/pdfGenerator.js';

const router = express.Router();

// @route   GET /api/invoices/:id/pdf
// @desc    Get invoice as PDF (Public - No Auth Required)
// @access  Public
router.get('/:id/pdf', async (req, res) => {
  try {
    // Find invoice without organization filter (public access)
    const invoice = await Invoice.findById(req.params.id)
      .populate('customer')
      .populate('items.product')
      .populate('items.batch');

    if (!invoice) {
      console.error('Invoice not found:', req.params.id);
      return res.status(404).send('Invoice not found');
    }

    // Get shop settings for the invoice's organization
    const shopSettings = await ShopSettings.findOne({
      organizationId: invoice.organizationId
    });

    // Generate PDF
    const pdfBuffer = await generateInvoicePDF(invoice, shopSettings);

    // Set headers to display PDF in browser
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Invoice-${invoice.invoiceNumber}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // Send as binary buffer, not JSON
    res.end(pdfBuffer, 'binary');
  } catch (error) {
    console.error('PDF route error:', error);
    res.status(500).send(`Error generating PDF: ${error.message}`);
  }
});

// Apply authentication and tenant isolation to all routes AFTER the public PDF route
router.use(protect);
router.use(tenantIsolation);

// @route   GET /api/invoices
// @desc    Get all invoices with pagination, search, and filters
// @access  Private
router.get('/', async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      paymentStatus,
      customer,
      search,
      invoiceType,
      minAmount,
      maxAmount,
      page = 1,
      limit = 15,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build base query with organization filter
    const baseQuery = addOrgFilter(req);
    let query = { ...baseQuery };
    const additionalFilters = {};

    // Date range filter
    if (startDate && endDate) {
      additionalFilters.invoiceDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    // Payment status filter
    if (paymentStatus) {
      additionalFilters.paymentStatus = paymentStatus;
    }

    // Customer filter
    if (customer) {
      additionalFilters.customer = customer;
    }

    // Invoice type filter
    if (invoiceType) {
      additionalFilters.invoiceType = invoiceType;
    }

    // Amount range filter
    if (minAmount || maxAmount) {
      additionalFilters.grandTotal = {};
      if (minAmount) additionalFilters.grandTotal.$gte = parseFloat(minAmount);
      if (maxAmount) additionalFilters.grandTotal.$lte = parseFloat(maxAmount);
    }

    // Apply additional filters to query
    query = { ...query, ...additionalFilters };

    // Search filter (invoice number, customer name, customer phone)
    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { invoiceNumber: searchRegex },
        { customerName: searchRegex },
        { customerPhone: searchRegex }
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination
    const totalInvoices = await Invoice.countDocuments(query);

    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Fetch invoices with pagination
    const invoices = await Invoice.find(query)
      .populate('customer', 'name phone')
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Send response with pagination metadata
    res.json({
      invoices,
      pagination: {
        total: totalInvoices,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalInvoices / limitNum),
        hasNextPage: pageNum < Math.ceil(totalInvoices / limitNum),
        hasPrevPage: pageNum > 1
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/invoices/stats
// @desc    Get invoice statistics
// @access  Private
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Calculate first day of current month
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    const orgFilter = addOrgFilter(req); // Use organizationId filter

    const [todaySales, totalOutstanding, invoiceCount, monthlyRevenue] = await Promise.all([
      Invoice.aggregate([
        {
          $match: {
            ...orgFilter,
            invoiceDate: { $gte: today }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$grandTotal' }
          }
        }
      ]),
      Invoice.aggregate([
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
      Invoice.countDocuments(orgFilter),
      Invoice.aggregate([
        {
          $match: {
            ...orgFilter,
            invoiceDate: { $gte: firstDayOfMonth }
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
      todaySales: todaySales[0]?.total || 0,
      totalOutstanding: totalOutstanding[0]?.total || 0,
      totalInvoices: invoiceCount,
      monthlyRevenue: monthlyRevenue[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/invoices/:id
// @desc    Get single invoice
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const query = addOrgFilter(req, { _id: req.params.id });
    const invoice = await Invoice.findOne(query)
      .populate('customer')
      .populate('items.product')
      .populate('items.batch');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/invoices
// @desc    Create invoice with FIFO batch selection
// @access  Private
router.post('/', async (req, res) => {
  let session = null;

  try {
    const { items, customer: customerId, ...invoiceData } = req.body;

    // Get shop settings for tax type determination
    const shopSettings = await ShopSettings.findOne(addOrgFilter(req));

    // Determine tax type based on customer state
    let taxType = invoiceData.taxType || 'CGST_SGST';
    let customerData = {
      customerName: invoiceData.customerName,
      customerPhone: invoiceData.customerPhone,
      customerAddress: invoiceData.customerAddress,
      customerCity: invoiceData.customerCity,
      customerState: invoiceData.customerState,
      customerGstin: invoiceData.customerGstin
    };

    // Get customer details if provided
    let customer = null;
    if (customerId) {
      customer = await Customer.findOne(addOrgFilter(req, { _id: customerId }));

      if (customer) {
        customerData = {
          customer: customer._id,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerAddress: customer.address,
          customerCity: customer.city,
          customerState: customer.state,
          customerGstin: customer.gstin
        };

        // Determine tax type based on customer state
        if (shopSettings && customer.state) {
          taxType = determineTaxType(shopSettings.state, customer.state);
        }
      }
    }

    // Validate items array
    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Please add at least one item to the invoice' });
    }

    // Pre-validate all items and build batch deduction plan BEFORE the transaction.
    // Reads happen outside the tx to keep DB write-lock time to a minimum.
    const processedItems = [];
    const batchDeductions = []; // applied atomically inside the transaction

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Validate quantity — applies to both products and services
      if (!item.quantity || item.quantity <= 0) {
        return res.status(400).json({ message: `Please enter a valid quantity for item #${i + 1}` });
      }

      // ── SERVICE ITEM PATH ────────────────────────────────────────────────
      // No product lookup, no stock check, no batch deduction.
      if (item.itemType === 'service') {
        if (!item.serviceName || item.serviceName.trim() === '') {
          return res.status(400).json({ message: `Please enter a service name for item #${i + 1}` });
        }

        const itemWithGST = calculateItemGST({
          quantity: item.quantity,
          sellingPrice: item.sellingPrice || 0,
          discountAmount: item.discountAmount || 0,
          discount: item.discount || 0,
          gstRate: item.gstRate || 0
        }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

        processedItems.push({
          itemType: 'service',
          product: undefined,          // no product for services
          productName: item.serviceName.trim(),
          serviceName: item.serviceName.trim(),
          sacCode: item.sacCode || '',
          batch: undefined,
          batchNo: undefined,
          expiryDate: undefined,
          hsnCode: undefined,
          quantity: item.quantity,
          unit: item.unit || 'NOS',
          mrp: item.sellingPrice || 0,
          purchasePrice: 0,            // COGS = 0 for services
          sellingPrice: item.sellingPrice || 0,
          ...itemWithGST
        });
        continue; // skip all product/stock/batch logic below
      }

      // ── PRODUCT ITEM PATH ────────────────────────────────────────────────
      // Validate product is selected
      if (!item.product || item.product === '') {
        return res.status(400).json({ message: `Please select a product for item #${i + 1}` });
      }

      // Validate product exists in this org
      const product = await Product.findOne(addOrgFilter(req, { _id: item.product }));

      if (!product) {
        return res.status(400).json({ message: `Product not found for item #${i + 1}. Please select a valid product.` });
      }

      // ── Non-inventory product: skip all stock/batch logic ──────────────
      if (!product.trackInventory) {
        const itemWithGST = calculateItemGST({
          quantity: item.quantity,
          sellingPrice: item.sellingPrice || product.sellingPrice,
          discountAmount: item.discountAmount || 0,
          discount: item.discount || 0,
          gstRate: item.gstRate ?? product.gstRate
        }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

        processedItems.push({
          itemType: 'product',
          product: product._id,
          productName: product.name,
          batch: null,
          batchNo: null,
          expiryDate: null,
          hsnCode: product.hsnCode,
          quantity: item.quantity,
          unit: product.unit,
          mrp: item.sellingPrice || product.sellingPrice,
          purchasePrice: product.purchasePrice || 0,
          sellingPrice: item.sellingPrice || product.sellingPrice,
          ...itemWithGST
        });
        continue; // Skip batch deduction entirely
      }

      // ── Inventory-tracked product: normal stock / batch logic ───────────

      // Serial number products: require a serial to be selected and verify it is available
      if (product.serialNumbers && product.serialNumbers.length > 0) {
        if (!item.serialNumber) {
          return res.status(400).json({
            message: `Serial number is required for ${product.name}`
          });
        }
        if (!product.serialNumbers.includes(item.serialNumber)) {
          return res.status(400).json({
            message: `Serial number "${item.serialNumber}" does not belong to ${product.name}`
          });
        }
        if ((product.soldSerialNumbers || []).includes(item.serialNumber)) {
          return res.status(400).json({
            message: `Serial number "${item.serialNumber}" has already been sold`
          });
        }
      }

      // Check total available stock
      if (product.stockQuantity < item.quantity) {
        throw new Error(`Insufficient stock for ${product.name}. Available: ${product.stockQuantity}, Requested: ${item.quantity}`);
      }

      // FIFO batch selection - two modes:
      // Mode 1: User selects specific batch (item.batch provided)
      // Mode 2: Automatic FIFO selection (item.batch not provided)

      if (item.batch) {
        // Manual batch selection
        const batch = await Batch.findOne(addOrgFilter(req, {
          _id: item.batch,
          product: product._id,
          isActive: true
        }));

        if (!batch) {
          throw new Error(`Batch not found or inactive for ${product.name}`);
        }

        if (batch.quantity < item.quantity) {
          throw new Error(`Insufficient stock in selected batch for ${product.name}`);
        }

        // Calculate GST for this item
        const itemWithGST = calculateItemGST({
          quantity: item.quantity,
          sellingPrice: item.sellingPrice || batch.sellingPrice,
          discountAmount: item.discountAmount || 0,
          discount: item.discount || 0,
          gstRate: batch.gstRate
        }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

        // Register deduction — applied atomically inside the transaction
        batchDeductions.push({
          batchId: batch._id,
          quantity: item.quantity,
          productId: product._id,
          serialNumber: item.serialNumber || null // Track serial if provided
        });

        processedItems.push({
          itemType: 'product',
          product: product._id,
          productName: product.name,
          batch: batch._id,
          batchNo: batch.batchNo,
          expiryDate: batch.expiryDate,
          serialNumber: item.serialNumber || null, // Include serial number
          hsnCode: product.hsnCode,
          quantity: item.quantity,
          unit: product.unit,
          mrp: batch.mrp,
          purchasePrice: batch.purchasePrice, // For COGS
          sellingPrice: item.sellingPrice || batch.sellingPrice,
          ...itemWithGST
        });

      } else {
        // Automatic FIFO selection
        const batchesForSale = await getBatchesForSale(product._id, req.user._id, req.user.organizationId, item.quantity);

        for (const batchSale of batchesForSale) {
          // Calculate GST for this portion
          const itemWithGST = calculateItemGST({
            quantity: batchSale.quantity,
            sellingPrice: item.sellingPrice || batchSale.sellingPrice,
            discountAmount: item.discountAmount || 0,
            discount: item.discount || 0,
            gstRate: batchSale.gstRate
          }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

          // Register deduction — applied atomically inside the transaction
          batchDeductions.push({ batchId: batchSale.batch, quantity: batchSale.quantity });

          processedItems.push({
            itemType: 'product',
            product: product._id,
            productName: product.name,
            batch: batchSale.batch,
            batchNo: batchSale.batchNo,
            expiryDate: batchSale.expiryDate,
            hsnCode: product.hsnCode,
            quantity: batchSale.quantity,
            unit: product.unit,
            mrp: batchSale.mrp,
            purchasePrice: batchSale.purchasePrice, // For COGS
            sellingPrice: item.sellingPrice || batchSale.sellingPrice,
            ...itemWithGST
          });
        }
      }
    }

    // Calculate invoice totals (pure computation — no DB writes)
    const totals = calculateTotals(processedItems, {}, invoiceData.discount || 0, shopSettings?.gstScheme || 'REGULAR');
    const cogs = await calculateCOGS(processedItems);
    const paidAmount = invoiceData.paidAmount || 0;
    const balanceAmount = totals.grandTotal - paidAmount;
    const paymentStatus = balanceAmount <= 0 ? 'PAID' : (paidAmount > 0 ? 'PARTIAL' : 'UNPAID');
    const eWayBillRequired = taxType === 'IGST' && totals.grandTotal > 50000;

    // ──────────────────────────────────────────────────────────────────────────
    // START TRANSACTION — all writes below are atomic.
    // If ANY step throws, abortTransaction() rolls ALL of them back:
    //   • batch stock deductions
    //   • invoice document creation
    //   • customer outstanding balance
    //   • ledger entries (sales + payment)
    // ──────────────────────────────────────────────────────────────────────────
    session = await Invoice.startSession();
    session.startTransaction();

    // Step 1: Deduct batch stock and mark serial numbers as sold
    for (const d of batchDeductions) {
      await deductBatchStock(d.batchId, d.quantity, session);

      // If this item has a serial number, mark it as sold
      if (d.serialNumber && d.productId) {
        await Product.findByIdAndUpdate(
          d.productId,
          { $addToSet: { soldSerialNumbers: d.serialNumber } },
          { session }
        );
      }
    }

    // Step 2: Create invoice document
    // Note: create() with session must receive an array and returns an array
    const invoiceArr = await Invoice.create([{
      userId: req.user._id,
      organizationId: req.organizationId || req.user.organizationId,
      ...customerData,
      // Ship To details (separate delivery address)
      shipToName: invoiceData.shipToName,
      shipToAddress: invoiceData.shipToAddress,
      shipToCity: invoiceData.shipToCity,
      shipToState: invoiceData.shipToState,
      shipToPincode: invoiceData.shipToPincode,
      items: processedItems,
      ...totals,
      taxType,
      invoiceType: invoiceData.invoiceType || 'tax-invoice',
      paymentStatus,
      paymentMethod: invoiceData.paymentMethod || 'CASH',
      paidAmount,
      balanceAmount,
      paymentDetails: invoiceData.paymentDetails,
      notes: invoiceData.notes,
      invoiceDate: invoiceData.invoiceDate || new Date(),
      cogs,
      // Prescription tracking
      prescriptionRequired: invoiceData.prescriptionRequired || false,
      prescriptionNumber: invoiceData.prescriptionNumber,
      doctorName: invoiceData.doctorName,
      prescriptionDate: invoiceData.prescriptionDate,
      // E-way bill
      eWayBillRequired,
      eWayBillNumber: invoiceData.eWayBillNumber,
      eWayBillDate: invoiceData.eWayBillDate,
      // Transportation details
      transporterName: invoiceData.transporterName,
      transporterId: invoiceData.transporterId,
      vehicleNumber: invoiceData.vehicleNumber,
      transportMode: invoiceData.transportMode,
      transportDocNumber: invoiceData.transportDocNumber,
      transportDocDate: invoiceData.transportDocDate,
      approxDist: invoiceData.approxDist,
      pos: invoiceData.pos,
      supplyDate: invoiceData.supplyDate,
      distance: invoiceData.distance,
      // Purchase Order
      poNumber: invoiceData.poNumber,
      poDate: invoiceData.poDate,
      // Additional invoice details (Tally header fields)
      deliveryNote: invoiceData.deliveryNote,
      referenceNo: invoiceData.referenceNo,
      otherReferences: invoiceData.otherReferences,
      termsOfDelivery: invoiceData.termsOfDelivery,
      destination: invoiceData.destination,
    }], { session });
    const invoice = invoiceArr[0]; // unwrap array returned by create([...], {session})

    // Step 3: Update customer outstanding balance
    if (customer && paymentStatus !== 'PAID') {
      customer.outstandingBalance += balanceAmount;
      await customer.save({ session });
    }

    // Step 4: Post sales ledger entries (double-entry accounting)
    const ledgerEntries = await postSalesToLedger(
      invoice,
      req.user._id,
      req.organizationId || req.user.organizationId,
      session
    );
    invoice.ledgerEntries = ledgerEntries.map(entry => entry._id);

    // Step 5: If initial payment was made, create payment ledger entries
    if (paidAmount > 0) {
      const paymentLedgerEntries = await Ledger.createDoubleEntry(
        req.organizationId || req.user.organizationId,
        req.user._id,
        [
          {
            account: invoiceData.paymentMethod === 'CASH' ? 'CASH' : 'BANK',
            type: 'DEBIT',
            amount: paidAmount,
            description: `Initial payment for ${invoice.invoiceNumber} via ${invoiceData.paymentMethod || 'CASH'}`
          },
          {
            account: 'ACCOUNTS_RECEIVABLE',
            type: 'CREDIT',
            amount: paidAmount,
            party: customer ? 'CUSTOMER' : undefined,
            partyId: customer ? customer._id : undefined,
            partyModel: customer ? 'Customer' : undefined,
            partyName: customer ? customer.name : invoiceData.customerName,
            description: `Initial payment for ${invoice.invoiceNumber}`
          }
        ],
        {
          referenceType: 'PAYMENT',
          referenceId: invoice._id,
          referenceModel: 'Invoice',
          referenceNumber: invoice.invoiceNumber
        },
        session
      );

      const initialPayment = {
        amount: paidAmount,
        paymentMethod: invoiceData.paymentMethod || 'CASH',
        paymentDate: invoiceData.invoiceDate || new Date(),
        referenceNumber: invoiceData.billNumber || '',
        notes: 'Initial payment during invoice creation',
        createdBy: req.user._id,
        createdAt: new Date(),
        ledgerEntries: paymentLedgerEntries.map(entry => entry._id)
      };

      invoice.payments.push(initialPayment);
    }

    // Step 6: Save final invoice (with ledger refs + payment entries)
    await invoice.save({ session });

    // COMMIT — every write above is now permanently saved together
    await session.commitTransaction();

    res.status(201).json(invoice);

  } catch (error) {
    // ROLLBACK — reverts batch deductions, invoice, customer balance, ledger entries
    if (session) {
      await session.abortTransaction();
    }
    console.error('Invoice creation error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});
// @route   PUT /api/invoices/:id
// @desc    Edit invoice (items, quantities, prices, customer, payment, etc.)
// @access  Private
router.put('/:id', async (req, res) => {
  let session = null;

  try {
    const { items, customer: customerId, ...invoiceData } = req.body;

    // Get existing invoice with full details
    const oldInvoice = await Invoice.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('customer')
      .populate('items.product')
      .populate('items.batch');

    if (!oldInvoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    // IMPORTANT: Allow editing even with partial returns, but track returned quantities
    // Fully returned invoices should still be editable for corrections

    // Validate items array
    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Invoice must have at least one item' });
    }

    // Get shop settings for tax determination
    const shopSettings = await ShopSettings.findOne(addOrgFilter(req));

    // Handle customer changes
    let customer = null;
    let taxType = invoiceData.taxType || oldInvoice.taxType || 'CGST_SGST';
    let customerData = {};

    // Check if customer was explicitly provided (even if undefined/null)
    const customerProvided = 'customer' in req.body;
    const oldCustomerId = oldInvoice.customer?._id?.toString();

    if (customerProvided && customerId && customerId !== oldCustomerId) {
      // Customer changed to a different customer
      customer = await Customer.findOne(addOrgFilter(req, { _id: customerId }));
      if (!customer) {
        return res.status(404).json({ message: 'Customer not found' });
      }
      customerData = {
        customer: customer._id,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerAddress: customer.address,
        customerCity: customer.city,
        customerState: customer.state,
        customerGstin: customer.gstin
      };
      if (shopSettings && customer.state) {
        taxType = determineTaxType(shopSettings.state, customer.state);
      }
    } else if (customerProvided && !customerId && oldCustomerId) {
      // Changed from customer to cash customer
      customer = null;
      customerData = {
        customerName: invoiceData.customerName || 'Cash Customer',
        customerPhone: invoiceData.customerPhone || '',
        customerAddress: invoiceData.customerAddress || '',
        customerCity: invoiceData.customerCity || '',
        customerState: invoiceData.customerState || '',
        customerGstin: invoiceData.customerGstin || ''
      };
    } else if (oldInvoice.customer && (!customerProvided || customerId === oldCustomerId)) {
      // Same customer - preserve or update details
      customer = oldInvoice.customer;
      customerData = {
        customer: customer._id,
        customerName: invoiceData.customerName !== undefined ? invoiceData.customerName : oldInvoice.customerName,
        customerPhone: invoiceData.customerPhone !== undefined ? invoiceData.customerPhone : oldInvoice.customerPhone,
        customerAddress: invoiceData.customerAddress !== undefined ? invoiceData.customerAddress : oldInvoice.customerAddress,
        customerCity: invoiceData.customerCity !== undefined ? invoiceData.customerCity : oldInvoice.customerCity,
        customerState: invoiceData.customerState !== undefined ? invoiceData.customerState : oldInvoice.customerState,
        customerGstin: invoiceData.customerGstin !== undefined ? invoiceData.customerGstin : oldInvoice.customerGstin
      };
    } else {
      // Walk-in customer (was cash, remains cash)
      customer = null;
      customerData = {
        customerName: invoiceData.customerName !== undefined ? invoiceData.customerName : oldInvoice.customerName,
        customerPhone: invoiceData.customerPhone !== undefined ? invoiceData.customerPhone : oldInvoice.customerPhone,
        customerAddress: invoiceData.customerAddress !== undefined ? invoiceData.customerAddress : oldInvoice.customerAddress,
        customerCity: invoiceData.customerCity !== undefined ? invoiceData.customerCity : oldInvoice.customerCity,
        customerState: invoiceData.customerState !== undefined ? invoiceData.customerState : oldInvoice.customerState,
        customerGstin: invoiceData.customerGstin !== undefined ? invoiceData.customerGstin : oldInvoice.customerGstin
      };
    }

    // Identify inventory changes - compare old items vs new items
    const inventoryChanges = [];
    const newItemsMap = new Map();

    // Build map of new items by product+batch.
    // No-batch items (services, non-inventory products) get a positional key so they
    // are not mistakenly treated as "removed" when the invoice is edited.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = item.batch ? `${item.product}_${item.batch}` : `no_batch_${item.product}_${i}`;
      newItemsMap.set(key, { ...item, index: i });
    }

    // Check which old tracked items were removed or had their quantity decreased.
    // Quantity INCREASES are intentionally not registered here — the second loop
    // (which processes new/modified items) already registers an ADD entry for the
    // extra quantity, so doing it here too would cause double-deduction.
    for (let idx = 0; idx < oldInvoice.items.length; idx++) {
      const oldItem = oldInvoice.items[idx];
      // Use the same keying scheme as the newItemsMap above
      const oldKey = oldItem.batch
        ? `${oldItem.product._id}_${oldItem.batch._id}`
        : `no_batch_${oldItem.product._id}_${idx}`;
      const newItem = newItemsMap.get(oldKey);

      if (!newItem) {
        // Item removed — return stock to original batch (only for tracked inventory items)
        const returnedQty = oldItem.returnedQuantity || 0;
        const availableToReturn = oldItem.quantity - returnedQty;

        if (availableToReturn > 0 && oldItem.batch) {
          inventoryChanges.push({
            type: 'REMOVE',
            batch: oldItem.batch._id,
            batchNo: oldItem.batch.batchNo,
            product: oldItem.product._id,
            productName: oldItem.productName,
            oldQuantity: oldItem.quantity,
            newQuantity: 0,
            change: availableToReturn,
            returnedQuantity: returnedQty
          });
        }
      } else if (oldItem.batch) {
        // Tracked item still present — handle quantity decrease only.
        // Increases are handled in the second loop to avoid double-deduction.
        const returnedQty = oldItem.returnedQuantity || 0;
        const oldAvailableQty = oldItem.quantity - returnedQty;
        const requestedQty = newItem.quantity;

        if (requestedQty < oldAvailableQty) {
          // Quantity decreased — return the difference to the batch
          inventoryChanges.push({
            type: 'DECREASE',
            batch: oldItem.batch._id,
            batchNo: oldItem.batch.batchNo,
            product: oldItem.product._id,
            productName: oldItem.productName,
            oldQuantity: oldItem.quantity,
            newQuantity: requestedQty,
            change: oldAvailableQty - requestedQty,
            returnedQuantity: returnedQty
          });
        }
        // quantity unchanged or increased → second loop handles it
      }
    }

    // Process new/modified items — validate stock availability and calculate GST.
    // For quantity increases on existing items, this loop registers ADD entries.
    const processedItems = [];
    const oldItemsMap = new Map();

    // Build map of old items (tracked inventory items only, keyed by product+batch)
    for (let idx = 0; idx < oldInvoice.items.length; idx++) {
      const oldItem = oldInvoice.items[idx];
      const key = oldItem.batch
        ? `${oldItem.product._id}_${oldItem.batch._id}`
        : `no_batch_${oldItem.product._id}_${idx}`;
      oldItemsMap.set(key, oldItem);
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Validate product
      const product = await Product.findOne(addOrgFilter(req, { _id: item.product }));
      if (!product) {
        return res.status(400).json({ message: `Product not found for item #${i + 1}` });
      }

      // Validate quantity
      if (!item.quantity || item.quantity <= 0) {
        return res.status(400).json({ message: `Invalid quantity for item #${i + 1} (${product.name})` });
      }

      const itemKey = item.batch
        ? `${item.product}_${item.batch}`
        : `no_batch_${item.product}_${i}`;
      const oldItem = oldItemsMap.get(itemKey);

      if (!oldItem) {
        // NEW ITEM - Use FIFO batch selection (like invoice creation)
        if (item.batch) {
          // Manual batch selection
          const batch = await Batch.findOne(addOrgFilter(req, {
            _id: item.batch,
            product: product._id,
            isActive: true
          }));

          if (!batch) {
            return res.status(400).json({ message: `Batch not found for ${product.name}` });
          }

          if (batch.quantity < item.quantity) {
            return res.status(400).json({
              message: `Insufficient stock for ${product.name}. Available: ${batch.quantity}, Requested: ${item.quantity}`
            });
          }

          // Calculate GST
          const itemWithGST = calculateItemGST({
            quantity: item.quantity,
            sellingPrice: item.sellingPrice || batch.sellingPrice,
            discountAmount: item.discountAmount || 0,
            discount: item.discount || 0,
            gstRate: batch.gstRate
          }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

          processedItems.push({
            product: product._id,
            productName: product.name,
            batch: batch._id,
            batchNo: batch.batchNo,
            expiryDate: batch.expiryDate,
            hsnCode: product.hsnCode,
            unit: product.unit,
            mrp: batch.mrp,
            purchasePrice: batch.purchasePrice,
            sellingPrice: item.sellingPrice || batch.sellingPrice,
            returnedQuantity: 0,
            ...itemWithGST
          });

          inventoryChanges.push({
            type: 'ADD',
            batch: batch._id,
            batchNo: batch.batchNo,
            product: product._id,
            productName: product.name,
            change: item.quantity
          });

        } else {
          // Automatic FIFO batch selection
          const batchesForSale = await getBatchesForSale(
            product._id,
            req.user._id,
            req.user.organizationId,
            item.quantity
          );

          for (const batchSale of batchesForSale) {
            const itemWithGST = calculateItemGST({
              quantity: batchSale.quantity,
              sellingPrice: item.sellingPrice || batchSale.sellingPrice,
              discountAmount: item.discountAmount || 0,
              discount: item.discount || 0,
              gstRate: batchSale.gstRate
            }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

            processedItems.push({
              product: product._id,
              productName: product.name,
              batch: batchSale.batch,
              batchNo: batchSale.batchNo,
              expiryDate: batchSale.expiryDate,
              hsnCode: product.hsnCode,
              unit: product.unit,
              mrp: batchSale.mrp,
              purchasePrice: batchSale.purchasePrice,
              sellingPrice: item.sellingPrice || batchSale.sellingPrice,
              returnedQuantity: 0,
              ...itemWithGST
            });

            inventoryChanges.push({
              type: 'ADD',
              batch: batchSale.batch,
              batchNo: batchSale.batchNo,
              product: product._id,
              productName: product.name,
              change: batchSale.quantity
            });
          }
        }

      } else {
        // EXISTING ITEM - may have quantity/price changes
        const batch = await Batch.findById(oldItem.batch._id);
        if (!batch) {
          return res.status(400).json({ message: `Batch not found for ${product.name}` });
        }

        const returnedQty = oldItem.returnedQuantity || 0;
        const oldNetQuantity = oldItem.quantity - returnedQty;
        const quantityIncrease = item.quantity - oldNetQuantity;

        if (quantityIncrease > 0) {
          // Need more stock
          if (batch.quantity < quantityIncrease) {
            return res.status(400).json({
              message: `Insufficient stock for ${product.name}. Available: ${batch.quantity}, Need additional: ${quantityIncrease}`
            });
          }
        }

        // Calculate GST with new prices
        const itemWithGST = calculateItemGST({
          quantity: item.quantity,
          sellingPrice: item.sellingPrice !== undefined ? item.sellingPrice : oldItem.sellingPrice,
          discountAmount: item.discountAmount !== undefined ? item.discountAmount : (oldItem.discountAmount || 0),
          discount: item.discount !== undefined ? item.discount : oldItem.discount,
          gstRate: batch.gstRate
        }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

        processedItems.push({
          product: product._id,
          productName: product.name,
          batch: batch._id,
          batchNo: batch.batchNo,
          expiryDate: batch.expiryDate,
          hsnCode: product.hsnCode,
          unit: product.unit,
          mrp: batch.mrp,
          purchasePrice: batch.purchasePrice,
          sellingPrice: item.sellingPrice !== undefined ? item.sellingPrice : oldItem.sellingPrice,
          returnedQuantity: returnedQty,
          ...itemWithGST
        });
      }
    }

    // Preserve other charges if not provided (default to 0 if undefined in old invoice)
    const deliveryCharges = invoiceData.deliveryCharges !== undefined ? invoiceData.deliveryCharges : (oldInvoice.deliveryCharges || 0);
    const packagingCharges = invoiceData.packagingCharges !== undefined ? invoiceData.packagingCharges : (oldInvoice.packagingCharges || 0);
    const otherCharges = invoiceData.otherCharges !== undefined ? invoiceData.otherCharges : (oldInvoice.otherCharges || 0);
    const discount = invoiceData.discount !== undefined ? invoiceData.discount : (oldInvoice.discount || 0);

    // Validate charges
    if (deliveryCharges < 0 || packagingCharges < 0 || otherCharges < 0 || discount < 0) {
      return res.status(400).json({ message: 'Charges and discount cannot be negative' });
    }

    // Calculate new totals
    const totals = calculateTotals(
      processedItems,
      { deliveryCharges, packagingCharges, otherCharges },
      discount,
      shopSettings?.gstScheme || 'REGULAR'
    );

    // Calculate paidAmount from payments array to maintain consistency
    // DO NOT allow direct paidAmount manipulation - it must be managed via payment entries
    const paidAmount = oldInvoice.payments && oldInvoice.payments.length > 0
      ? oldInvoice.payments.reduce((sum, payment) => sum + payment.amount, 0)
      : 0;

    const balanceAmount = totals.grandTotal - paidAmount;
    const paymentStatus = balanceAmount <= 0 ? 'PAID' : (paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    // Recalculate COGS (Cost of Goods Sold)
    const cogs = await calculateCOGS(processedItems);

    // ========================================
    // ALL VALIDATIONS PASSED - START TRANSACTION
    // ========================================

    session = await Invoice.startSession();
    session.startTransaction();

    // Apply inventory changes within transaction
    for (const change of inventoryChanges) {
      if (change.type === 'REMOVE' || change.type === 'DECREASE') {
        // Return stock to original batch
        await addBatchStock(change.batch, change.change, session);
      } else if (change.type === 'ADD' || change.type === 'INCREASE') {
        // Deduct stock from batch
        await deductBatchStock(change.batch, change.change, session);
      }
    }

    // Update customer balance if customer exists
    const customerChanged = (oldInvoice.customer?._id?.toString() !== customer?._id?.toString());

    if (customerChanged) {
      // Reverse old customer balance
      if (oldInvoice.customer) {
        const oldCustomer = await Customer.findById(oldInvoice.customer._id);
        if (oldCustomer) {
          oldCustomer.outstandingBalance -= oldInvoice.balanceAmount;
          await oldCustomer.save({ session });
        }
      }
      // Add new customer balance
      if (customer) {
        customer.outstandingBalance += balanceAmount;
        await customer.save({ session });
      }
    } else if (customer) {
      // Same customer - calculate net change
      const balanceChange = balanceAmount - oldInvoice.balanceAmount;
      customer.outstandingBalance += balanceChange;
      await customer.save({ session });
    }

    // Delete old ledger entries
    if (oldInvoice.ledgerEntries && oldInvoice.ledgerEntries.length > 0) {
      await Ledger.deleteMany({ _id: { $in: oldInvoice.ledgerEntries } }, { session });
    }

    // Save old values for audit trail BEFORE updating
    const auditData = {
      oldGrandTotal: oldInvoice.grandTotal,
      oldBalanceAmount: oldInvoice.balanceAmount,
      oldCustomer: oldInvoice.customerName,
      inventoryChanges
    };

    // Update invoice document
    Object.assign(oldInvoice, {
      ...customerData,
      invoiceDate: invoiceData.invoiceDate !== undefined ? invoiceData.invoiceDate : oldInvoice.invoiceDate,
      dueDate: invoiceData.dueDate !== undefined ? invoiceData.dueDate : oldInvoice.dueDate,
      deliveryCharges,
      packagingCharges,
      otherCharges,
      discount,
      paymentMethod: invoiceData.paymentMethod !== undefined ? invoiceData.paymentMethod : oldInvoice.paymentMethod,
      paymentTerms: invoiceData.paymentTerms !== undefined ? invoiceData.paymentTerms : oldInvoice.paymentTerms,
      notes: invoiceData.notes !== undefined ? invoiceData.notes : oldInvoice.notes,
      items: processedItems,
      taxType,
      subtotal: totals.subtotal,
      totalTax: totals.totalTax,
      totalCGST: totals.totalCGST,
      totalSGST: totals.totalSGST,
      totalIGST: totals.totalIGST,
      grandTotal: totals.grandTotal,
      roundOff: totals.roundOff,
      paymentStatus,
      paidAmount,
      balanceAmount,
      cogs
    });

    // Create new ledger entries
    const ledgerEntries = await postSalesToLedger(
      oldInvoice,
      req.user._id,
      req.organizationId || req.user.organizationId,
      session
    );
    oldInvoice.ledgerEntries = ledgerEntries.map(entry => entry._id);

    // Add audit trail
    if (!oldInvoice.editHistory) {
      oldInvoice.editHistory = [];
    }
    oldInvoice.editHistory.push({
      editedBy: req.user._id,
      editedAt: new Date(),
      changes: {
        ...auditData,
        newGrandTotal: totals.grandTotal,
        newBalanceAmount: balanceAmount,
        newCustomer: customerData.customerName
      }
    });

    await oldInvoice.save({ session });

    // Commit transaction
    await session.commitTransaction();

    res.json({
      success: true,
      invoice: oldInvoice,
      message: 'Invoice updated successfully',
      warnings: inventoryChanges
        .filter(c => (c.type === 'REMOVE' || c.type === 'DECREASE') && c.returnedQuantity > 0)
        .map(c => `Note: ${c.productName} had ${c.returnedQuantity} units returned`)
    });

  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }
    console.error('Invoice edit error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});


// @route   PUT /api/invoices/:id/payment
// @desc    Update payment status
// @access  Private
router.put('/:id/payment', async (req, res) => {
  try {
    const { paymentStatus, paymentMethod, paidAmount, paymentDetails } = req.body;

    const invoice = await Invoice.findOne(addOrgFilter(req, { _id: req.params.id }));

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    const oldBalance = invoice.balanceAmount;
    const newPaidAmount = invoice.paidAmount + (paidAmount || 0);
    const newBalance = invoice.grandTotal - newPaidAmount;

    invoice.paidAmount = newPaidAmount;
    invoice.balanceAmount = newBalance;
    invoice.paymentStatus = newBalance <= 0 ? 'PAID' : (newPaidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    if (paymentMethod) invoice.paymentMethod = paymentMethod;
    if (paymentDetails) invoice.paymentDetails = paymentDetails;

    await invoice.save();

    // Update customer outstanding if customer exists
    if (invoice.customer) {
      const customer = await Customer.findById(invoice.customer);
      if (customer) {
        customer.outstandingBalance = customer.outstandingBalance - oldBalance + newBalance;
        await customer.save();
      }
    }

    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/invoices/:id
// @desc    Delete invoice (return inventory, reverse balance, delete ledger)
// @access  Private
router.delete('/:id', async (req, res) => {
  let session = null;

  try {
    // Get invoice with all populated data
    const invoice = await Invoice.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('customer')
      .populate('items.product')
      .populate('items.batch');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    // Check if invoice has any returns - prevent deletion if fully/partially returned
    const hasReturns = invoice.items.some(item => (item.returnedQuantity || 0) > 0);
    if (hasReturns || invoice.isReturned || invoice.partiallyReturned) {
      return res.status(400).json({
        message: 'Cannot delete invoice with returns. Please delete the return entries first.'
      });
    }

    // Start transaction
    session = await Invoice.startSession();
    session.startTransaction();

    // Return inventory for all items
    for (const item of invoice.items) {
      if (item.batch && item.quantity > 0) {
        await addBatchStock(item.batch._id, item.quantity, session);
      }
      // Un-mark serial number as sold so it can be invoiced again
      if (item.serialNumber && item.product) {
        await Product.findByIdAndUpdate(
          item.product._id || item.product,
          { $pull: { soldSerialNumbers: item.serialNumber } },
          { session }
        );
      }
    }

    // Reverse customer balance
    if (invoice.customer && invoice.balanceAmount > 0) {
      const customer = await Customer.findById(invoice.customer._id);
      if (customer) {
        customer.outstandingBalance -= invoice.balanceAmount;
        await customer.save({ session });
      }
    }

    // Delete ledger entries
    if (invoice.ledgerEntries && invoice.ledgerEntries.length > 0) {
      await Ledger.deleteMany({ _id: { $in: invoice.ledgerEntries } }, { session });
    }

    // Delete the invoice
    await Invoice.findByIdAndDelete(invoice._id, { session });

    // Commit transaction
    await session.commitTransaction();

    res.json({ message: 'Invoice deleted successfully' });

  } catch (error) {
    if (session) {
      await session.abortTransaction();
    }
    console.error('Invoice deletion error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) {
      session.endSession();
    }
  }
});

// @route   POST /api/invoices/:id/payments
// @desc    Add a new payment to invoice
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

    // Get invoice with tenant isolation
    const invoice = await Invoice.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('customer');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    // Validate payment amount doesn't exceed balance
    if (amount > invoice.balanceAmount) {
      return res.status(400).json({
        message: `Payment amount (₹${amount}) cannot exceed balance amount (₹${invoice.balanceAmount})`
      });
    }

    // Start transaction
    session = await Invoice.startSession();
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
          account: paymentMethod === 'CASH' ? 'CASH' : 'BANK',
          type: 'DEBIT',
          amount: amount,
          description: `Payment received for ${invoice.invoiceNumber} via ${paymentMethod}`
        },
        {
          account: 'ACCOUNTS_RECEIVABLE',
          type: 'CREDIT',
          amount: amount,
          party: 'CUSTOMER',
          partyId: invoice.customer._id,
          partyModel: 'Customer',
          partyName: invoice.customer.name || invoice.customerName,
          description: `Payment received for ${invoice.invoiceNumber}`
        }
      ],
      {
        referenceType: 'PAYMENT',
        referenceId: invoice._id,
        referenceModel: 'Invoice',
        referenceNumber: invoice.invoiceNumber
      },
      session
    );

    // Store both ledger entry IDs (debit and credit)
    payment.ledgerEntries = ledgerEntries.map(entry => entry._id);

    // Initialize payments array if it doesn't exist (for old invoices)
    if (!invoice.payments) {
      invoice.payments = [];
    }

    // Initialize paidAmount and balanceAmount if they don't exist (for old invoices)
    if (invoice.paidAmount === undefined || invoice.paidAmount === null) {
      invoice.paidAmount = 0;
    }
    if (invoice.balanceAmount === undefined || invoice.balanceAmount === null) {
      invoice.balanceAmount = invoice.grandTotal;
    }

    // Add payment to invoice
    invoice.payments.push(payment);

    // Update invoice totals
    const oldPaidAmount = invoice.paidAmount;
    const oldBalanceAmount = invoice.balanceAmount;

    invoice.paidAmount = oldPaidAmount + amount;
    invoice.balanceAmount = oldBalanceAmount - amount;
    invoice.paymentStatus = invoice.balanceAmount <= 0 ? 'PAID' : 'PARTIAL';

    await invoice.save({ session });

    // Update customer balance (fetch within session to avoid race conditions)
    const Customer = (await import('../models/Customer.js')).default;
    const customer = await Customer.findById(invoice.customer._id).session(session);
    if (customer) {
      customer.outstandingBalance -= amount; // Reduce customer balance (they owe us less)
      await customer.save({ session });
    }

    // Commit transaction
    await session.commitTransaction();

    res.status(201).json({
      success: true,
      payment: invoice.payments[invoice.payments.length - 1],
      invoice: {
        paidAmount: invoice.paidAmount,
        balanceAmount: invoice.balanceAmount,
        paymentStatus: invoice.paymentStatus
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

// @route   PUT /api/invoices/:id/payments/:paymentId
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

    // Get invoice with tenant isolation
    const invoice = await Invoice.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('customer');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    // Initialize payments array if it doesn't exist (for old invoices)
    if (!invoice.payments) {
      invoice.payments = [];
    }

    // Find the payment
    const payment = invoice.payments.id(req.params.paymentId);
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    // Calculate what the new balance would be
    const oldPaymentAmount = payment.amount;
    const newPaymentAmount = amount !== undefined ? amount : oldPaymentAmount;
    const amountDifference = newPaymentAmount - oldPaymentAmount;

    // Check if new amount is valid
    const currentBalanceWithoutThisPayment = invoice.balanceAmount + oldPaymentAmount;
    if (newPaymentAmount > currentBalanceWithoutThisPayment) {
      return res.status(400).json({
        message: `Payment amount (₹${newPaymentAmount}) cannot exceed available balance (₹${currentBalanceWithoutThisPayment})`
      });
    }

    // Start transaction
    session = await Invoice.startSession();
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
          account: payment.paymentMethod === 'CASH' ? 'CASH' : 'BANK',
          type: 'DEBIT',
          amount: payment.amount,
          description: `Payment received for ${invoice.invoiceNumber} via ${payment.paymentMethod}`
        },
        {
          account: 'ACCOUNTS_RECEIVABLE',
          type: 'CREDIT',
          amount: payment.amount,
          party: 'CUSTOMER',
          partyId: invoice.customer._id,
          partyModel: 'Customer',
          partyName: invoice.customer.name || invoice.customerName,
          description: `Payment received for ${invoice.invoiceNumber}`
        }
      ],
      {
        referenceType: 'PAYMENT',
        referenceId: invoice._id,
        referenceModel: 'Invoice',
        referenceNumber: invoice.invoiceNumber
      },
      session
    );

    // Store both ledger entry IDs (debit and credit)
    payment.ledgerEntries = ledgerEntries.map(entry => entry._id);

    // Initialize paidAmount and balanceAmount if they don't exist (for old invoices)
    if (invoice.paidAmount === undefined || invoice.paidAmount === null) {
      invoice.paidAmount = 0;
    }
    if (invoice.balanceAmount === undefined || invoice.balanceAmount === null) {
      invoice.balanceAmount = invoice.grandTotal;
    }

    // Update invoice totals
    invoice.paidAmount += amountDifference;
    invoice.balanceAmount -= amountDifference;
    invoice.paymentStatus = invoice.balanceAmount <= 0 ? 'PAID' : (invoice.paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    await invoice.save({ session });

    // Update customer balance (fetch within session to avoid race conditions)
    const Customer = (await import('../models/Customer.js')).default;
    const customer = await Customer.findById(invoice.customer._id).session(session);
    if (customer) {
      customer.outstandingBalance -= amountDifference;
      await customer.save({ session });
    }

    // Commit transaction
    await session.commitTransaction();

    res.json({
      success: true,
      payment,
      invoice: {
        paidAmount: invoice.paidAmount,
        balanceAmount: invoice.balanceAmount,
        paymentStatus: invoice.paymentStatus
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

// @route   DELETE /api/invoices/:id/payments/:paymentId
// @desc    Delete a payment
// @access  Private
router.delete('/:id/payments/:paymentId', async (req, res) => {
  let session = null;

  try {
    // Get invoice with tenant isolation
    const invoice = await Invoice.findOne(addOrgFilter(req, { _id: req.params.id }))
      .populate('customer');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    // Initialize payments array if it doesn't exist (for old invoices)
    if (!invoice.payments) {
      invoice.payments = [];
    }

    // Find the payment
    const payment = invoice.payments.id(req.params.paymentId);
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    const paymentAmount = payment.amount;

    // Start transaction
    session = await Invoice.startSession();
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
    invoice.payments.pull(req.params.paymentId);

    // Initialize paidAmount and balanceAmount if they don't exist (for old invoices)
    if (invoice.paidAmount === undefined || invoice.paidAmount === null) {
      invoice.paidAmount = 0;
    }
    if (invoice.balanceAmount === undefined || invoice.balanceAmount === null) {
      invoice.balanceAmount = invoice.grandTotal;
    }

    // Update invoice totals
    invoice.paidAmount -= paymentAmount;
    invoice.balanceAmount += paymentAmount;
    invoice.paymentStatus = invoice.balanceAmount >= invoice.grandTotal ? 'UNPAID' : (invoice.paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

    await invoice.save({ session });

    // Update customer balance (fetch within session to avoid race conditions)
    const Customer = (await import('../models/Customer.js')).default;
    const customer = await Customer.findById(invoice.customer._id).session(session);
    if (customer) {
      customer.outstandingBalance += paymentAmount;
      await customer.save({ session });
    }

    // Commit transaction
    await session.commitTransaction();

    res.json({
      success: true,
      invoice: {
        paidAmount: invoice.paidAmount,
        balanceAmount: invoice.balanceAmount,
        paymentStatus: invoice.paymentStatus
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

export default router;
