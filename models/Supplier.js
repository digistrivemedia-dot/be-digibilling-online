import mongoose from 'mongoose';

const supplierSchema = new mongoose.Schema({
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
  name: {
    type: String,
    required: true,
    trim: true
  },
  contactPerson: {
    type: String,
    trim: true
  },
  phone: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  gstin: {
    type: String,
    uppercase: true,
    trim: true
  },
  pan: {
    type: String,
    uppercase: true,
    trim: true
  },
  address: {
    type: String,
    trim: true
  },
  city: {
    type: String,
    trim: true
  },
  state: {
    type: String,
    trim: true
  },
  pincode: {
    type: String,
    trim: true
  },
  bankDetails: {
    bankName: String,
    accountNumber: String,
    ifscCode: String,
    branch: String
  },
  paymentTerms: {
    type: String,
    enum: ['IMMEDIATE', 'NET_15', 'NET_30', 'NET_45', 'NET_60', 'CUSTOM'],
    default: 'NET_30'
  },
  creditDays: {
    type: Number,
    default: 30
  },
  creditLimit: {
    type: Number,
    default: 0
  },
  openingBalance: {
    type: Number,
    default: 0
  },
  currentBalance: {
    type: Number,
    default: 0
  },
  totalPurchases: {
    type: Number,
    default: 0
  },
  totalReturns: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

// Virtual alias so Supplier and Customer share the same public field name.
// Internally stored as `currentBalance` to avoid a DB migration.
supplierSchema.virtual('outstandingBalance')
  .get(function () { return this.currentBalance; })
  .set(function (v) { this.currentBalance = v; });

// Indexes for multi-tenant queries
supplierSchema.index({ organizationId: 1, name: 1 });
supplierSchema.index({ organizationId: 1, isActive: 1 });
supplierSchema.index({ name: 'text', gstin: 'text', phone: 'text' });

const Supplier = mongoose.model('Supplier', supplierSchema);
export default Supplier;
