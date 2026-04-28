import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearCollections } from '../helpers/db.js';
import { setupTestUser, createTestCustomer } from '../helpers/fixtures.js';
import createApp from '../helpers/testApp.js';

// Suppress console.error so intentional 401/error tests don't pollute test output.
// The middleware correctly catches these errors and returns proper HTTP responses —
// the console.error inside auth.js is just noise during testing.
vi.spyOn(console, 'error').mockImplementation(() => {});

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

  // Reset customer outstanding balance.
  // Payment endpoints increase this balance, but afterEach deletes invoices
  // directly via deleteMany (which bypasses the balance-reversal logic in DELETE /:id).
  // Without this reset, balances accumulate across tests and break payment amount assertions.
  const Customer = mongoose.default.model('Customer');
  await Customer.updateMany({ organizationId: org._id }, { outstandingBalance: 0 });
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

// ─── Shared helpers ───────────────────────────────────────────────────────────

// A valid-format ObjectId that will never exist in the DB
const FAKE_ID = '000000000000000000000000';

// Minimal UNPAID cash-customer service invoice (gstRate: 0 keeps math simple — grandTotal = sellingPrice)
const createCashInvoice = (sellingPrice = 1000) =>
  request(app)
    .post('/api/invoices')
    .set('Authorization', authHeader)
    .send({
      customerName: 'Cash Customer',
      invoiceDate: new Date().toISOString(),
      taxType: 'CGST_SGST',
      items: [{ itemType: 'service', serviceName: 'Consulting', quantity: 1, sellingPrice, gstRate: 0 }],
    });

// Invoice linked to the real Customer document.
// REQUIRED for all payment endpoints (POST/PUT/DELETE /:id/payments)
// because those routes do invoice.customer._id with no null-check.
const createCustomerInvoice = (sellingPrice = 1000) =>
  request(app)
    .post('/api/invoices')
    .set('Authorization', authHeader)
    .send({
      customer: customer._id.toString(),
      invoiceDate: new Date().toISOString(),
      taxType: 'CGST_SGST',
      items: [{ itemType: 'service', serviceName: 'Consulting', quantity: 1, sellingPrice, gstRate: 0 }],
    });

// ─── GET /api/invoices/:id ────────────────────────────────────────────────────

