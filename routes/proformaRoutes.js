import express from 'express';
import ProformaInvoice from '../models/ProformaInvoice.js';
import ShopSettings from '../models/ShopSettings.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';

const router = express.Router();
router.use(protect);
router.use(tenantIsolation);

// ── Helper: calculate item GST ─────────────────────────────────────────────
const calcItem = (item, taxType, gstScheme = 'REGULAR') => {
    const gross = (item.sellingPrice || 0) * (item.quantity || 1);
    const discountAmt = item.discountAmount || 0;
    const taxable = gross - discountAmt;
    // Composition scheme: no GST charged to customer
    const taxAmt = gstScheme === 'COMPOSITION' ? 0 : (taxable * (item.gstRate || 0)) / 100;
    const half = taxAmt / 2;
    return {
        discountAmount: discountAmt,
        taxableAmount: taxable,
        taxAmount: taxAmt,
        cgst: taxType === 'CGST_SGST' ? half : 0,
        sgst: taxType === 'CGST_SGST' ? half : 0,
        igst: taxType === 'IGST' ? taxAmt : 0,
        totalAmount: taxable + taxAmt,
    };
};

const processItems = (items = [], taxType = 'CGST_SGST', gstScheme = 'REGULAR') => {
    return items.map(item => {
        const gstCalc = calcItem(item, taxType, gstScheme);
        if (item.itemType === 'service') {
            return {
                itemType: 'service',
                serviceName: item.serviceName || '',
                sacCode: item.sacCode || '',
                quantity: item.quantity || 1,
                unit: item.unit || 'NOS',
                sellingPrice: item.sellingPrice || 0,
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
            hsnCode: item.hsnCode || '',
            quantity: item.quantity || 1,
            unit: item.unit || 'PCS',
            sellingPrice: item.sellingPrice || 0,
            mrp: item.mrp || undefined,
            gstRate: item.gstRate || 0,
            ...gstCalc,
        };
    });
};

const calcTotals = (processedItems, taxType, gstScheme = 'REGULAR') => {
    // subtotal = pre-discount (sum of price × qty), discount = sum of item discounts
    const subtotal = processedItems.reduce((s, i) => s + (i.sellingPrice || 0) * (i.quantity || 1), 0);
    const totalItemDiscount = processedItems.reduce((s, i) => s + (i.discountAmount || 0), 0);
    // Composition scheme: no GST in totals
    const totalTax = gstScheme === 'COMPOSITION' ? 0 : processedItems.reduce((s, i) => s + i.taxAmount, 0);
    const totalCGST = gstScheme === 'COMPOSITION' ? 0 : (taxType === 'CGST_SGST' ? processedItems.reduce((s, i) => s + (i.cgst || 0), 0) : 0);
    const totalSGST = gstScheme === 'COMPOSITION' ? 0 : (taxType === 'CGST_SGST' ? processedItems.reduce((s, i) => s + (i.sgst || 0), 0) : 0);
    const totalIGST = gstScheme === 'COMPOSITION' ? 0 : (taxType === 'IGST' ? processedItems.reduce((s, i) => s + (i.igst || 0), 0) : 0);
    const grandTotalRaw = subtotal - totalItemDiscount + totalTax;
    const roundOff = Math.round(grandTotalRaw) - grandTotalRaw;
    const grandTotal = Math.round(grandTotalRaw);
    return { subtotal, discount: totalItemDiscount, totalTax, totalCGST, totalSGST, totalIGST, roundOff, grandTotal };
};

// ── GET /api/proforma-invoices ─────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { status, search } = req.query;
        const filter = addOrgFilter(req, {});
        if (status) filter.status = status;
        if (search) {
            filter.$or = [
                { proformaNumber: { $regex: search, $options: 'i' } },
                { customerName: { $regex: search, $options: 'i' } },
            ];
        }
        const docs = await ProformaInvoice.find(filter)
            .populate('customer', 'name phone')
            .sort({ proformaDate: -1 })
            .lean();
        res.json(docs);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── GET /api/proforma-invoices/:id ─────────────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const doc = await ProformaInvoice
            .findOne(addOrgFilter(req, { _id: req.params.id }))
            .populate('customer')
            .populate('items.product', 'name')
            .populate('items.batch', 'batchNo expiryDate');
        if (!doc) return res.status(404).json({ message: 'Proforma invoice not found' });
        res.json(doc);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── POST /api/proforma-invoices ────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        const { items = [], ...data } = req.body;

        if (items.length === 0) {
            return res.status(400).json({ message: 'Please add at least one item' });
        }

        const taxType = data.taxType || 'CGST_SGST';
        // Fetch shop settings to determine GST scheme (REGULAR / COMPOSITION)
        const shopSettings = await ShopSettings.findOne({ organizationId: req.organizationId || req.user.organizationId }).lean();
        const gstScheme = shopSettings?.gstScheme || 'REGULAR';
        const processedItems = processItems(items, taxType, gstScheme);
        const totals = calcTotals(processedItems, taxType, gstScheme);

        const doc = new ProformaInvoice({
            organizationId: req.organizationId || req.user.organizationId,
            userId: req.user._id,
            customer: data.customer || undefined,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerAddress: data.customerAddress,
            customerCity: data.customerCity,
            customerState: data.customerState,
            customerGstin: data.customerGstin,
            proformaDate: data.proformaDate || new Date(),
            status: data.status || 'DRAFT',
            items: processedItems,
            taxType,
            ...totals,
            notes: data.notes,
            terms: data.terms,
            // PO details
            poNumber: data.poNumber,
            poDate: data.poDate,
            // Additional details
            eWayBillNumber: data.eWayBillNumber,
            deliveryNote: data.deliveryNote,
            referenceNo: data.referenceNo,
            otherReferences: data.otherReferences,
            termsOfDelivery: data.termsOfDelivery,
            destination: data.destination,
        });

        await doc.save();
        res.status(201).json(doc);
    } catch (err) {
        console.error('Proforma invoice creation error:', err);
        res.status(400).json({ message: err.message });
    }
});

