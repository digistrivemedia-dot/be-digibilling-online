/**
 * Test fixtures — create a real org + user in the test DB,
 * and generate a valid JWT so API tests can authenticate.
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Organization from '../../models/Organization.js';
import User from '../../models/User.js';
import ShopSettings from '../../models/ShopSettings.js';
import Customer from '../../models/Customer.js';
import Product from '../../models/Product.js';

// Ensure JWT_SECRET is set for tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-testing-only';

export const createTestOrg = async () => {
  const org = await Organization.create({
    organizationName: 'Test Org',
    email: 'testorg@example.com',
    subscriptionStatus: 'active',
    isActive: true,
    state: 'Maharashtra',
  });
  return org;
};

export const createTestUser = async (orgId) => {
  const hashedPassword = await bcrypt.hash('password123', 10);
  const user = await User.create({
    name: 'Test User',
    email: 'testuser@example.com',
    password: hashedPassword,
    role: 'owner',
    organizationId: orgId,
    isActive: true,
  });
  return user;
};

export const createTestShopSettings = async (orgId, userId) => {
  return ShopSettings.create({
    organizationId: orgId,
    userId,
    shopName: 'Test Shop',
    state: 'Maharashtra',
    gstScheme: 'REGULAR',
  });
};

export const createTestCustomer = async (orgId, userId) => {
  return Customer.create({
    organizationId: orgId,
    userId,
    name: 'Test Customer',
    phone: '9876543210',
    state: 'Maharashtra',
  });
};

export const createTestProduct = async (orgId) => {
  return Product.create({
    organizationId: orgId,
    name: 'Test Product',
    hsnCode: '1234',
    sellingPrice: 500,
    purchasePrice: 300,
    gstRate: 18,
    unit: 'NOS',
    currentStock: 100,
  });
};

/**
 * Generate a valid JWT for the given user+org (mirrors how auth.js decodes it).
 * The protect middleware does: jwt.verify → User.findById(decoded.id)
 * So we sign with { id: user._id } and set a long expiry.
 */
export const generateToken = (user) => {
  return jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, {
    expiresIn: '1d',
  });
};

/**
 * One-shot: create org + user + shop settings and return auth header.
 * Most test files will call this in beforeAll.
 */
export const setupTestUser = async () => {
  const org = await createTestOrg();
  const user = await createTestUser(org._id);
  await createTestShopSettings(org._id, user._id);
  const token = generateToken(user);
  const authHeader = `Bearer ${token}`;
  return { org, user, token, authHeader };
};
