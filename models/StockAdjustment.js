import mongoose from 'mongoose';

const stockAdjustmentSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    default: null,
  },
  type: {
    type: String,
    enum: ['CONSUMED', 'PRODUCTION', 'MANUAL_ADD', 'MANUAL_REMOVE', 'DAMAGE', 'EXPIRY', 'TRANSFER'],
    required: true,
  },
  // direction derived from type: 'in' adds stock, 'out' removes stock
  direction: {
    type: String,
    enum: ['in', 'out', 'neutral'],
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 0,
  },
  date: {
    type: Date,
    required: true,
  },
  reason: {
    type: String,
    trim: true,
    default: '',
  },
  notes: {
    type: String,
    trim: true,
    default: '',
  },
}, {
  timestamps: true,
});

stockAdjustmentSchema.index({ organizationId: 1, createdAt: -1 });
stockAdjustmentSchema.index({ organizationId: 1, product: 1 });

const StockAdjustment = mongoose.model('StockAdjustment', stockAdjustmentSchema);
export default StockAdjustment;
