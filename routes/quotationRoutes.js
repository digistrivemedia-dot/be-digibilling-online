import express from 'express';
import Quotation from '../models/Quotation.js';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import Batch from '../models/Batch.js';
import Customer from '../models/Customer.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';
import { calculateItemGST, calculateTotals } from '../utils/gstCalculations.js';
import { getBatchesForSale, deductBatchStock, calculateCOGS } from '../utils/inventoryManager.js';
import { postSalesToLedger } from '../utils/ledgerHelper.js';

const router = express.Router();

router.use(protect);
router.use(tenantIsolation);

// Helper: calculate item totals (supports item-level discountAmount)
const calcItem = (item, taxType) => {
    const grossAmount = (item.sellingPrice || 0) * (item.quantity || 0);
    const discountAmount = item.discountAmount || 0;
    const taxableAmount = grossAmount - discountAmount;
    const taxAmt = taxType === 'IGST'
        ? (taxableAmount * (item.gstRate || 0)) / 100
        : (taxableAmount * (item.gstRate || 0)) / 100;
    const half = taxAmt / 2;
    return {
        discountAmount,
        taxableAmount,
        taxAmount: taxAmt,
        cgst: taxType === 'CGST_SGST' ? half : 0,
        sgst: taxType === 'CGST_SGST' ? half : 0,
        igst: taxType === 'IGST' ? taxAmt : 0,
        totalAmount: taxableAmount + taxAmt,
    };
};

// ── GET /api/quotations ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const query = addOrgFilter(req);
        const { status, customer, startDate, endDate } = req.query;
        if (status) query.status = status;
        if (customer) query.customer = customer;
        if (startDate && endDate) {
            query.quotationDate = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }
        const quotations = await Quotation.find(query)
            .populate('customer', 'name phone')
            .sort({ createdAt: -1 });
        res.json(quotations);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── GET /api/quotations/stats ───────────────────────────────────────────────
router.get('/stats', async (req, res) => {
    try {
        const orgFilter = addOrgFilter(req);
        const [total, draft, sent, accepted] = await Promise.all([
            Quotation.countDocuments(orgFilter),
            Quotation.countDocuments({ ...orgFilter, status: 'DRAFT' }),
            Quotation.countDocuments({ ...orgFilter, status: 'SENT' }),
            Quotation.countDocuments({ ...orgFilter, status: 'ACCEPTED' }),
        ]);
        res.json({ total, draft, sent, accepted });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── GET /api/quotations/:id ─────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const q = await Quotation.findOne(addOrgFilter(req, { _id: req.params.id }))
            .populate('customer')
            .populate('items.product')
            .populate('items.batch');
        if (!q) return res.status(404).json({ message: 'Quotation not found' });
        res.json(q);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── POST /api/quotations ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        const { items = [], ...data } = req.body;

        if (items.length === 0) {
            return res.status(400).json({ message: 'Please add at least one item' });
        }

        const taxType = data.taxType || 'CGST_SGST';

        // Process items: calculate GST for each
        const processedItems = items.map(item => {
            const gstCalc = calcItem(item, taxType);
            if (item.itemType === 'service') {
                return {
                    itemType: 'service',
                    serviceName: item.serviceName || '',
                    sacCode: item.sacCode || '',
                    quantity: item.quantity,
                    unit: item.unit || 'NOS',
                    sellingPrice: item.sellingPrice,
                    gstRate: item.gstRate || 0,
                    ...gstCalc,
                };
            }
            // product item
            return {
                itemType: 'product',
                product: item.product || undefined,
                productName: item.productName || item.serviceName || '',
                batch: item.batch || undefined,
                batchNo: item.batchNo || '',
                expiryDate: item.expiryDate || undefined,
                hsnCode: item.hsnCode || '',
                quantity: item.quantity,
                unit: item.unit || '',
                sellingPrice: item.sellingPrice,
                mrp: item.mrp,
                gstRate: item.gstRate || 0,
                ...gstCalc,
            };
        });

        // Recalculate totals server-side (subtotal = pre-discount, discount = sum of item discounts)
        const subtotal = processedItems.reduce((s, i) => s + (i.sellingPrice || 0) * (i.quantity || 0), 0);
        const totalItemDiscount = processedItems.reduce((s, i) => s + (i.discountAmount || 0), 0);
        const totalTax = processedItems.reduce((s, i) => s + i.taxAmount, 0);
        const totalCGST = taxType === 'CGST_SGST' ? processedItems.reduce((s, i) => s + (i.cgst || 0), 0) : 0;
        const totalSGST = taxType === 'CGST_SGST' ? processedItems.reduce((s, i) => s + (i.sgst || 0), 0) : 0;
        const totalIGST = taxType === 'IGST' ? processedItems.reduce((s, i) => s + (i.igst || 0), 0) : 0;
        const grandTotalRaw = subtotal - totalItemDiscount + totalTax;
        const roundOff = Math.round(grandTotalRaw) - grandTotalRaw;
        const grandTotal = Math.round(grandTotalRaw);

        const quotation = await Quotation.create({
            organizationId: req.organizationId || req.user.organizationId,
            userId: req.user._id,
            customer: data.customer || undefined,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerAddress: data.customerAddress,
            customerCity: data.customerCity,
            customerState: data.customerState,
            customerGstin: data.customerGstin,
            quotationDate: data.quotationDate || new Date(),
            validityDate: data.validityDate || undefined,
            status: data.status || 'DRAFT',
            items: processedItems,
            taxType,
            subtotal,
            totalTax,
            totalCGST,
            totalSGST,
            totalIGST,
            discount: totalItemDiscount,
            roundOff,
            grandTotal,
            notes: data.notes,
            terms: data.terms,
        });

        res.status(201).json(quotation);
    } catch (err) {
        console.error('Quotation creation error:', err);
        res.status(500).json({ message: err.message });
    }
});

