import mongoose from 'mongoose';

const challanItemSchema = new mongoose.Schema({
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
    sellingPrice: { type: Number, default: 0 },
    mrp: Number,
    discountAmount: { type: Number, default: 0 },
    gstRate: { type: Number, default: 0 },
    taxableAmount: Number,
    taxAmount: Number,
    cgst: Number,
    sgst: Number,
    igst: Number,
    totalAmount: Number,
    description: String,
});

const deliveryChallanSchema = new mongoose.Schema({
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    challanNumber: { type: String },

    // Customer
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true },
    customerPhone: String,
    customerAddress: String,
    customerCity: String,
    customerState: String,
    customerGstin: String,

    challanDate: { type: Date, default: Date.now },
    status: {
        type: String,
        enum: ['DRAFT', 'DISPATCHED', 'DELIVERED', 'CANCELLED'],
        default: 'DRAFT',
    },

    // Items
    items: [challanItemSchema],

    // Financials
    taxType: { type: String, enum: ['CGST_SGST', 'IGST', 'NONE'], default: 'CGST_SGST' },
    subtotal: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    totalCGST: { type: Number, default: 0 },
    totalSGST: { type: Number, default: 0 },
    totalIGST: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    // Transportation
    transportMode: String,
    transportDocNumber: String,
    transportDocDate: Date,
    vehicleNumber: String,
    approxDist: Number,
    pos: String,
    supplyDate: Date,
    transporterId: String,
    transporterName: String,

    // Purchase Order
    poNumber: String,
    poDate: Date,

    // Additional details (E-Way / Tally)
    eWayBillNumber: String,
    deliveryNote: String,
    referenceNo: String,
    otherReferences: String,
    termsOfDelivery: String,
    destination: String,

    notes: String,

    // Set when this delivery challan is converted to an invoice
    convertedToInvoiceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Invoice',
        default: null
    },
}, { timestamps: true });

deliveryChallanSchema.index({ organizationId: 1, challanDate: -1 });
deliveryChallanSchema.index({ organizationId: 1, challanNumber: 1 }, { unique: true, sparse: true });
deliveryChallanSchema.index({ organizationId: 1, status: 1 });

// Auto-generate challan number
deliveryChallanSchema.pre('save', async function (next) {
    if (this.isNew && !this.challanNumber) {
        const Counter = mongoose.model('Counter');
        const Organization = mongoose.model('Organization');
        const org = await Organization.findById(this.organizationId).select('organizationName');
        const orgInitials = org
            ? org.organizationName.trim().substring(0, 2).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'XX'
            : 'XX';
        const date = this.challanDate ? new Date(this.challanDate) : new Date();
        const year = date.getFullYear();
        const sequence = await Counter.getNextSequence(this.organizationId, 'challan', String(year));
        this.challanNumber = `DC-${year}-${orgInitials}-${String(sequence).padStart(6, '0')}`;
    }
    next();
});

const DeliveryChallan = mongoose.model('DeliveryChallan', deliveryChallanSchema);
export default DeliveryChallan;
