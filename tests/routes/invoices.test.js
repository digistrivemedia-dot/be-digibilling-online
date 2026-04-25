import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearCollections } from '../helpers/db.js';
import { setupTestUser, createTestCustomer } from '../helpers/fixtures.js';
import createApp from '../helpers/testApp.js';

let app;
let authHeader;
let org;
let customer;

beforeAll(async () => {
  await connectTestDB();
  app = createApp();
  const setup = await setupTestUser();
  authHeader = setup.authHeader;
  org = setup.org;
  customer = await createTestCustomer(org._id, setup.user._id);
}, 30000); // replica set startup can take a few seconds

afterAll(async () => {
  await disconnectTestDB();
});

afterEach(async () => {
  // Keep org/user/customer — only wipe invoices between tests
  const mongoose = await import('mongoose');
  const Invoice = mongoose.default.model('Invoice');
  await Invoice.deleteMany({});
});

// ─── Auth Guard ───────────────────────────────────────────────────────────────

describe('GET /api/invoices — auth guard', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/invoices ────────────────────────────────────────────────────────

describe('GET /api/invoices', () => {
  it('returns empty list for new org', async () => {
    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('returns pagination metadata', async () => {
    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', authHeader);

    expect(res.body.pagination).toMatchObject({
      page: 1,
      limit: 15,
      totalPages: 0,
    });
  });
});

// ─── POST /api/invoices — validation ─────────────────────────────────────────

describe('POST /api/invoices — validation', () => {
  it('returns 400 when items array is empty', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', authHeader)
      .send({
        customerName: 'Cash Customer',
        items: [],
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'PAID',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/item/i);
  });

  it('returns 400 when items is missing', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', authHeader)
      .send({
        customerName: 'Cash Customer',
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'PAID',
      });

    expect(res.status).toBe(400);
  });

  it('returns 400 when service item has no name', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', authHeader)
      .send({
        customerName: 'Cash Customer',
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'PAID',
        taxType: 'CGST_SGST',
        items: [{
          itemType: 'service',
          serviceName: '',   // empty
          quantity: 1,
          sellingPrice: 500,
          gstRate: 18,
        }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/service name/i);
  });

  it('returns 400 when quantity is 0', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', authHeader)
      .send({
        customerName: 'Cash Customer',
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'PAID',
        taxType: 'CGST_SGST',
        items: [{
          itemType: 'service',
          serviceName: 'Consulting',
          quantity: 0,        // invalid
          sellingPrice: 500,
          gstRate: 18,
        }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/quantity/i);
  });
});

// ─── POST /api/invoices — service item creation ───────────────────────────────

describe('POST /api/invoices — service item (no batch/stock)', () => {
  it('creates an invoice with a service item successfully', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', authHeader)
      .send({
        customerName: 'Cash Customer',
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'PAID',
        taxType: 'CGST_SGST',
        items: [{
          itemType: 'service',
          serviceName: 'Consulting',
          sacCode: '998311',
          quantity: 2,
          sellingPrice: 500,
          gstRate: 18,
        }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('invoiceNumber');
    expect(res.body.invoiceNumber).toMatch(/^INV-/);
  });

  it('auto-generates invoice number in INV-YYYY-XX-XXXXXX format', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', authHeader)
      .send({
        customerName: 'Cash Customer',
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'PAID',
        taxType: 'CGST_SGST',
        items: [{
          itemType: 'service',
          serviceName: 'Design Work',
          quantity: 1,
          sellingPrice: 1000,
          gstRate: 18,
        }],
      });

    expect(res.status).toBe(201);
    // Format: INV-2026-TE-000001
    expect(res.body.invoiceNumber).toMatch(/^INV-\d{4}-[A-Z]{2}-\d{6}$/);
  });

  it('calculates GST correctly for service invoice', async () => {
    // 1 service × ₹1000 @ 18% GST = ₹1180 total
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', authHeader)
      .send({
        customerName: 'Cash Customer',
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'PAID',
        taxType: 'CGST_SGST',
        items: [{
          itemType: 'service',
          serviceName: 'Consulting',
          quantity: 1,
          sellingPrice: 1000,
          gstRate: 18,
        }],
      });

    expect(res.status).toBe(201);
    expect(res.body.grandTotal).toBeCloseTo(1180, 0);
  });

  it('creates invoice with a known customer and sets customer field', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', authHeader)
      .send({
        customer: customer._id.toString(),
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'UNPAID',
        taxType: 'CGST_SGST',
        items: [{
          itemType: 'service',
          serviceName: 'Annual Maintenance',
          quantity: 1,
          sellingPrice: 5000,
          gstRate: 18,
        }],
      });

    expect(res.status).toBe(201);
    expect(res.body.customerName).toBe('Test Customer');
    expect(res.body.paymentStatus).toBe('UNPAID');
  });

  it('second invoice gets incremented invoice number', async () => {
    const makeInvoice = () =>
      request(app)
        .post('/api/invoices')
        .set('Authorization', authHeader)
        .send({
          customerName: 'Cash Customer',
          invoiceDate: new Date().toISOString(),
          paymentStatus: 'PAID',
          taxType: 'CGST_SGST',
          items: [{ itemType: 'service', serviceName: 'S1', quantity: 1, sellingPrice: 100, gstRate: 0 }],
        });

    const first = await makeInvoice();
    const second = await makeInvoice();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstNum = parseInt(first.body.invoiceNumber.split('-')[3]);
    const secondNum = parseInt(second.body.invoiceNumber.split('-')[3]);
    expect(secondNum).toBe(firstNum + 1);
  });
});

// ─── Org Isolation ────────────────────────────────────────────────────────────

describe('Org Isolation', () => {
  it('org A cannot see org B invoices', async () => {
    // Create org B with its own user
    const { setupTestUser: setup2 } = await import('../helpers/fixtures.js');

    // Temporarily change email to avoid duplicate key
    const mongoose = await import('mongoose');
    const Organization = mongoose.default.model('Organization');
    const User = mongoose.default.model('User');
    const bcrypt = await import('bcryptjs');
    const jwt = await import('jsonwebtoken');

    const orgB = await Organization.create({
      organizationName: 'Org B',
      email: 'orgb@example.com',
      subscriptionStatus: 'active',
      isActive: true,
    });
    const hashedPw = await bcrypt.default.hash('pass123', 10);
    const userB = await User.create({
      name: 'User B',
      email: 'userb@example.com',
      password: hashedPw,
      role: 'owner',
      organizationId: orgB._id,
      isActive: true,
    });
    const ShopSettings = mongoose.default.model('ShopSettings');
    await ShopSettings.create({ organizationId: orgB._id, userId: userB._id, shopName: 'Org B Shop', gstScheme: 'REGULAR' });

    const tokenB = jwt.default.sign({ id: userB._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1d' });

    // Org B creates an invoice
    await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        customerName: 'Org B Customer',
        invoiceDate: new Date().toISOString(),
        paymentStatus: 'PAID',
        taxType: 'CGST_SGST',
        items: [{ itemType: 'service', serviceName: 'Org B Service', quantity: 1, sellingPrice: 999, gstRate: 18 }],
      });

    // Org A should see 0 invoices
    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(0);
  });
});
