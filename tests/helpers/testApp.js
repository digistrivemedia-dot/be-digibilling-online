/**
 * Creates a minimal Express app for testing — same routes as production
 * but WITHOUT the rate limiters (which would throttle tests) and
 * WITHOUT calling connectDB() (memory server handles the connection).
 */

import express from 'express';
import invoiceRoutes from '../../routes/invoiceRoutes.js';
import authRoutes from '../../routes/authRoutes.js';

// Register Counter model so pre-save hooks work
import '../../models/Counter.js';

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/invoices', invoiceRoutes);
  return app;
};

export default createApp;
