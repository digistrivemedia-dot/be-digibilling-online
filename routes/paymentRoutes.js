import express from 'express';
import Payment from '../models/Payment.js';
import Customer from '../models/Customer.js';
import Supplier from '../models/Supplier.js';
import Invoice from '../models/Invoice.js';
import Purchase from '../models/Purchase.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';
import { postPaymentToLedger } from '../utils/ledgerHelper.js';
import mongoose from 'mongoose';

const router = express.Router();

// Apply middleware
router.use(protect);
router.use(tenantIsolation);

// @route   GET /api/payments
// @desc    Get all payments
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, type, partyType } = req.query;
    let query = addOrgFilter(req);

    if (startDate && endDate) {
      query.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    if (type) query.type = type;
    if (partyType) query.partyType = partyType;

    const payments = await Payment.find(query)
      .populate('party')
      .sort({ date: -1 });

    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/payments/stats
// @desc    Get payment statistics
// @access  Private
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const orgId = new mongoose.Types.ObjectId(req.organizationId);

    const [todayReceived, todayPaid, totalReceived, totalPaid] = await Promise.all([
      Payment.aggregate([
        {
          $match: {
            organizationId: orgId,
            type: 'RECEIVED',
            date: { $gte: today }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' }
          }
        }
      ]),
      Payment.aggregate([
        {
          $match: {
            organizationId: orgId,
            type: 'PAID',
            date: { $gte: today }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' }
          }
        }
      ]),
      Payment.aggregate([
        {
          $match: {
            organizationId: orgId,
            type: 'RECEIVED'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' }
          }
        }
      ]),
      Payment.aggregate([
        {
          $match: {
            organizationId: orgId,
            type: 'PAID'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' }
          }
        }
      ])
    ]);

    res.json({
      todayReceived: todayReceived[0]?.total || 0,
      todayPaid: todayPaid[0]?.total || 0,
      totalReceived: totalReceived[0]?.total || 0,
      totalPaid: totalPaid[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/payments/:id
// @desc    Get single payment
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.id,
      organizationId: req.organizationId
    }).populate('party');

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    res.json(payment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/payments
// @desc    Create payment (received or paid)
// @access  Private
router.post('/', async (req, res) => {
  let session = null;
  try {
    const {
      type,
      partyType,
      party: partyId,
      amount,
      paymentMethod,
      referenceType,
      referenceId,
      ...paymentData
    } = req.body;

    const orgId = req.organizationId || req.user.organizationId;

    // ── Validate inputs ───────────────────────────────────────────────────────
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Payment amount must be greater than 0' });
    }

    // Validate party
    const PartyModel = partyType === 'CUSTOMER' ? Customer : Supplier;
    const party = await PartyModel.findOne({ _id: partyId, organizationId: req.organizationId });
    if (!party) {
      return res.status(404).json({ message: `${partyType} not found` });
    }

    // Get reference document details if provided (read-only, before transaction)
    let referenceNumber = '';
    if (referenceType && referenceId) {
      const ReferenceModel = referenceType === 'INVOICE' ? Invoice : Purchase;
      const reference = await ReferenceModel.findById(referenceId);
      if (reference) {
        referenceNumber = reference.invoiceNumber || reference.purchaseNumber;
      }
    }

    // ── START TRANSACTION ─────────────────────────────────────────────────────
    session = await Payment.startSession();
    session.startTransaction();

    // Create payment document
    const [payment] = await Payment.create([{
      ...paymentData,
      userId: req.user._id,
      organizationId: orgId,
      type,
      partyType,
      party: partyId,
      partyModel: partyType === 'CUSTOMER' ? 'Customer' : 'Supplier',
      partyName: party.name,
      amount,
      paymentMethod,
      referenceType,
      referenceId,
      referenceModel: referenceType === 'INVOICE' ? 'Invoice' : (referenceType === 'PURCHASE' ? 'Purchase' : undefined),
      referenceNumber
    }], { session });

    // Update party balance — allow negative (negative = credit balance owed to party)
    if (type === 'RECEIVED' && partyType === 'CUSTOMER') {
      await Customer.findByIdAndUpdate(partyId, { $inc: { outstandingBalance: -amount } }, { session });
    } else if (type === 'PAID' && partyType === 'SUPPLIER') {
      await Supplier.findByIdAndUpdate(partyId, { $inc: { currentBalance: -amount } }, { session });
    }

    // Update referenced invoice/purchase payment status
    if (referenceId && referenceType) {
      const ReferenceModel = referenceType === 'INVOICE' ? Invoice : Purchase;
      const reference = await ReferenceModel.findById(referenceId).session(session);
      if (reference) {
        const newPaidAmount = reference.paidAmount + amount;
        const newBalance = reference.grandTotal - newPaidAmount;
        reference.paidAmount = newPaidAmount;
        reference.balanceAmount = newBalance;
        reference.paymentStatus = newBalance <= 0 ? 'PAID' : (newPaidAmount > 0 ? 'PARTIAL' : 'UNPAID');
        await reference.save({ session });
      }
    }

    // Post to ledger
    const ledgerEntries = await postPaymentToLedger(payment, req.user._id, orgId, session);
    payment.ledgerEntries = ledgerEntries.map(entry => entry._id);
    await payment.save({ session });

    await session.commitTransaction();
    res.status(201).json(payment);
  } catch (error) {
    if (session) await session.abortTransaction();
    console.error('Payment creation error:', error);
    res.status(500).json({ message: error.message });
  } finally {
    if (session) session.endSession();
  }
});

// @route   DELETE /api/payments/:id
// @desc    Delete payment
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.id,
      organizationId: req.organizationId
    });

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    // Note: In production, you should also reverse ledger entries and party balances
    return res.status(400).json({
      message: 'Payment deletion not allowed for accounting integrity. Please create an adjustment entry instead.'
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
