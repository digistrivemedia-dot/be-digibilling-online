import express from 'express';
import ShopSettings from '../models/ShopSettings.js';
import { protect } from '../middleware/auth.js';
import { tenantIsolation, addOrgFilter } from '../middleware/tenantIsolation.js';

const router = express.Router();

const getOrganizationId = (req) => (
  req.organizationId ||
  req.user?.organizationId?._id ||
  req.user?.organizationId ||
  null
);

// @route   GET /api/shop/public/name
// @desc    Get shop name (public access for login/signup pages)
// @access  Public
router.get('/public/name', async (req, res) => {
  try {
    // Get the first shop settings (assuming single shop)
    const settings = await ShopSettings.findOne().select('shopName');
    res.json({ shopName: settings?.shopName || 'Billing Software' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.use(protect);
router.use(tenantIsolation);

// @route   GET /api/shop
// @desc    Get shop settings
// @access  Private
router.get('/', async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) {
      return res.status(403).json({ message: 'Access denied. No organization context.' });
    }

    const settings = await ShopSettings.findOne(addOrgFilter({ ...req, organizationId }));
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/shop
// @desc    Create or update shop settings
// @access  Private
router.post('/', async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) {
      return res.status(403).json({ message: 'Access denied. No organization context.' });
    }

    const orgReq = { ...req, organizationId };
    let settings = await ShopSettings.findOne(addOrgFilter(orgReq));

    if (settings) {
      // Partial update — only update the fields sent in the request body
      // Using $set ensures we don't wipe fields not included in this request
      // runValidators is intentionally omitted to allow partial saves
      settings = await ShopSettings.findOneAndUpdate(
        addOrgFilter(orgReq),
        { $set: { ...req.body, userId: req.user._id } },
        { new: true }
      );
    } else {
      // Create new — shopName is required for first-time creation
      if (!req.body.shopName) {
        req.body.shopName = 'My Shop'; // safe default so creation doesn't fail
      }
      settings = await ShopSettings.create({
        ...req.body,
        userId: req.user._id,
        organizationId
      });
    }

    res.json(settings);
  } catch (error) {
    console.error('Shop settings error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

export default router;