// ── PUT /api/quotations/:id ─────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
    try {
        const { items, ...data } = req.body;
        const existing = await Quotation.findOne(addOrgFilter(req, { _id: req.params.id }));
        if (!existing) return res.status(404).json({ message: 'Quotation not found' });

        // If no items provided, this is a simple field update (e.g., status, convertedToInvoiceId)
        if (!items || items.length === 0) {
            const updateFields = {};
            if (data.status) updateFields.status = data.status;
            if (data.convertedToInvoiceId) updateFields.convertedToInvoiceId = data.convertedToInvoiceId;
            if (data.notes !== undefined) updateFields.notes = data.notes;
            if (data.terms !== undefined) updateFields.terms = data.terms;

            const updated = await Quotation.findByIdAndUpdate(
                existing._id,
                { $set: updateFields },
                { new: true }
            );
            return res.json(updated);
        }

        // Full update with items recalculation
        const taxType = data.taxType || existing.taxType || 'CGST_SGST';

        const processedItems = items.map(item => {
            const gstCalc = calcItem(item, taxType);
            if (item.itemType === 'service') {
                return {
                    itemType: 'service',
                    serviceName: item.serviceName || '',
                    sacCode: item.sacCode || '',
                    quantity: item.quantity,
                    unit: item.unit || 'NOS',
                    sellingPrice: item.sellingPrice,
                    gstRate: item.gstRate || 0,
                    ...gstCalc,
                };
            }
            return {
                itemType: 'product',
                product: item.product || undefined,
                productName: item.productName || '',
                batch: item.batch || undefined,
                batchNo: item.batchNo || '',
                expiryDate: item.expiryDate || undefined,
                hsnCode: item.hsnCode || '',
                quantity: item.quantity,
                unit: item.unit || '',
                sellingPrice: item.sellingPrice,
                mrp: item.mrp,
                gstRate: item.gstRate || 0,
                ...gstCalc,
            };
        });

        const subtotal = processedItems.reduce((s, i) => s + (i.sellingPrice || 0) * (i.quantity || 0), 0);
        const totalItemDiscount = processedItems.reduce((s, i) => s + (i.discountAmount || 0), 0);
        const totalTax = processedItems.reduce((s, i) => s + i.taxAmount, 0);
        const totalCGST = taxType === 'CGST_SGST' ? processedItems.reduce((s, i) => s + (i.cgst || 0), 0) : 0;
        const totalSGST = taxType === 'CGST_SGST' ? processedItems.reduce((s, i) => s + (i.sgst || 0), 0) : 0;
        const totalIGST = taxType === 'IGST' ? processedItems.reduce((s, i) => s + (i.igst || 0), 0) : 0;
        const grandTotalRaw = subtotal - totalItemDiscount + totalTax;
        const roundOff = Math.round(grandTotalRaw) - grandTotalRaw;
        const grandTotal = Math.round(grandTotalRaw);

        const updated = await Quotation.findByIdAndUpdate(
            existing._id,
            {
                $set: {
                    customer: data.customer || existing.customer,
                    customerName: data.customerName || existing.customerName,
                    customerPhone: data.customerPhone ?? existing.customerPhone,
                    customerAddress: data.customerAddress ?? existing.customerAddress,
                    customerCity: data.customerCity ?? existing.customerCity,
                    customerState: data.customerState ?? existing.customerState,
                    customerGstin: data.customerGstin ?? existing.customerGstin,
                    quotationDate: data.quotationDate || existing.quotationDate,
                    validityDate: data.validityDate || existing.validityDate,
                    status: data.status || existing.status,
                    items: processedItems,
                    taxType,
                    subtotal,
                    totalTax,
                    totalCGST,
                    totalSGST,
                    totalIGST,
                    discount: totalItemDiscount,
                    roundOff,
                    grandTotal,
                    notes: data.notes ?? existing.notes,
                    terms: data.terms ?? existing.terms,
                }
            },
            { new: true }
        );

        res.json(updated);
    } catch (err) {
        console.error('Quotation update error:', err);
        res.status(500).json({ message: err.message });
    }
});

