/**
 * MongoDB Memory Server helpers
 * Uses MongoMemoryReplSet so MongoDB transactions (sessions) work correctly.
 * Invoice creation uses session.startTransaction() so we need replica set mode.
 */

import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet;

export const connectTestDB = async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ storageEngine: 'wiredTiger' }],
  });

  const uri = replSet.getUri();
  await mongoose.connect(uri);
};

export const disconnectTestDB = async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  if (replSet) await replSet.stop();
};

export const clearCollections = async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
};
