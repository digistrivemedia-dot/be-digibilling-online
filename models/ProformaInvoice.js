import mongoose from 'mongoose';

const proformaItemSchema = new mongoose.Schema({
    itemType: { type: String, enum: ['product', 'service'], default: 'product' },
    // Product fields
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productName: String,
    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch' },
    batchNo: String,
    hsnCode: String,
    // Service fields
    serviceName: String,
    sacCode: String,
    // Common
    quantity: { type: Number, required: true, default: 1 },
    unit: { type: String, default: 'PCS' },
    sellingPrice: { type: Number, required: true, default: 0 },
    mrp: Number,
    discount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    gstRate: { type: Number, default: 0 },
    taxableAmount: Number,
    taxAmount: Number,
    cgst: Number,
    sgst: Number,
    igst: Number,
    totalAmount: Number,
});

const proformaInvoiceSchema = new mongoose.Schema({
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    proformaNumber: { type: String },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true },
    customerPhone: String,
    customerAddress: String,
    customerCity: String,
    customerState: String,
    customerGstin: String,
    proformaDate: { type: Date, default: Date.now },
    status: {
        type: String,
        enum: ['DRAFT', 'SENT', 'CONFIRMED', 'CANCELLED', 'CONVERTED'],
        default: 'DRAFT',
    },
    items: [proformaItemSchema],
    taxType: { type: String, enum: ['CGST_SGST', 'IGST'], default: 'CGST_SGST' },
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
    // Purchase Order details
    poNumber: String,
    poDate: Date,
    // Additional invoice details
    eWayBillNumber: String,
    deliveryNote: String,
    referenceNo: String,
    otherReferences: String,
    termsOfDelivery: String,
    destination: String,
    // Set when this proforma invoice is converted to an invoice
    convertedToInvoiceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Invoice',
        default: null
    },
}, { timestamps: true });

proformaInvoiceSchema.index({ organizationId: 1, proformaDate: -1 });
proformaInvoiceSchema.index({ organizationId: 1, proformaNumber: 1 }, { unique: true, sparse: true });
proformaInvoiceSchema.index({ organizationId: 1, status: 1 });

// Auto-generate proforma number
proformaInvoiceSchema.pre('save', async function (next) {
    if (this.isNew && !this.proformaNumber) {
        const Counter = mongoose.model('Counter');
        const Organization = mongoose.model('Organization');
        const org = await Organization.findById(this.organizationId).select('organizationName');
        const orgInitials = org
            ? org.organizationName.trim().substring(0, 2).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'XX'
            : 'XX';
        const date = this.proformaDate ? new Date(this.proformaDate) : new Date();
        const year = date.getFullYear();
        const sequence = await Counter.getNextSequence(this.organizationId, 'proforma', String(year));
        this.proformaNumber = `PF-${year}-${orgInitials}-${String(sequence).padStart(6, '0')}`;
    }
    next();
});

const ProformaInvoice = mongoose.model('ProformaInvoice', proformaInvoiceSchema);
export default ProformaInvoice;