describe('GET /api/invoices/:id', () => {
  it('returns 404 for a non-existent invoice ID', async () => {
    const res = await request(app)
      .get(`/api/invoices/${FAKE_ID}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('returns the full invoice for a valid ID', async () => {
    const created = (await createCashInvoice()).body;

    const res = await request(app)
      .get(`/api/invoices/${created._id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(created._id);
    expect(res.body.invoiceNumber).toBe(created.invoiceNumber);
    expect(res.body.grandTotal).toBe(created.grandTotal);
    expect(res.body.paymentStatus).toBe('UNPAID');
  });

  it('returns 404 when fetching another org\'s invoice', async () => {
    // Create an invoice as Org B
    const mongoose = await import('mongoose');
    const Organization = mongoose.default.model('Organization');
    const User = mongoose.default.model('User');
    const ShopSettings = mongoose.default.model('ShopSettings');
    const bcrypt = await import('bcryptjs');
    const jwt = await import('jsonwebtoken');

    const orgB = await Organization.create({
      organizationName: 'Org B Get',
      email: 'orgb-get@example.com',
      subscriptionStatus: 'active',
      isActive: true,
    });
    const userB = await User.create({
      name: 'User B',
      email: 'userb-get@example.com',
      password: await bcrypt.default.hash('pass123', 10),
      role: 'owner',
      organizationId: orgB._id,
      isActive: true,
    });
    await ShopSettings.create({ organizationId: orgB._id, userId: userB._id, shopName: 'B Shop', gstScheme: 'REGULAR' });
    const tokenB = jwt.default.sign({ id: userB._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1d' });

    const orgBInvoice = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        customerName: 'B Customer',
        invoiceDate: new Date().toISOString(),
        taxType: 'CGST_SGST',
        items: [{ itemType: 'service', serviceName: 'B Service', quantity: 1, sellingPrice: 500, gstRate: 0 }],
      });

    // Org A tries to fetch Org B's invoice — must get 404
    const res = await request(app)
      .get(`/api/invoices/${orgBInvoice.body._id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/invoices/stats ──────────────────────────────────────────────────

describe('GET /api/invoices/stats', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/invoices/stats');
    expect(res.status).toBe(401);
  });

  it('returns all four stat fields as zero for a new org with no invoices', async () => {
    const res = await request(app)
      .get('/api/invoices/stats')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('todaySales', 0);
    expect(res.body).toHaveProperty('totalOutstanding', 0);
    expect(res.body).toHaveProperty('totalInvoices', 0);
    expect(res.body).toHaveProperty('monthlyRevenue', 0);
  });

  it('reflects invoices created today in todaySales and totalInvoices', async () => {
    // Two invoices: ₹1000 and ₹500 — both UNPAID so totalOutstanding = 1500
    await createCashInvoice(1000);
    await createCashInvoice(500);

    const res = await request(app)
      .get('/api/invoices/stats')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.totalInvoices).toBe(2);
    expect(res.body.todaySales).toBe(1500);
    expect(res.body.totalOutstanding).toBe(1500); // both are UNPAID
    expect(res.body.monthlyRevenue).toBe(1500);
  });
});

// ─── DELETE /api/invoices/:id ─────────────────────────────────────────────────

describe('DELETE /api/invoices/:id', () => {
  it('returns 404 for a non-existent invoice ID', async () => {
    const res = await request(app)
      .delete(`/api/invoices/${FAKE_ID}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });

  it('deletes an invoice and returns success message', async () => {
    const created = (await createCashInvoice()).body;

    const res = await request(app)
      .delete(`/api/invoices/${created._id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted successfully/i);

    // Confirm it is actually gone
    const fetch = await request(app)
      .get(`/api/invoices/${created._id}`)
      .set('Authorization', authHeader);
    expect(fetch.status).toBe(404);
  });

  it('returns 400 when the invoice has returns and cannot be deleted', async () => {
    const created = (await createCashInvoice()).body;

    // Simulate a return by directly setting isReturned on the document
    const mongoose = await import('mongoose');
    const Invoice = mongoose.default.model('Invoice');
    await Invoice.findByIdAndUpdate(created._id, { isReturned: true });

    const res = await request(app)
      .delete(`/api/invoices/${created._id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot delete/i);
  });

  it('returns 404 when trying to delete another org\'s invoice', async () => {
    const mongoose = await import('mongoose');
    const Organization = mongoose.default.model('Organization');
    const User = mongoose.default.model('User');
    const ShopSettings = mongoose.default.model('ShopSettings');
    const bcrypt = await import('bcryptjs');
    const jwt = await import('jsonwebtoken');

    const orgB = await Organization.create({
      organizationName: 'Org B Del',
      email: 'orgb-del@example.com',
      subscriptionStatus: 'active',
      isActive: true,
    });
    const userB = await User.create({
      name: 'User B',
      email: 'userb-del@example.com',
      password: await bcrypt.default.hash('pass123', 10),
      role: 'owner',
      organizationId: orgB._id,
      isActive: true,
    });
    await ShopSettings.create({ organizationId: orgB._id, userId: userB._id, shopName: 'B Shop', gstScheme: 'REGULAR' });
    const tokenB = jwt.default.sign({ id: userB._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1d' });

    const orgBInvoice = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        customerName: 'B Customer',
        invoiceDate: new Date().toISOString(),
        taxType: 'CGST_SGST',
        items: [{ itemType: 'service', serviceName: 'B Service', quantity: 1, sellingPrice: 500, gstRate: 0 }],
      });

    // Org A tries to delete Org B's invoice
    const res = await request(app)
      .delete(`/api/invoices/${orgBInvoice.body._id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/invoices/:id/payments ─────────────────────────────────────────
// NOTE: This endpoint does invoice.customer._id with no null-check.
// Every test here uses createCustomerInvoice() — a cash-customer invoice will crash.

describe('POST /api/invoices/:id/payments', () => {
  it('returns 400 when amount is 0', async () => {
    const invoice = (await createCustomerInvoice()).body;

    const res = await request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set('Authorization', authHeader)
      .send({ amount: 0, paymentMethod: 'CASH' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/amount/i);
  });

  it('returns 400 when paymentMethod is missing', async () => {
    const invoice = (await createCustomerInvoice()).body;

    const res = await request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set('Authorization', authHeader)
      .send({ amount: 500 }); // no paymentMethod

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/payment method/i);
  });

  it('returns 404 when invoice does not exist', async () => {
    const res = await request(app)
      .post(`/api/invoices/${FAKE_ID}/payments`)
      .set('Authorization', authHeader)
      .send({ amount: 500, paymentMethod: 'CASH' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when payment amount exceeds invoice balance', async () => {
    const invoice = (await createCustomerInvoice(1000)).body; // grandTotal = 1000

    const res = await request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set('Authorization', authHeader)
      .send({ amount: 1500, paymentMethod: 'CASH' }); // more than balance

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot exceed/i);
  });

  it('partial payment sets paymentStatus to PARTIAL with correct amounts', async () => {
    const invoice = (await createCustomerInvoice(1000)).body; // balance = 1000

    const res = await request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set('Authorization', authHeader)
      .send({ amount: 600, paymentMethod: 'CASH' });

    expect(res.status).toBe(201);
    expect(res.body.invoice.paymentStatus).toBe('PARTIAL');
    expect(res.body.invoice.paidAmount).toBe(600);
    expect(res.body.invoice.balanceAmount).toBe(400);
  });

  it('full payment sets paymentStatus to PAID with zero balance', async () => {
    const invoice = (await createCustomerInvoice(1000)).body; // balance = 1000

    const res = await request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set('Authorization', authHeader)
      .send({ amount: 1000, paymentMethod: 'UPI' });

    expect(res.status).toBe(201);
    expect(res.body.invoice.paymentStatus).toBe('PAID');
    expect(res.body.invoice.paidAmount).toBe(1000);
    expect(res.body.invoice.balanceAmount).toBe(0);
  });
});

// ─── PUT /api/invoices/:id/payment (legacy single-payment endpoint) ───────────

describe('PUT /api/invoices/:id/payment (legacy)', () => {
  it('returns 404 when invoice does not exist', async () => {
    const res = await request(app)
      .put(`/api/invoices/${FAKE_ID}/payment`)
      .set('Authorization', authHeader)
      .send({ paidAmount: 500, paymentMethod: 'CASH' });

    expect(res.status).toBe(404);
  });

  it('partial payment updates paidAmount and sets status to PARTIAL', async () => {
    // This endpoint has a null-check on invoice.customer so cash invoices are safe here
    const invoice = (await createCashInvoice(1000)).body; // balance = 1000

    const res = await request(app)
      .put(`/api/invoices/${invoice._id}/payment`)
      .set('Authorization', authHeader)
      .send({ paidAmount: 400, paymentMethod: 'CASH' });

    expect(res.status).toBe(200);
    expect(res.body.paymentStatus).toBe('PARTIAL');
    expect(res.body.paidAmount).toBe(400);
    expect(res.body.balanceAmount).toBe(600);
  });

  it('full payment updates status to PAID with zero balance', async () => {
    const invoice = (await createCashInvoice(1000)).body;

    const res = await request(app)
      .put(`/api/invoices/${invoice._id}/payment`)
      .set('Authorization', authHeader)
      .send({ paidAmount: 1000, paymentMethod: 'CASH' });

    expect(res.status).toBe(200);
    expect(res.body.paymentStatus).toBe('PAID');
    expect(res.body.balanceAmount).toBe(0);
  });
});

// ─── PUT /api/invoices/:id/payments/:paymentId ────────────────────────────────

describe('PUT /api/invoices/:id/payments/:paymentId', () => {
  // Helper: create an invoice and add one payment to it, return both
  const createInvoiceWithPayment = async (invoiceTotal = 1000, paymentAmount = 400) => {
    const invoice = (await createCustomerInvoice(invoiceTotal)).body;
    const paymentRes = await request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set('Authorization', authHeader)
      .send({ amount: paymentAmount, paymentMethod: 'CASH' });
    return { invoice, payment: paymentRes.body.payment };
  };

  it('returns 404 when invoice does not exist', async () => {
    const res = await request(app)
      .put(`/api/invoices/${FAKE_ID}/payments/${FAKE_ID}`)
      .set('Authorization', authHeader)
      .send({ amount: 200 });

    expect(res.status).toBe(404);
  });

  it('returns 404 when paymentId does not exist on the invoice', async () => {
    const invoice = (await createCustomerInvoice()).body;

    const res = await request(app)
      .put(`/api/invoices/${invoice._id}/payments/${FAKE_ID}`)
      .set('Authorization', authHeader)
      .send({ amount: 200 });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/payment not found/i);
  });

  it('returns 400 when new amount would exceed available balance', async () => {
    // invoice = ₹1000, existing payment = ₹400, remaining balance = ₹600
    // Trying to change payment to ₹1500 — exceeds total invoice value
    const { invoice, payment } = await createInvoiceWithPayment(1000, 400);

    const res = await request(app)
      .put(`/api/invoices/${invoice._id}/payments/${payment._id}`)
      .set('Authorization', authHeader)
      .send({ amount: 1500 }); // more than the invoice total

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot exceed/i);
  });

  it('successfully updates payment amount and recalculates invoice totals', async () => {
    // invoice = ₹1000, existing payment = ₹400 → change to ₹700
    const { invoice, payment } = await createInvoiceWithPayment(1000, 400);

    const res = await request(app)
      .put(`/api/invoices/${invoice._id}/payments/${payment._id}`)
      .set('Authorization', authHeader)
      .send({ amount: 700 });

    expect(res.status).toBe(200);
    expect(res.body.invoice.paidAmount).toBe(700);
    expect(res.body.invoice.balanceAmount).toBe(300);
    expect(res.body.invoice.paymentStatus).toBe('PARTIAL');
  });
});

// ─── DELETE /api/invoices/:id/payments/:paymentId ─────────────────────────────

describe('DELETE /api/invoices/:id/payments/:paymentId', () => {
  const createInvoiceWithPayment = async (invoiceTotal = 1000, paymentAmount = 500) => {
    const invoice = (await createCustomerInvoice(invoiceTotal)).body;
    const paymentRes = await request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set('Authorization', authHeader)
      .send({ amount: paymentAmount, paymentMethod: 'CASH' });
    return { invoice, payment: paymentRes.body.payment };
  };

  it('returns 404 when invoice does not exist', async () => {
    const res = await request(app)
      .delete(`/api/invoices/${FAKE_ID}/payments/${FAKE_ID}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });

  it('returns 404 when paymentId does not exist on the invoice', async () => {
    const invoice = (await createCustomerInvoice()).body;

    const res = await request(app)
      .delete(`/api/invoices/${invoice._id}/payments/${FAKE_ID}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/payment not found/i);
  });

  it('deletes the payment and restores balance amount', async () => {
    // invoice = ₹1000, pay ₹600 → balance = 400, status = PARTIAL
    // delete the payment → balance should go back to 1000, status = UNPAID
    const { invoice, payment } = await createInvoiceWithPayment(1000, 600);

    const res = await request(app)
      .delete(`/api/invoices/${invoice._id}/payments/${payment._id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.invoice.paidAmount).toBe(0);
    expect(res.body.invoice.balanceAmount).toBe(1000);
    expect(res.body.invoice.paymentStatus).toBe('UNPAID');
  });
});

// ─── PUT /api/invoices/:id (edit) ─────────────────────────────────────────────

describe('PUT /api/invoices/:id — edit', () => {
  // NOTE: The edit route processes all items through Product.findOne and has no
  // service-item branch (unlike POST). Sending service items in the edit body
  // returns 400 "Product not found". A successful edit test requires a real
  // Product + Batch to be set up — covered when product tests are added.
  // These tests cover only the validation layer.

  it('returns 404 when the invoice does not exist', async () => {
    const res = await request(app)
      .put(`/api/invoices/${FAKE_ID}`)
      .set('Authorization', authHeader)
      .send({
        customerName: 'Updated Customer',
        invoiceDate: new Date().toISOString(),
        taxType: 'CGST_SGST',
        items: [{ itemType: 'service', serviceName: 'Updated Service', quantity: 1, sellingPrice: 500, gstRate: 0 }],
      });

    expect(res.status).toBe(404);
  });

  it('returns 400 when items array is empty', async () => {
    const created = (await createCashInvoice()).body;

    const res = await request(app)
      .put(`/api/invoices/${created._id}`)
      .set('Authorization', authHeader)
      .send({
        customerName: 'Updated Customer',
        invoiceDate: new Date().toISOString(),
        taxType: 'CGST_SGST',
        items: [], // empty — must reject
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/item/i);
  });

  it('returns 401 without token', async () => {
    const created = (await createCashInvoice()).body;

    const res = await request(app)
      .put(`/api/invoices/${created._id}`)
      .send({ items: [{ serviceName: 'x', quantity: 1, sellingPrice: 100 }] });

    expect(res.status).toBe(401);
  });
});
