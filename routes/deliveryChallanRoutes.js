import express from 'express';
import DeliveryChallan from '../models/DeliveryChallan.js';
import ShopSettings from '../models/ShopSettings.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';

const router = express.Router();
router.use(protect);
router.use(tenantIsolation);

// ── Helper: calculate item GST totals ──────────────────────────────────────────
const calcItem = (item, taxType, gstScheme = 'REGULAR') => {
    const gross = (item.sellingPrice || 0) * (item.quantity || 1);
    const discountAmt = item.discountAmount || 0;
    const taxable = gross - discountAmt;
    // Composition scheme: no GST charged to customer
    const taxAmt = (gstScheme === 'COMPOSITION' || taxType === 'NONE') ? 0 : (taxable * (item.gstRate || 0)) / 100;
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

// ── Process items (shared by create & update) ───────────────────────────────
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
                description: item.description || '',
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
            description: item.description || '',
            ...gstCalc,
        };
    });
};

// ── Recalculate document-level totals ──────────────────────────────────────
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

// ── GET /api/delivery-challans ─────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { status, search } = req.query;
        const filter = addOrgFilter(req, {});
        if (status) filter.status = status;
        if (search) {
            filter.$or = [
                { challanNumber: { $regex: search, $options: 'i' } },
                { customerName: { $regex: search, $options: 'i' } },
            ];
        }
        const docs = await DeliveryChallan.find(filter)
            .populate('customer', 'name phone')
            .sort({ challanDate: -1 })
            .lean();
        res.json(docs);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── GET /api/delivery-challans/:id ─────────────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const doc = await DeliveryChallan
            .findOne(addOrgFilter(req, { _id: req.params.id }))
            .populate('customer')
            .populate('items.product', 'name')
            .populate('items.batch', 'batchNo expiryDate');
        if (!doc) return res.status(404).json({ message: 'Delivery challan not found' });
        res.json(doc);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── POST /api/delivery-challans ────────────────────────────────────────────
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

        const doc = new DeliveryChallan({
            organizationId: req.organizationId || req.user.organizationId,
            userId: req.user._id,
            // Customer
            customer: data.customer || undefined,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerAddress: data.customerAddress,
            customerCity: data.customerCity,
            customerState: data.customerState,
            customerGstin: data.customerGstin,
            // Meta
            challanDate: data.challanDate || new Date(),
            status: data.status || 'DRAFT',
            // Items + financials
            items: processedItems,
            taxType,
            ...totals,
            // Transport
            transportMode: data.transportMode,
            transportDocNumber: data.transportDocNumber,
            transportDocDate: data.transportDocDate || undefined,
            vehicleNumber: data.vehicleNumber,
            approxDist: data.approxDist ? Number(data.approxDist) : undefined,
            pos: data.pos,
            supplyDate: data.supplyDate || undefined,
            transporterId: data.transporterId,
            transporterName: data.transporterName,
            // PO
            poNumber: data.poNumber,
            poDate: data.poDate || undefined,
            // Additional
            eWayBillNumber: data.eWayBillNumber,
            deliveryNote: data.deliveryNote,
            referenceNo: data.referenceNo,
            otherReferences: data.otherReferences,
            termsOfDelivery: data.termsOfDelivery,
            destination: data.destination,
            // Notes
            notes: data.notes,
        });

        await doc.save();
        res.status(201).json(doc);
    } catch (err) {
        console.error('Delivery challan creation error:', err);
        res.status(400).json({ message: err.message });
    }
});

// ── PUT /api/delivery-challans/:id ─────────────────────────────────────────
router.put('/:id', async (req, res) => {
    try {
        const { items, ...data } = req.body;
        const existing = await DeliveryChallan.findOne(addOrgFilter(req, { _id: req.params.id }));
        if (!existing) return res.status(404).json({ message: 'Delivery challan not found' });

        // If no items provided, this is a simple field update (e.g., status, convertedToInvoiceId)
        if (!items || items.length === 0) {
            const updateFields = {};
            if (data.status) updateFields.status = data.status;
            if (data.convertedToInvoiceId) updateFields.convertedToInvoiceId = data.convertedToInvoiceId;
            if (data.notes !== undefined) updateFields.notes = data.notes;

            const updated = await DeliveryChallan.findByIdAndUpdate(
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

        const updated = await DeliveryChallan.findByIdAndUpdate(
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
                    challanDate: data.challanDate || existing.challanDate,
                    status: data.status || existing.status,
                    items: processedItems,
                    taxType,
                    ...totals,
                    transportMode: data.transportMode ?? existing.transportMode,
                    transportDocNumber: data.transportDocNumber ?? existing.transportDocNumber,
                    transportDocDate: data.transportDocDate || existing.transportDocDate,
                    vehicleNumber: data.vehicleNumber ?? existing.vehicleNumber,
                    approxDist: data.approxDist !== undefined ? Number(data.approxDist) : existing.approxDist,
                    pos: data.pos ?? existing.pos,
                    supplyDate: data.supplyDate || existing.supplyDate,
                    transporterId: data.transporterId ?? existing.transporterId,
                    transporterName: data.transporterName ?? existing.transporterName,
                    poNumber: data.poNumber ?? existing.poNumber,
                    poDate: data.poDate || existing.poDate,
                    eWayBillNumber: data.eWayBillNumber ?? existing.eWayBillNumber,
                    deliveryNote: data.deliveryNote ?? existing.deliveryNote,
                    referenceNo: data.referenceNo ?? existing.referenceNo,
                    otherReferences: data.otherReferences ?? existing.otherReferences,
                    termsOfDelivery: data.termsOfDelivery ?? existing.termsOfDelivery,
                    destination: data.destination ?? existing.destination,
                    notes: data.notes ?? existing.notes,
                }
            },
            { new: true }
        );

        res.json(updated);
    } catch (err) {
        console.error('Delivery challan update error:', err);
        res.status(400).json({ message: err.message });
    }
});

// ── DELETE /api/delivery-challans/:id ──────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const doc = await DeliveryChallan.findOneAndDelete(addOrgFilter(req, { _id: req.params.id }));
        if (!doc) return res.status(404).json({ message: 'Delivery challan not found' });
        res.json({ message: 'Delivery challan deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

export default router;
