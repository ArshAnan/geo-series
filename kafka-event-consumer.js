// Kafka Event Consumer - Listens for message.received events
require('dotenv').config();
const { Kafka } = require('kafkajs');
const config = require('./config.json');
const DatabaseService = require('./database-service');

class KafkaEventConsumer {
  constructor(targetChatId = null, targetPhoneNumbers = []) {
    this.targetChatId = targetChatId;
    this.targetPhoneNumbers = targetPhoneNumbers.map(p => p.trim());
    this.processedEventIds = new Set(); // In-memory cache
    this.processedMessageIds = new Set(); // In-memory cache
    this.db = new DatabaseService();
    
    // Load processed IDs from MongoDB to avoid re-processing on restart
    this.loadProcessedIds();

    // Kafka Configuration (using existing setup)
    this.kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID || 'imessage-logger-consumer',
      brokers: process.env.KAFKA_BROKERS.split(','),
      ssl: true,
      sasl: {
        mechanism: 'plain',
        username: process.env.KAFKA_SASL_USERNAME,
        password: process.env.KAFKA_SASL_PASSWORD
      },
      // Add connection timeout and retry settings
      connectionTimeout: 10000, // 10 seconds
      requestTimeout: 30000, // 30 seconds
      retry: {
        retries: 8,
        initialRetryTime: 100,
        maxRetryTime: 30000,
        multiplier: 2
      }
    });

    this.consumer = this.kafka.consumer({ 
      groupId: process.env.KAFKA_CONSUMER_GROUP || 'imessage-logger-group'
    });

    // Callbacks for in-memory message processing (no internal Kafka topics needed)
    this.onMessageCallback = null;
    this.onMessageStoredCallback = null;
  }

  async loadProcessedIds() {
    try {
      await this.db.connect();
      // Note: We'll check MongoDB directly, this cache is just for performance
      // Load recent ones into memory cache if needed
      console.log('Processed IDs will be checked from MongoDB');
    } catch (error) {
      console.warn('Could not connect to MongoDB for processed IDs:', error.message);
    }
  }

  async saveProcessedIds() {
    // No longer needed - MongoDB handles persistence
    // IDs are saved immediately when processed
  }

  /**
   * Check if message should be processed based on chat ID or phone numbers
   * Works for both individual chats and group chats
   */
  /**
   * Normalize phone number to E.164 format for consistent matching
   * Handles formats like: "+12014927091", "201-492-7091", "12014927091", "(201) 492-7091"
   */
  normalizePhoneNumber(phone) {
    if (!phone) return '';
    // Remove all non-digit characters except +
    let cleaned = String(phone).replace(/[^\d+]/g, '');
    
    // If it doesn't start with +, check if it's a 10-digit US number
    if (!cleaned.startsWith('+')) {
      // If it's exactly 10 digits, assume US number and add +1
      if (cleaned.length === 10) {
        cleaned = '+1' + cleaned;
      } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
        // If it's 11 digits starting with 1, add +
        cleaned = '+' + cleaned;
      }
    }
    
    return cleaned;
  }

  shouldProcessMessage(eventData) {
    const chatId = String(eventData.chat_id);
    const fromPhone = String(eventData.from_phone || '').trim();
    const chatHandles = eventData.chat_handles || [];

    // Enhanced logging for debugging
    console.log(`\n🔍🔍🔍 DEBUG: Checking message for chat ${chatId} 🔍🔍🔍`);
    console.log(`   From phone (raw): "${fromPhone}"`);
    console.log(`   From phone (normalized): "${this.normalizePhoneNumber(fromPhone)}"`);
    console.log(`   Chat handles structure:`, JSON.stringify(chatHandles, null, 2));
    console.log(`   Target chat ID: "${this.targetChatId}"`);
    console.log(`   Target phone numbers (raw):`, this.targetPhoneNumbers);

    // Collect all participant phone numbers (sender + all chat handles)
    // Handle multiple possible structures for chat handles
    const allPhones = [fromPhone];
    
    chatHandles.forEach((h, idx) => {
      let phone = '';
      if (typeof h === 'string') {
        phone = h.trim();
      } else if (typeof h === 'object' && h !== null) {
        // Try multiple possible property names
        phone = String(h.identifier || h.phone_number || h.phone || h.id || h.number || '').trim();
      }
      
      if (phone) {
        allPhones.push(phone);
        console.log(`   Chat handle ${idx}: ${phone} (from structure: ${JSON.stringify(h)})`);
      } else {
        console.log(`   Chat handle ${idx}: Could not extract phone (structure: ${JSON.stringify(h)})`);
      }
    });

    // Remove empty strings and duplicates
    const uniquePhones = [...new Set(allPhones.filter(p => p))];
    console.log(`   All unique participants: ${uniquePhones.join(', ')}`);

    // Normalize target phone numbers
    const normalizedTargets = this.targetPhoneNumbers.map(t => String(t).trim());
    console.log(`   Target phones: ${normalizedTargets.join(', ')}`);
    console.log(`   Target chat ID: ${this.targetChatId || 'none'}`);

    // Normalize all phone numbers for consistent matching
    const normalizedUniquePhones = uniquePhones.map(p => ({
      original: p,
      normalized: this.normalizePhoneNumber(p)
    }));
    
    const normalizedTargetPhones = normalizedTargets.map(t => ({
      original: t,
      normalized: this.normalizePhoneNumber(t)
    }));

    console.log(`\n   📊 PHONE NUMBER COMPARISON:`);
    console.log(`   Normalized participants: ${normalizedUniquePhones.map(p => `${p.original} → ${p.normalized}`).join(', ')}`);
    console.log(`   Normalized targets: ${normalizedTargetPhones.map(t => `${t.original} → ${t.normalized}`).join(', ')}`);

    // Check if any target phone number matches any participant
    let matchFound = false;
    let matchDetails = null;
    
    const hasTargetPhone = normalizedTargetPhones.some(target => {
      return normalizedUniquePhones.some(phone => {
        // Exact match after normalization
        if (phone.normalized === target.normalized && phone.normalized.length > 0) {
          matchFound = true;
          matchDetails = `Normalized exact match: ${phone.original} (${phone.normalized}) === ${target.original} (${target.normalized})`;
          console.log(`   ✅ ${matchDetails}`);
          return true;
        }
        
        // Check if one contains the other (handles different formats)
        if (phone.normalized && target.normalized && 
            (phone.normalized.includes(target.normalized) || target.normalized.includes(phone.normalized))) {
          matchFound = true;
          matchDetails = `Normalized contains match: ${phone.normalized} contains ${target.normalized} or vice versa`;
          console.log(`   ✅ ${matchDetails}`);
          return true;
        }
        
        // Check last 10 digits (handles country code differences)
        if (phone.normalized.length >= 10 && target.normalized.length >= 10) {
          const phoneLast10 = phone.normalized.slice(-10);
          const targetLast10 = target.normalized.slice(-10);
          if (phoneLast10 === targetLast10 && phoneLast10.length === 10) {
            matchFound = true;
            matchDetails = `Last 10 digits match: ${phoneLast10} === ${targetLast10}`;
            console.log(`   ✅ ${matchDetails}`);
            return true;
          }
        }
        
        // Also check original formats (fallback)
        if (phone.original === target.original) {
          matchFound = true;
          matchDetails = `Original format exact match: ${phone.original} === ${target.original}`;
          console.log(`   ✅ ${matchDetails}`);
          return true;
        }
        if (phone.original.includes(target.original) || target.original.includes(phone.original)) {
          matchFound = true;
          matchDetails = `Original format contains match: ${phone.original} contains ${target.original} or vice versa`;
          console.log(`   ✅ ${matchDetails}`);
          return true;
        }
        
        // Log failed comparison for debugging
        console.log(`   ❌ No match: ${phone.original} (${phone.normalized}) vs ${target.original} (${target.normalized})`);
        return false;
      });
    });
    
    if (!matchFound && normalizedTargetPhones.length > 0 && normalizedUniquePhones.length > 0) {
      console.log(`\n   ⚠️  NO MATCH FOUND!`);
      console.log(`   All participant phones: ${normalizedUniquePhones.map(p => p.normalized).join(', ')}`);
      console.log(`   All target phones: ${normalizedTargetPhones.map(t => t.normalized).join(', ')}`);
    }

    // Process message if:
    // 1. Chat ID matches target chat ID (if set), OR
    // 2. Any target phone number is a participant
    const matchesTargetChat = this.targetChatId && chatId === String(this.targetChatId);
    const matchesTargetPhone = this.targetPhoneNumbers.length > 0 && hasTargetPhone;

    console.log(`\n   📋 FINAL DECISION:`);
    console.log(`   Chat ID match: ${matchesTargetChat} (message chat: "${chatId}" vs target: "${this.targetChatId}")`);
    console.log(`   Phone match: ${matchesTargetPhone} (${hasTargetPhone ? 'YES' : 'NO'})`);
    console.log(`   Will process: ${matchesTargetChat || matchesTargetPhone ? '✅ YES' : '❌ NO'}`);

    if (matchesTargetChat || matchesTargetPhone) {
      // Log group chat detection
      if (chatHandles.length > 1) {
        console.log(`👥 Group chat detected (${uniquePhones.length} participants)`);
        console.log(`   Participants: ${uniquePhones.join(', ')}`);
        const matchingTargets = normalizedTargetPhones.filter(t => 
          normalizedUniquePhones.some(p => {
            return p.normalized === t.normalized || 
                   p.original === t.original ||
                   p.normalized.includes(t.normalized) || 
                   t.normalized.includes(p.normalized) ||
                   (p.normalized.length >= 10 && t.normalized.length >= 10 && 
                    p.normalized.slice(-10) === t.normalized.slice(-10));
          })
        ).map(t => t.original);
        console.log(`   Matches target numbers: ${matchingTargets.join(', ')}`);
      }
      console.log(`   ✅ Message WILL BE PROCESSED\n`);
      return true;
    }

    console.log(`   ❌ Message will be SKIPPED\n`);
    return false;
  }

  /**
   * Normalize message event data
   */
  normalizeMessage(event) {
    const data = event.data;
    return {
      chatId: String(data.chat_id),
      messageId: String(data.id),
      fromPhone: data.from_phone,
      text: data.text || '',
      sentAt: data.sent_at,
      chatHandles: data.chat_handles || [],
      attachments: data.attachments || [],
      isRead: data.is_read || false,
      service: data.service || 'iMessage',
      eventId: event.event_id,
      eventType: event.event_type,
      createdAt: event.created_at
    };
  }

  /**
   * Process a message.received event
   */
  async processMessageReceivedEvent(event) {
    try {
      const eventData = JSON.parse(event.value.toString());
      
      console.log(`\n📥 Processing Kafka event: ${eventData.event_type || 'unknown'}`);
      
      // Only process message.received events
      if (eventData.event_type !== 'message.received') {
        console.log(`   ⏭️  Skipping event type: ${eventData.event_type}`);
        return;
      }
      
      console.log(`   ✅ Event type is message.received, proceeding...`);

      // Skip if already processed (check MongoDB)
      const isEventProcessed = await this.db.isEventProcessed(eventData.event_id);
      if (isEventProcessed || this.processedEventIds.has(eventData.event_id)) {
        console.log(`   ⏭️  Event ${eventData.event_id} already processed - skipping`);
        console.log(`      MongoDB check: ${isEventProcessed}, In-memory cache: ${this.processedEventIds.has(eventData.event_id)}`);
        return;
      }

      // Normalize message first (needed for storage and processing)
      const normalizedMessage = this.normalizeMessage(eventData);

      // IMPORTANT: Store ALL messages before filtering
      // This ensures every message is logged for better recommendations
      // Only messages that pass the filter will be processed (analyzed, responded to)
      // We always try to store (MongoDB uses upsert to handle duplicates safely)
      if (this.onMessageStoredCallback) {
        try {
          const isMessageProcessed = await this.db.isMessageProcessed(eventData.data.id);
          if (isMessageProcessed || this.processedMessageIds.has(eventData.data.id)) {
            console.log(`   ℹ️  Message ${normalizedMessage.messageId} may already be stored, but ensuring it's in database...`);
          } else {
            console.log(`💾 Storing NEW message ${normalizedMessage.messageId} (before filter check)...`);
          }
          console.log(`   Chat ID: ${normalizedMessage.chatId}`);
          console.log(`   From: ${normalizedMessage.fromPhone}`);
          console.log(`   Text: "${(normalizedMessage.text || '').substring(0, 50)}${(normalizedMessage.text || '').length > 50 ? '...' : ''}"`);
          
          await this.onMessageStoredCallback(normalizedMessage);
          console.log(`✅ Message ${normalizedMessage.messageId} stored/verified in MongoDB - will be used for recommendations`);
        } catch (error) {
          console.error(`❌ Error storing message ${normalizedMessage.messageId}:`, error);
          console.error(`   Error message: ${error.message}`);
          console.error(`   Error stack:`, error.stack);
          // Continue processing even if storage fails (but log the error)
        }
      } else {
        console.error(`⚠️  ⚠️  ⚠️  CRITICAL: NO onMessageStoredCallback SET! Message ${normalizedMessage.messageId} won't be stored! ⚠️  ⚠️  ⚠️`);
        console.error(`   This means messages are NOT being logged. Check index.js to ensure callbacks are set up correctly.`);
      }

      // Check if we should process this message (works for both iMessage and SMS)
      // Processing includes: analysis, AI responses, task extraction, etc.
      // Storage happens above regardless of this filter
      const shouldProcess = this.shouldProcessMessage(eventData.data);
      
      if (!shouldProcess) {
        const chatHandles = eventData.data.chat_handles || [];
        // Use same parsing logic as shouldProcessMessage
        const allParticipants = [eventData.data.from_phone];
        chatHandles.forEach(h => {
          let phone = '';
          if (typeof h === 'string') {
            phone = h.trim();
          } else if (typeof h === 'object' && h !== null) {
            phone = String(h.identifier || h.phone_number || h.phone || h.id || h.number || '').trim();
          }
          if (phone) allParticipants.push(phone);
        });
        
        console.log(`⚠️  Message ${eventData.data.id} stored but won't be processed - doesn't match filter criteria`);
        console.log(`  Chat ID: ${eventData.data.chat_id}, From: ${eventData.data.from_phone}`);
        console.log(`  All participants in chat: ${allParticipants.filter(p => p).join(', ')}`);
        console.log(`  Target phones: ${this.targetPhoneNumbers.join(', ') || 'none'}, Target chat: ${this.targetChatId || 'none'}`);
        console.log(`  ✅ Message was stored for logging/recommendations, but won't trigger AI responses or analysis`);
        
        // Mark as processed (stored but not processed)
        await this.db.markEventProcessed(eventData.event_id);
        await this.db.markMessageProcessed(normalizedMessage.messageId);
        this.processedEventIds.add(eventData.event_id);
        this.processedMessageIds.add(normalizedMessage.messageId);
        return;
      }

      // Message passed filter - proceed with processing
      console.log(`\n✅✅✅ MESSAGE PASSED FILTER - PROCESSING NOW ✅✅✅`);
      console.log(`   Message ID: ${normalizedMessage.messageId}`);
      console.log(`   Chat ID: ${normalizedMessage.chatId}`);
      console.log(`   From: ${normalizedMessage.fromPhone}`);
      console.log(`   Text: "${normalizedMessage.text}"`);
      console.log(`   Sent At: ${normalizedMessage.sentAt}`);
      console.log(`\n`);

      // Send to processor via callback (in-memory, no Kafka topic needed)
      // This triggers: analysis, AI responses, task extraction, etc.
      if (this.onMessageCallback) {
        try {
          console.log(`📤 Calling processor callback for message ${normalizedMessage.messageId}...`);
          this.onMessageCallback(normalizedMessage);
          console.log(`✅ Processor callback completed for message ${normalizedMessage.messageId}`);
        } catch (error) {
          console.error(`❌ Error in processor callback:`, error);
          console.error(`   Error stack:`, error.stack);
        }
      } else {
        console.warn(`⚠️  ⚠️  ⚠️  NO onMessageCallback SET! Message won't be processed! ⚠️  ⚠️  ⚠️`);
      }

      // Mark as processed
      // Mark as processed in MongoDB
      await this.db.markEventProcessed(eventData.event_id);
      await this.db.markMessageProcessed(normalizedMessage.messageId);
      
      // Also cache in memory for performance
      this.processedEventIds.add(eventData.event_id);
      this.processedMessageIds.add(normalizedMessage.messageId);
      if (this.processedEventIds.size % 10 === 0) {
        await this.saveProcessedIds();
      }

      console.log(`Processed message ${normalizedMessage.messageId} from chat ${normalizedMessage.chatId} (${normalizedMessage.service})`);
    } catch (error) {
      console.error('Error processing message event:', error);
    }
  }

  setCallbacks(onMessage, onMessageStored) {
    this.onMessageCallback = onMessage;
    this.onMessageStoredCallback = onMessageStored;
  }

  async start() {
    try {
      console.log(`\n🔌 Connecting to Kafka...`);
      console.log(`   Brokers: ${process.env.KAFKA_BROKERS}`);
      console.log(`   Client ID: ${process.env.KAFKA_CLIENT_ID || 'imessage-logger-consumer'}`);
      const consumerGroup = process.env.KAFKA_CONSUMER_GROUP || 'imessage-logger-group';
      console.log(`   Consumer Group: "${consumerGroup}"`);
      console.log(`\n   ⚠️  IMPORTANT: Kafka Consumer Group Behavior:`);
      console.log(`      • If MULTIPLE consumers use the SAME group ID, they SHARE messages (load balancing)`);
      console.log(`      • Each partition is consumed by only ONE consumer in the group`);
      console.log(`      • If you have another instance running with the same group, it might be consuming all messages!`);
      console.log(`      • To have BOTH consumers receive ALL messages, use DIFFERENT group IDs`);
      console.log(`      • Current group: "${consumerGroup}"`);
      
      await this.consumer.connect();
      console.log(`✅ Kafka consumer connected successfully!`);
      
      const teamTopic = process.env.KAFKA_TOPIC;
      if (!teamTopic) {
        throw new Error('KAFKA_TOPIC must be set in .env');
      }

      console.log(`\n📋 Subscribing to topic: "${teamTopic}"`);
      console.log(`   fromBeginning: false (only new messages after subscription)`);
      
      await this.consumer.subscribe({ 
        topic: teamTopic,
        fromBeginning: false // Start from latest to avoid processing old messages
      });

      console.log(`✅ Successfully subscribed to topic: "${teamTopic}"`);
      console.log(`📡 Kafka consumer connected and ready to receive messages...\n`);
      
      console.log(`\n📋 MESSAGE FILTERING CONFIGURATION:`);
      if (this.targetChatId) {
        console.log(`   🎯 Target Chat ID: "${this.targetChatId}"`);
        console.log(`      → Messages from this chat ID will ALWAYS be processed`);
      } else {
        console.log(`   🎯 Target Chat ID: NOT SET (will process all chats with matching phone numbers)`);
      }
      
      if (this.targetPhoneNumbers.length > 0) {
        console.log(`   📞 Target Phone Numbers (${this.targetPhoneNumbers.length}):`);
        this.targetPhoneNumbers.forEach((phone, idx) => {
          const isSender = config.senderPhoneNumber === phone;
          const normalized = this.normalizePhoneNumber(phone);
          console.log(`      ${idx + 1}. "${phone}" → normalized: "${normalized}"${isSender ? ' (Sender - Hackathon Kafka)' : ''}`);
        });
        console.log(`      → Messages where ANY of these numbers are participants will be processed`);
        console.log(`      → Works for both individual chats AND group chats`);
      } else {
        console.log(`   📞 Target Phone Numbers: NOT SET (will process ALL messages)`);
      }
      
      console.log(`\n   ✅ Processing logic: Chat ID match OR Phone number match`);
      console.log(`   ✅ Phone normalization: Handles formats like "+12014927091", "201-492-7091", "12014927091"`);
      console.log(`\n`);
      console.log(`\n⚙️  Consumer starting from: latest messages (fromBeginning: false)`);
      console.log(`   To capture historical messages, set fromBeginning: true in kafka-event-consumer.js\n`);
      
      // Track message count for diagnostics
      this.messageCount = 0;
      
      // Add periodic heartbeat to confirm consumer is alive
      this.heartbeatInterval = setInterval(() => {
        console.log(`💓 Kafka consumer heartbeat - still listening for messages... (${new Date().toLocaleTimeString()})`);
        console.log(`   📊 Total messages received so far: ${this.messageCount}`);
        console.log(`   📋 Topic: "${teamTopic}", Consumer Group: "${process.env.KAFKA_CONSUMER_GROUP || 'imessage-logger-group'}"`);
        if (this.messageCount === 0) {
          console.log(`   ⚠️  WARNING: No messages received yet. Check:`);
          console.log(`      1. Is the Kafka topic correct? (Current: "${teamTopic}")`);
          console.log(`      2. Are messages being published to Kafka when users send messages?`);
          console.log(`      3. Is another consumer in the same group consuming messages?`);
          console.log(`      4. Try running debug-consumer.js to see ALL messages`);
        }
      }, 30000); // Every 30 seconds

      // Add error handlers
      this.consumer.on(this.consumer.events.CRASH, ({ payload: { error } }) => {
        console.error('❌ Kafka consumer crashed:', error);
        console.error('   Error details:', error.message);
        console.error('   Error stack:', error.stack);
      });

      this.consumer.on(this.consumer.events.DISCONNECT, () => {
        console.warn('⚠️  Kafka consumer disconnected');
        console.warn('   This may indicate a network issue or broker problem');
      });

      this.consumer.on(this.consumer.events.CONNECT, () => {
        console.log('✅ Kafka consumer connected (event confirmed)');
      });
      
      this.consumer.on(this.consumer.events.HEARTBEAT, () => {
        // Silent - we have our own heartbeat log
      });
      
      
      
      this.consumer.on(this.consumer.events.START_BATCH_PROCESS, ({ payload }) => {
        console.log(`🔄 Starting batch process: ${payload.numberOfMessages} message(s)`);
      });

      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            this.messageCount++;
            console.log(`\n═══════════════════════════════════════════════════════════`);
            console.log(`📨 RAW KAFKA MESSAGE RECEIVED (#${this.messageCount})`);
            console.log(`   Topic: ${topic}`);
            console.log(`   Partition: ${partition}`);
            console.log(`   Offset: ${message.offset}`);
            console.log(`   Timestamp: ${new Date().toISOString()}`);
            console.log(`   Message length: ${message.value ? message.value.toString().length : 0} bytes`);
            if (message.value) {
              const messageStr = message.value.toString();
              console.log(`   Message preview: ${messageStr.substring(0, 500)}...`);
              
              // Try to parse and show event type immediately
              try {
                const eventData = JSON.parse(messageStr);
                console.log(`   ⚡ Event Type: ${eventData.event_type || 'unknown'}`);
                if (eventData.event_type === 'message.received' && eventData.data) {
                  console.log(`   ⚡ Message From: ${eventData.data.from_phone || 'unknown'}`);
                  console.log(`   ⚡ Chat ID: ${eventData.data.chat_id || 'unknown'}`);
                  console.log(`   ⚡ Text: "${(eventData.data.text || '').substring(0, 50)}..."`);
                }
              } catch (parseErr) {
                console.log(`   ⚠️  Could not parse message preview`);
              }
            } else {
              console.log(`   ⚠️  Message value is null or undefined!`);
            }
            console.log(`═══════════════════════════════════════════════════════════\n`);
            await this.processMessageReceivedEvent(message);
          } catch (error) {
            console.error('❌ Error in eachMessage handler:', error);
            console.error('   Error stack:', error.stack);
          }
        },
        // Add error handling for connection issues
        eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
          try {
            console.log(`\n📦 Processing batch of ${batch.messages.length} message(s)...`);
            for (const message of batch.messages) {
              await this.processMessageReceivedEvent(message);
              await resolveOffset(message.offset);
              await heartbeat();
            }
            console.log(`✅ Batch processing completed\n`);
          } catch (error) {
            console.error('❌ Error processing batch:', error);
            console.error('   Error stack:', error.stack);
            // Continue processing other messages
          }
        }
      });
      
      console.log('✅ Kafka consumer is now running and listening for messages...');
    } catch (error) {
      console.error('Error starting Kafka event consumer:', error);
      throw error;
    }
  }

  async stop() {
    try {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      await this.saveProcessedIds();
      await this.consumer.disconnect();
      console.log('Kafka event consumer stopped');
    } catch (error) {
      console.error('Error stopping Kafka event consumer:', error);
    }
  }
}

module.exports = KafkaEventConsumer;