// ── PUT /api/proforma-invoices/:id ─────────────────────────────────────────
router.put('/:id', async (req, res) => {
    try {
        const { items, ...data } = req.body;
        const existing = await ProformaInvoice.findOne(addOrgFilter(req, { _id: req.params.id }));
        if (!existing) return res.status(404).json({ message: 'Proforma invoice not found' });

        // If no items provided, this is a simple field update (e.g., status, convertedToInvoiceId)
        if (!items || items.length === 0) {
            const updateFields = {};
            if (data.status) updateFields.status = data.status;
            if (data.convertedToInvoiceId) updateFields.convertedToInvoiceId = data.convertedToInvoiceId;
            if (data.notes !== undefined) updateFields.notes = data.notes;
            if (data.terms !== undefined) updateFields.terms = data.terms;

            const updated = await ProformaInvoice.findByIdAndUpdate(
                existing._id,
                { $set: updateFields },
                { new: true }
            );
            return res.json(updated);
        }

        // Full update with items recalculation
        const taxType = data.taxType || existing.taxType || 'CGST_SGST';
        // Fetch shop settings to determine GST scheme (REGULAR / COMPOSITION)
        const shopSettings = await ShopSettings.findOne({ organizationId: req.organizationId || req.user.organizationId }).lean();
        const gstScheme = shopSettings?.gstScheme || 'REGULAR';
        const processedItems = processItems(items, taxType, gstScheme);
        const totals = calcTotals(processedItems, taxType, gstScheme);

        const updated = await ProformaInvoice.findByIdAndUpdate(
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
                    proformaDate: data.proformaDate || existing.proformaDate,
                    status: data.status || existing.status,
                    items: processedItems,
                    taxType,
                    ...totals,
                    notes: data.notes ?? existing.notes,
                    terms: data.terms ?? existing.terms,
                    // PO details
                    poNumber: data.poNumber ?? existing.poNumber,
                    poDate: data.poDate ?? existing.poDate,
                    // Additional details
                    eWayBillNumber: data.eWayBillNumber ?? existing.eWayBillNumber,
                    deliveryNote: data.deliveryNote ?? existing.deliveryNote,
                    referenceNo: data.referenceNo ?? existing.referenceNo,
                    otherReferences: data.otherReferences ?? existing.otherReferences,
                    termsOfDelivery: data.termsOfDelivery ?? existing.termsOfDelivery,
                    destination: data.destination ?? existing.destination,
                }
            },
            { new: true }
        );

        res.json(updated);
    } catch (err) {
        console.error('Proforma invoice update error:', err);
        res.status(400).json({ message: err.message });
    }
});

// ── DELETE /api/proforma-invoices/:id ──────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const doc = await ProformaInvoice.findOneAndDelete(addOrgFilter(req, { _id: req.params.id }));
        if (!doc) return res.status(404).json({ message: 'Proforma invoice not found' });
        res.json({ message: 'Proforma invoice deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

export default router;
