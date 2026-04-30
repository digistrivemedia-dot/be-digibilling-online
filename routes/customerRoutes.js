import express from 'express';
import Customer from '../models/Customer.js';
import { protect } from '../middleware/auth.js';
import tenantIsolation, { addOrgFilter } from '../middleware/tenantIsolation.js';
import { requirePermission } from '../middleware/requireSuperAdmin.js';

const router = express.Router();

// Apply authentication and tenant isolation to all routes
router.use(protect);
router.use(tenantIsolation);

// @route   GET /api/customers
// @desc    Get all customers
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let query = addOrgFilter(req, { isActive: true });

    if (search) {
      query.$text = { $search: search };
    }

    const customers = await Customer.find(query).sort({ createdAt: -1 });
    res.json(customers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/customers/:id
// @desc    Get single customer
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const customer = await Customer.findOne(
      addOrgFilter(req, { _id: req.params.id })
    );

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/customers
// @desc    Create customer
// @access  Private (requires permission)
router.post('/', requirePermission('canManageCustomers'), async (req, res) => {
  try {
    const customer = await Customer.create({
      ...req.body,
      organizationId: req.organizationId,
      userId: req.user._id
    });
    res.status(201).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/customers/:id
// @desc    Update customer
// @access  Private (requires permission)
router.put('/:id', requirePermission('canManageCustomers'), async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      addOrgFilter(req, { _id: req.params.id }),
      req.body,
      { new: true, runValidators: true }
    );

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/customers/:id
// @desc    Delete customer (soft delete)
// @access  Private (requires permission)
router.delete('/:id', requirePermission('canManageCustomers'), async (req, res) => {
  try {
    const customer = await Customer.findOne(addOrgFilter(req, { _id: req.params.id }));

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // BUG-002: Block deletion if customer has an outstanding balance
    if ((customer.outstandingBalance || 0) > 0) {
      return res.status(400).json({
        message: `Cannot delete customer "${customer.name}" — they have an outstanding balance of ₹${customer.outstandingBalance.toFixed(2)}. Clear dues first.`
      });
    }

    await Customer.findByIdAndUpdate(customer._id, { isActive: false });
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