// ── DELETE /api/quotations/:id ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const q = await Quotation.findOneAndDelete(addOrgFilter(req, { _id: req.params.id }));
        if (!q) return res.status(404).json({ message: 'Quotation not found' });
        res.json({ message: 'Quotation deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── POST /api/quotations/:id/convert ────────────────────────────────────────
// Converts an accepted quotation into a real Invoice atomically.
// - Service items: GST calculation only, no stock deduction
// - Product items: FIFO batch deduction + GST, same as normal invoice creation
// - Full MongoDB transaction: if anything fails, everything rolls back
router.post('/:id/convert', async (req, res) => {
    let session = null;
    try {
        const orgId = req.organizationId || req.user.organizationId;

        // ── 1. Load and validate the quotation ──────────────────────────────
        const quotation = await Quotation.findOne(addOrgFilter(req, { _id: req.params.id }));
        if (!quotation) return res.status(404).json({ message: 'Quotation not found' });

        // Prevent double-conversion
        if (quotation.convertedToInvoiceId) {
            return res.status(409).json({
                message: 'This quotation has already been converted to an invoice.',
                invoiceId: quotation.convertedToInvoiceId
            });
        }

        if (quotation.items.length === 0) {
            return res.status(400).json({ message: 'Quotation has no items to convert.' });
        }

        // ── 2. Load customer record (optional — quotation may have no linked customer) ──
        let customer = null;
        if (quotation.customer) {
            customer = await Customer.findOne(addOrgFilter(req, { _id: quotation.customer }));
        }

        const taxType = quotation.taxType || 'CGST_SGST';

        // ── 3. Pre-process all items (reads outside the transaction) ─────────
        // Build batchDeductions[] plan and processedItems[] before acquiring locks.
        const processedItems = [];
        const batchDeductions = [];

        for (let i = 0; i < quotation.items.length; i++) {
            const item = quotation.items[i];

            // ── Service item — no stock, straight GST mapping ────────────────
            if (item.itemType === 'service') {
                const itemWithGST = calculateItemGST({
                    quantity: item.quantity,
                    sellingPrice: item.sellingPrice,
                    discount: 0,
                    gstRate: item.gstRate || 0
                }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

                processedItems.push({
                    itemType: 'service',
                    product: undefined,
                    productName: item.serviceName || item.productName || 'Service',
                    serviceName: item.serviceName || item.productName || 'Service',
                    sacCode: item.sacCode || '',
                    quantity: item.quantity,
                    unit: item.unit || 'NOS',
                    sellingPrice: item.sellingPrice,
                    gstRate: item.gstRate || 0,
                    mrp: item.sellingPrice,
                    purchasePrice: 0,
                    ...itemWithGST
                });
                continue;
            }

            // ── Product item — validate product and handle stock ─────────────
            if (!item.product) {
                return res.status(400).json({ message: `Item #${i + 1} has no product linked. Cannot convert.` });
            }

            const product = await Product.findOne(addOrgFilter(req, { _id: item.product }));
            if (!product) {
                return res.status(400).json({ message: `Product for item #${i + 1} not found. It may have been deleted.` });
            }

            // Non-inventory product — no stock deduction
            if (!product.trackInventory) {
                const itemWithGST = calculateItemGST({
                    quantity: item.quantity,
                    sellingPrice: item.sellingPrice || product.sellingPrice,
                    discount: 0,
                    gstRate: item.gstRate ?? product.gstRate
                }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

                processedItems.push({
                    itemType: 'product',
                    product: product._id,
                    productName: product.name,
                    hsnCode: product.hsnCode,
                    quantity: item.quantity,
                    unit: product.unit,
                    sellingPrice: item.sellingPrice || product.sellingPrice,
                    mrp: item.sellingPrice || product.sellingPrice,
                    purchasePrice: product.purchasePrice || 0,
                    ...itemWithGST
                });
                continue;
            }

            // Inventory-tracked product — check stock
            if (product.stockQuantity < item.quantity) {
                return res.status(400).json({
                    message: `Insufficient stock for "${product.name}". Available: ${product.stockQuantity}, Required: ${item.quantity}`
                });
            }

            // Use stored batch from quotation if it still exists and has stock
            if (item.batch) {
                const batch = await Batch.findOne({
                    _id: item.batch,
                    organizationId: orgId,
                    product: product._id,
                    isActive: true
                });

                if (batch && batch.quantity >= item.quantity) {
                    const itemWithGST = calculateItemGST({
                        quantity: item.quantity,
                        sellingPrice: item.sellingPrice || batch.sellingPrice,
                        discount: 0,
                        gstRate: batch.gstRate
                    }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

                    batchDeductions.push({ batchId: batch._id, quantity: item.quantity });
                    processedItems.push({
                        itemType: 'product',
                        product: product._id,
                        productName: product.name,
                        batch: batch._id,
                        batchNo: batch.batchNo,
                        expiryDate: batch.expiryDate,
                        hsnCode: product.hsnCode,
                        quantity: item.quantity,
                        unit: product.unit,
                        sellingPrice: item.sellingPrice || batch.sellingPrice,
                        mrp: batch.mrp,
                        purchasePrice: batch.purchasePrice || 0,
                        ...itemWithGST
                    });
                    continue;
                }
            }

            // Fall back to FIFO if stored batch is gone / insufficient
            const batchesForSale = await getBatchesForSale(
                product._id, req.user._id, orgId, item.quantity
            );

            for (const batchSale of batchesForSale) {
                const itemWithGST = calculateItemGST({
                    quantity: batchSale.quantity,
                    sellingPrice: item.sellingPrice || batchSale.sellingPrice,
                    discount: 0,
                    gstRate: batchSale.gstRate
                }, taxType, 'invoice', shopSettings?.gstScheme || 'REGULAR');

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
                    sellingPrice: item.sellingPrice || batchSale.sellingPrice,
                    mrp: batchSale.mrp,
                    purchasePrice: batchSale.purchasePrice || 0,
                    ...itemWithGST
                });
            }
        }

        // ── 4. Calculate invoice totals ──────────────────────────────────────
        const totals = calculateTotals(processedItems, {}, quotation.discount || 0, shopSettings?.gstScheme || 'REGULAR');
        const balanceAmount = totals.grandTotal; // invoice starts as UNPAID

        // ── 5. START TRANSACTION — all writes are atomic ─────────────────────
        session = await Invoice.startSession();
        session.startTransaction();

        // Step 5a: Deduct batch stock
        for (const d of batchDeductions) {
            await deductBatchStock(d.batchId, d.quantity, session);
        }

        // Step 5b: Create the Invoice document
        const invoiceArr = await Invoice.create([{
            userId: req.user._id,
            organizationId: orgId,
            customer: quotation.customer || undefined,
            customerName: quotation.customerName,
            customerPhone: quotation.customerPhone,
            customerAddress: quotation.customerAddress,
            customerCity: quotation.customerCity,
            customerState: quotation.customerState,
            customerGstin: quotation.customerGstin,
            invoiceDate: new Date(),
            invoiceType: 'tax-invoice',
            items: processedItems,
            taxType,
            ...totals,
            paymentStatus: 'UNPAID',
            paymentMethod: 'CASH',
            paidAmount: 0,
            balanceAmount,
            notes: quotation.notes,
            cogs: 0  // COGS calculated separately if needed
        }], { session });
        const invoice = invoiceArr[0];

        // Step 5c: Update customer outstanding balance
        if (customer) {
            customer.outstandingBalance = (customer.outstandingBalance || 0) + balanceAmount;
            await customer.save({ session });
        }

        // Step 5d: Post ledger entries for the sale
        const ledgerEntries = await postSalesToLedger(
            invoice, req.user._id, orgId, session
        );
        invoice.ledgerEntries = ledgerEntries.map(e => e._id);
        await invoice.save({ session });

        // Step 5e: Mark quotation as ACCEPTED + store invoice reference
        quotation.status = 'ACCEPTED';
        quotation.convertedToInvoiceId = invoice._id;
        await quotation.save({ session });

        // ── 6. COMMIT ────────────────────────────────────────────────────────
        await session.commitTransaction();

        res.status(201).json(invoice);

    } catch (err) {
        if (session) await session.abortTransaction();
        console.error('Quotation convert error:', err);
        res.status(500).json({ message: err.message });
    } finally {
        if (session) session.endSession();
    }
});

export default router;
