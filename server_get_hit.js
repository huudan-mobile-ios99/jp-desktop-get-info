const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const WebSocket = require('ws');
const xml2js = require('xml2js');
const fs = require('fs').promises; // For file-based persistence
const parser = new xml2js.Parser();
const mongoose = require('mongoose');
const crypto = require('crypto');
const logger = require('./logger');

const { connectDB } = require('./mongdb_config');
const { initializeCleanup } = require('./server_cleanup');


async function initializeServer() {
  app = express();
  server = http.createServer(app);
  io = socketIO(server);
  app.use(express.static('public'));
  server.listen(PORT, () => {
    logger.info(`Server running on port: ${PORT}`);
  });
  await connectDB();
  // Pass the mongoose instance to cleanup.js
  // initializeCleanup(mongoose);
}

// Load models after connection
const InfoModel = require('./model/information_model');
const HitModel = require('./model/hit_model');

const endpoints = [
  'ws://192.168.100.202/Interfaces/Media/JackpotsGateway?COMPUTERNAME=gr011',
  'ws://192.168.100.202/Interfaces/Media/JackpotsGateway?COMPUTERNAME=gr012',
  'ws://192.168.100.202/Interfaces/Media/JackpotsGateway?COMPUTERNAME=gr013',
  'ws://192.168.100.202/Interfaces/Media/JackpotsGateway?COMPUTERNAME=gr014',
];

let app;
let server;
let io;
let currentEndpointIndex = 0;
let isConnecting = false;
let client;
let connectionTimeout;
const softwareVersion = '1.0.0';
const PORT = process.env.PORT || 8000;
const CONNECT_TIMEOUT=0.5*  60 * 1000; // 20 seconds
const RECONNECT_DELAY=2* 60 * 1000; // 20 seconds
const ENDPOINT_STATE_FILE = './current_endpoint.json'; // File to store current endpoint index

// Load last successful endpoint index from file
async function loadLastEndpointIndex() {
  try {
    const data = await fs.readFile(ENDPOINT_STATE_FILE, 'utf8');
    const state = JSON.parse(data);
    currentEndpointIndex = state.currentEndpointIndex || 0;
    logger.info(`Loaded last successful endpoint index: ${currentEndpointIndex} (${endpoints[currentEndpointIndex]})`);
  } catch (error) {
    logger.info('No previous endpoint state found, starting with index 0');
    currentEndpointIndex = 0;
  }
}

// Save current endpoint index to file
async function saveCurrentEndpointIndex() {
  try {
    await fs.writeFile(ENDPOINT_STATE_FILE, JSON.stringify({ currentEndpointIndex }));
    logger.info(`Saved current endpoint index: ${currentEndpointIndex}`);
  } catch (error) {
    logger.info('Error saving endpoint index:', error.message);
  }
}



async function connect() {
  if (isConnecting) {
    logger.info('Connection attempt already in progress, skipping...');
    return;
  }
  isConnecting = true;

  const endpoint = endpoints[currentEndpointIndex];
  logger.info(`Attempting connection to ${endpoint}`);

  // Close any existing WebSocket client
  if (client) {
    client.terminate();
  }

  client = new WebSocket(endpoint);

  // Set a 20-second timeout for the connection attempt
  connectionTimeout = setTimeout(async () => {
    if (client.readyState !== WebSocket.OPEN) {
      logger.info(`Connection to ${endpoint} timed out after 20 seconds`);
      client.terminate();
      isConnecting = false;
      await connectToNextEndpoint();
    }
  }, CONNECT_TIMEOUT);

  client.on('open', () => {
    logger.info(`CONNECTED SERVER => ${endpoint}`);
    isConnecting = false;
    clearTimeout(connectionTimeout);
    saveCurrentEndpointIndex(); // Save the successful endpoint index
  });

  client.on('message', (message) => {
    readXML(message);
  });

  client.on('error', async (error) => {
    logger.info(`Error connecting to ${endpoint}: ${error.message}`);
    isConnecting = false;
    clearTimeout(connectionTimeout);
    setTimeout(async () => {
      await connectToNextEndpoint();
    }, RECONNECT_DELAY); // Wait 20 seconds before trying next endpoint
  });

  client.on('close', async (event) => {
    logger.info(`Connection closed to ${endpoint}, code: ${event.code || 'undefined'}`);
    isConnecting = false;
    clearTimeout(connectionTimeout);
    setTimeout(async () => {
      await connectToNextEndpoint();
    }, RECONNECT_DELAY); // Wait 20 seconds before trying next endpoint
  });
}

