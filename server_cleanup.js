const schedule = require('node-schedule');
const logger = require('./logger');
async function initializeCleanup(mongoose) {
  try {
    const InfoModel = require('./model/information_model');
    const HitModel = require('./model/hit_model');
    // Schedule cleanup job to run every 60 minutes
    schedule.scheduleJob('*/60 * * * *', async () => { // Every hour
      logger.info('⏳ Starting scheduled cleanup...');
      try {
        if (mongoose.connection.readyState !== 1) {
          console.warn('⚠️ DB not connected. Skipping cleanup...');
          return; // Don't try to reconnect, let server handle it
        }

        // Cleanup InformationBroadcast collection
        const broadcastCount = await InfoModel.countDocuments();
        if (broadcastCount > 10) {
          const excessBroadcasts = broadcastCount - 10;
          const latestBroadcasts = await InfoModel.find()
            .sort({ timestamp: -1 })
            .limit(10)
            .select('_id');
          const latestBroadcastIds = latestBroadcasts.map(b => b._id);
          await InfoModel.deleteMany({ _id: { $nin: latestBroadcastIds } });
          logger.info(`🗑 Deleted ${excessBroadcasts} old InformationBroadcast records`);
        } else {
          logger.info('✅ No cleanup needed: InformationBroadcast has 10 or fewer records');
        }

        // Cleanup Hits collection
        const hitCount = await HitModel.countDocuments();
        if (hitCount > 50) {
          const excessHits = hitCount - 50;
          const latestHits = await HitModel.find()
            .sort({ timestamp: -1 })
            .limit(10)
            .select('_id');
          const latestHitIds = latestHits.map(h => h._id);
          await HitModel.deleteMany({ _id: { $nin: latestHitIds } });
          logger.info(`🗑 Deleted ${excessHits} old Hits records`);
        } else {
          logger.info('✅ No cleanup needed: Hits has 10 or fewer records');
        }

      } catch (error) {
        console.error('❌ Error during scheduled cleanup:', error);
      }
    });

    logger.info('⏳ Cleanup job scheduled every 30 minutes');

  } catch (error) {
    console.error('❌ Failed to initialize cleanup:', error);
    process.exit(1);
  }
}

module.exports = { initializeCleanup };
