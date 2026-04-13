import mongoose from 'mongoose';

const quotationItemSchema = new mongoose.Schema({
    itemType: {
        type: String,
        enum: ['product', 'service'],
        default: 'product'
    },
    // Product fields (when itemType === 'product')
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
        // NOT required — service items have no product
    },
    productName: String,
    batch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Batch'
    },
    batchNo: String,
    expiryDate: Date,
    hsnCode: String,
    // Service fields (when itemType === 'service')
    serviceName: String,
    sacCode: String,
    // Common fields
    quantity: { type: Number, required: true, default: 1 },
    unit: { type: String, default: 'NOS' },
    sellingPrice: { type: Number, required: true, default: 0 },
    mrp: Number,
    discount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    gstRate: { type: Number, required: true, default: 0 },
    taxableAmount: Number,
    taxAmount: Number,
    cgst: Number,
    sgst: Number,
    igst: Number,
    totalAmount: Number,
});

const quotationSchema = new mongoose.Schema({
    organizationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Organization',
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    quotationNumber: { type: String },
    customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer'
    },
    customerName: { type: String, required: true },
    customerPhone: String,
    customerAddress: String,
    customerCity: String,
    customerState: String,
    customerGstin: String,
    quotationDate: { type: Date, default: Date.now },
    validityDate: Date,
    status: {
        type: String,
        enum: ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'],
        default: 'DRAFT'
    },
    items: [quotationItemSchema],
    taxType: {
        type: String,
        enum: ['CGST_SGST', 'IGST'],
        default: 'CGST_SGST'
    },
    subtotal: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    totalCGST: { type: Number, default: 0 },
    totalSGST: { type: Number, default: 0 },
    totalIGST: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    notes: String,
    terms: String,
    // Set when this quotation is converted to an invoice — used as a double-conversion guard
    convertedToInvoiceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Invoice',
        default: null
    },
}, { timestamps: true });

// Indexes
quotationSchema.index({ organizationId: 1, quotationDate: -1 });
quotationSchema.index({ organizationId: 1, quotationNumber: 1 }, { unique: true, sparse: true });
quotationSchema.index({ organizationId: 1, customer: 1 });
quotationSchema.index({ organizationId: 1, status: 1 });

// Auto-generate quotation number
quotationSchema.pre('save', async function (next) {
    if (this.isNew && !this.quotationNumber) {
        const Counter = mongoose.model('Counter');
        const Organization = mongoose.model('Organization');

        const org = await Organization.findById(this.organizationId).select('organizationName');
        const orgInitials = org
            ? org.organizationName.trim().substring(0, 2).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'XX'
            : 'XX';

        const date = this.quotationDate || new Date();
        const year = date.getFullYear();

        const sequence = await Counter.getNextSequence(this.organizationId, 'quotation', String(year));
        this.quotationNumber = `QT-${year}-${orgInitials}-${String(sequence).padStart(6, '0')}`;
    }
    next();
});

const Quotation = mongoose.model('Quotation', quotationSchema);
export default Quotation;
