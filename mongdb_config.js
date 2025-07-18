
"use strict";

const mongoose = require('mongoose');
const AutoIncrementFactory = require('mongoose-sequence');

const username = "LeHuuDan99";
const password = "3lyIxDXEzwCtzw2i";
const database = "JPDesktop_Hit";
const URL = `mongodb+srv://${username}:${password}@clustervegas.ym3zd.mongodb.net/${database}?retryWrites=true&w=majority`;
const DB_OPTIONS = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000, // 30s to select a server
  socketTimeoutMS: 30000,          // 45s socket timeout
  maxPoolSize: 50,                 // Increase pool size
  keepAliveInitialDelay: 300000,   // Keepalive after 5 minutes
  family: 4                        // Force IPv4
};

// 🔥 Use createConnection for AutoIncrement
const connection = mongoose.createConnection(URL, DB_OPTIONS);
const AutoIncrement = AutoIncrementFactory(connection);

async function connectDB() {
  const connectWithRetry = async () => {
    try {
      await mongoose.connect(URL, DB_OPTIONS);
      console.log('✅ Connected to MongoDB JPDisplay');

      // Start Heartbeat
      setInterval(async () => {
        try {
          await mongoose.connection.db.admin().ping();
          console.log('[Heartbeat] MongoDB ping successful');
        } catch (err) {
          console.error('[Heartbeat] MongoDB ping failed:', err);
        }
      }, 30 * 60 * 1000); // every 30 min
    } catch (err) {
      console.error('❌ MongoDB connection failed. Retrying in 5 seconds...', err);
      setTimeout(connectWithRetry, 5000);
    }
  };

  connectWithRetry();

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ MongoDB disconnected. Trying to reconnect...');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('✅ MongoDB reconnected');
  });

  mongoose.connection.on('error', err => {
    console.error('❌ MongoDB connection error:', err);
  });
}

module.exports = {
  connectDB,
  URL,
  AutoIncrement,
};