async function connectToNextEndpoint() {
  currentEndpointIndex = (currentEndpointIndex + 1) % endpoints.length;
  logger.info(`Switching to next endpoint: ${endpoints[currentEndpointIndex]}`);
  await connect();
}

function readXML(msg) {
  parser.parseString(msg, async (err, result) => {
    if (err) {
      logger.info('Error parsing XML:', err);
      return;
    }
    try {
      if ('JackpotHit' in result) {
        logger.info('New Jackpot hit...');
        const newhit = result.JackpotHit;
        const jackpotData = {
                  type: 'Jackpot',
                  jackpotId: newhit.Jackpot[0].$.Id,
                  jackpotName: newhit.Jackpot[0].$.Name,
                  value: parseFloat(newhit.Hit[0].Amount[0]),
                  machineNumber: newhit.Hit[0].Machine[0].$.MachineNumber,
         };
          // Check for duplicate
          try {
          const existingHit = await HitModel.findOne({
            machineNumber: jackpotData.machineNumber,
            value: jackpotData.value,
          });
          if (existingHit) {
            logger.info(`Duplicate Jackpot hit found, skipping save: ID=${jackpotData.jackpotId}, Name=${jackpotData.jackpotName}, Amount=${jackpotData.value}, Machine=${jackpotData.machineNumber}`);
            return;
          }
          await HitModel.create(jackpotData);
          logger.info(`Saved new Jackpot hit: ID=${jackpotData.jackpotId}`);
        } catch (error) {
          if (error.code === 11000) {
            logger.info(`Duplicate Jackpot hit detected, skipping save: ID=${jackpotData.jackpotId}, Name=${jackpotData.jackpotName}, Amount=${jackpotData.value}, Machine=${jackpotData.machineNumber}`);
            return;
          }
          throw error;
        }
      }

      if ('InformationBroadcast' in result) {
        logger.info('Processing InformationBroadcast...');
        const jps = result.InformationBroadcast.JackpotList[0].Jackpot;
        const jackpotUpdates = jps.map(jp => ({
            jackpotId: jp.$.Id,
            jackpotName: jp.$.Name,
            value: parseFloat(jp.$.Value),
        }));
        // Fetch the top 10 recent InformationBroadcast records
        const recentBroadcasts = await InfoModel
            .find()
            .sort({ timestamp: -1 })
            .limit(10)
            .lean();
        // Flatten the jackpots from recent broadcasts for deduplication check
        const recentJackpots = recentBroadcasts.flatMap(broadcast => broadcast.jackpots);
        // ✅ Add jackpot IDs that should bypass duplicate checking
        const bypassDuplicateCheckIds = ['4','41','40','43','47','45','46'];
        // Filter out duplicate jackpot updates
        // Check for duplicates (but don't skip them anymore)
        jackpotUpdates.forEach(update => {
            if (bypassDuplicateCheckIds.includes(update.jackpotId)) {
                // logger.info(`Bypassing duplicate check for jackpotId ${update.jackpotId}`);
            } else {
                const isDuplicate = recentJackpots.some(jackpot =>
                    jackpot.jackpotId === update.jackpotId && jackpot.value === update.value
                );
                if (isDuplicate) {
                    logger.info(`Duplicate jackpot update found: ID=${update.jackpotId}, Name=${update.jackpotName}, Value=${update.value}`);
                }
            }
        });

        // Save *all* jackpots (including duplicates)
        try {
            await InfoModel.create({
                jackpots: jackpotUpdates,
                messageId: crypto.randomUUID(), // Ensure unique messageId
            });

            logger.info(`+ Saved ${jackpotUpdates.length} jackpot updates`);
        } catch (err) {
            logger.info('+ Failed to save InformationBroadcast:', err);
        }
      }
      if ('HotSeatHit' in result) {
        logger.info('New Hotseat hit...');
        // logger.info('New hotseat hit:', JSON.stringify(result, null, 2));
        const hotSeat = result.HotSeatHit.HotSeat && Array.isArray(result.HotSeatHit.HotSeat) && result.HotSeatHit.HotSeat[0];
        const hit = result.HotSeatHit.Hit && Array.isArray(result.HotSeatHit.Hit) && result.HotSeatHit.Hit[0];
        if (!hotSeat || !hit) {
          logger.info('Invalid HotSeatHit structure: missing HotSeat or Hit');
          return;
        }
        const id = hotSeat.Id && Array.isArray(hotSeat.Id) && hotSeat.Id[0];
        const promotionName = hotSeat.PromotionName && Array.isArray(hotSeat.PromotionName) && hotSeat.PromotionName[0];
        const machineNumber = hit.Machine && Array.isArray(hit.Machine) && hit.Machine[0] && hit.Machine[0].$.MachineNumber;
        const amountRaw = hit.Amount && Array.isArray(hit.Amount) && hit.Amount[0];
        if (!id || !promotionName || !machineNumber) {
          logger.info(`Invalid HotSeatHit data: id=${id}, promotionName=${promotionName}, machineNumber=${machineNumber}`);
          return;
        }
        let amount = 0; // Default to 0
        if (
          amountRaw == null ||
          amountRaw === '' ||
          (Array.isArray(amountRaw) && amountRaw.length === 0) ||
          (typeof amountRaw === 'object' && !Array.isArray(amountRaw) && Object.keys(amountRaw).length === 0)
        ) {
          logger.info(`Invalid or missing amount for HotSeatHit, defaulting to 0: ${JSON.stringify(amountRaw)}`);
        } else {
          amount = parseFloat(amountRaw);
          if (isNaN(amount)) {
            logger.info(`Invalid amount for HotSeatHit, defaulting to 0: ${JSON.stringify(amountRaw)}`);
            amount = 0;
          }
        }
        logger.info(`[${promotionName}] save HotSeat Hit with amount: ${amount}`);
        const hotSeatData = {
                 type: 'HotSeat',
                 jackpotId: id,
                 jackpotName: promotionName,
                 value: amount,
                 machineNumber: machineNumber,
        };
        // Check for duplicate
        try {
          const existingHotSeatHit = await HitModel.findOne({
            machineNumber: hotSeatData.machineNumber,
            value: hotSeatData.value,
          });
          if (existingHotSeatHit) {
            logger.info(`Duplicate HotSeat hit found, skipping save: ID=${hotSeatData.jackpotId}, Name=${hotSeatData.jackpotName}, Amount=${hotSeatData.value}, Machine=${hotSeatData.machineNumber}`);
            return;
          }
          await HitModel.create(hotSeatData);
          logger.info(`Saved new HotSeat hit: ID=${hotSeatData.jackpotId}`);
        } catch (error) {
          if (error.code === 11000) {
            logger.info(`Duplicate HotSeat hit detected, skipping save: ID=${hotSeatData.jackpotId}, Name=${hotSeatData.jackpotName}, Amount=${hotSeatData.value}, Machine=${hotSeatData.machineNumber}`);
            return;
          }
          throw error;
        }
      }
    } catch (error) {
      logger.info('Error processing XML message:',error);
    }
  });
}

async function startServerAndPublishData() {
  try {
    logger.info('JP Desktop HIT Server:', softwareVersion);
    await loadLastEndpointIndex(); // Load last successful endpoint
    initializeServer();
    await connect();
  } catch (error) {
    logger.info('Error starting server:', error);
    process.exit(1);
  }
}

startServerAndPublishData();









