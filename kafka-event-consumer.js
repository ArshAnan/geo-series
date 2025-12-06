// Kafka Event Consumer - Listens for message.received events
require('dotenv').config();
const { Kafka } = require('kafkajs');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config.json');

class KafkaEventConsumer {
  constructor(targetChatId = null, targetPhoneNumbers = []) {
    this.targetChatId = targetChatId;
    this.targetPhoneNumbers = targetPhoneNumbers.map(p => p.trim());
    this.processedEventIds = new Set();
    this.processedMessageIds = new Set();
    
    // Load processed IDs from file to avoid re-processing on restart
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
      const stateFile = path.join(__dirname, 'logs', 'processed-ids.json');
      if (await fs.pathExists(stateFile)) {
        const data = await fs.readJson(stateFile);
        this.processedEventIds = new Set(data.eventIds || []);
        this.processedMessageIds = new Set(data.messageIds || []);
        console.log(`Loaded ${this.processedEventIds.size} processed event IDs and ${this.processedMessageIds.size} processed message IDs`);
      }
    } catch (error) {
      console.warn('Could not load processed IDs:', error.message);
    }
  }

  async saveProcessedIds() {
    try {
      const stateFile = path.join(__dirname, 'logs', 'processed-ids.json');
      await fs.ensureDir(path.dirname(stateFile));
      await fs.writeJson(stateFile, {
        eventIds: Array.from(this.processedEventIds),
        messageIds: Array.from(this.processedMessageIds)
      }, { spaces: 2 });
    } catch (error) {
      console.warn('Could not save processed IDs:', error.message);
    }
  }

  /**
   * Check if message should be processed based on chat ID or phone numbers
   * Works for both individual chats and group chats
   */
  shouldProcessMessage(eventData) {
    const chatId = String(eventData.chat_id);
    const fromPhone = String(eventData.from_phone || '').trim();
    const chatHandles = eventData.chat_handles || [];

    // If targetChatId is set, only process that chat
    if (this.targetChatId && chatId !== String(this.targetChatId)) {
      return false;
    }

    // If target phone numbers are set, check if any participant matches
    // This works for group chats - if ANY target number is in the chat, monitor it
    if (this.targetPhoneNumbers.length > 0) {
      // Collect all participant phone numbers (sender + all chat handles)
      const allPhones = [
        fromPhone,
        ...chatHandles.map(h => String(h.identifier || '').trim())
      ].filter(p => p); // Remove empty strings

      // Normalize target phone numbers
      const normalizedTargets = this.targetPhoneNumbers.map(t => String(t).trim());

      // Check if any target phone number matches any participant
      const hasTargetPhone = normalizedTargets.some(target => 
        allPhones.some(phone => {
          // Exact match
          if (phone === target) return true;
          // Check if one contains the other (handles different formats)
          if (phone.includes(target) || target.includes(phone)) return true;
          // Check last 10 digits (handles country code differences)
          const phoneLast10 = phone.slice(-10);
          const targetLast10 = target.slice(-10);
          if (phoneLast10 === targetLast10 && phoneLast10.length === 10) return true;
          return false;
        })
      );

      if (!hasTargetPhone) {
        return false;
      }

      // Log group chat detection
      if (chatHandles.length > 1) {
        console.log(`👥 Group chat detected (${allPhones.length} participants)`);
        console.log(`   Participants: ${allPhones.join(', ')}`);
        console.log(`   Matches target numbers: ${normalizedTargets.filter(t => 
          allPhones.some(p => p === t || p.includes(t) || t.includes(p))
        ).join(', ')}`);
      }
    }

    return true;
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
      
      // Only process message.received events
      if (eventData.event_type !== 'message.received') {
        console.log(`Skipping event type: ${eventData.event_type}`);
        return;
      }

      // Skip if already processed
      if (this.processedEventIds.has(eventData.event_id)) {
        return;
      }

      // Check if we should process this message (works for both iMessage and SMS)
      if (!this.shouldProcessMessage(eventData.data)) {
        const chatHandles = eventData.data.chat_handles || [];
        const allParticipants = [
          eventData.data.from_phone,
          ...chatHandles.map(h => h.identifier || '')
        ].filter(p => p);
        
        console.log(`⚠️  Skipping message ${eventData.data.id} - doesn't match filter criteria`);
        console.log(`  Chat ID: ${eventData.data.chat_id}, From: ${eventData.data.from_phone}`);
        console.log(`  All participants in chat: ${allParticipants.join(', ')}`);
        console.log(`  Target phones: ${this.targetPhoneNumbers.join(', ') || 'none'}, Target chat: ${this.targetChatId || 'none'}`);
        console.log(`  ⚠️  NOTE: This only affects message processing in THIS system. Actual message delivery is handled by Series API.`);
        return;
      }

      // Skip if message ID already processed
      if (this.processedMessageIds.has(eventData.data.id)) {
        this.processedEventIds.add(eventData.event_id);
        return;
      }

      // Normalize message
      const normalizedMessage = this.normalizeMessage(eventData);
      
      console.log(`✅ Message matches filter! Processing message ${normalizedMessage.messageId}`);
      
      // Store message immediately
      if (this.onMessageStoredCallback) {
        try {
          await this.onMessageStoredCallback(normalizedMessage);
          console.log(`✅ Storage callback completed for message ${normalizedMessage.messageId}`);
        } catch (error) {
          console.error(`❌ Error in storage callback:`, error);
        }
      } else {
        console.warn(`⚠️  No onMessageStoredCallback set! Message won't be stored.`);
      }

      // Send to processor via callback (in-memory, no Kafka topic needed)
      if (this.onMessageCallback) {
        try {
          this.onMessageCallback(normalizedMessage);
          console.log(`✅ Processor callback completed for message ${normalizedMessage.messageId}`);
        } catch (error) {
          console.error(`❌ Error in processor callback:`, error);
        }
      } else {
        console.warn(`⚠️  No onMessageCallback set! Message won't be processed.`);
      }

      // Mark as processed
      this.processedEventIds.add(eventData.event_id);
      this.processedMessageIds.add(normalizedMessage.messageId);

      // Periodically save processed IDs
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
      await this.consumer.connect();
      
      const teamTopic = process.env.KAFKA_TOPIC;
      if (!teamTopic) {
        throw new Error('KAFKA_TOPIC must be set in .env');
      }

      await this.consumer.subscribe({ 
        topic: teamTopic,
        fromBeginning: false // Start from latest to avoid processing old messages
      });

      console.log(`\n🔔 Listening for message.received events on topic: ${teamTopic}`);
      console.log(`📡 Kafka consumer connected and ready to receive messages...\n`);
      if (this.targetChatId) {
        console.log(`🎯 Filtering for chat ID: ${this.targetChatId}`);
      }
      if (this.targetPhoneNumbers.length > 0) {
        console.log(`📞 Monitoring conversations with these phone numbers:`);
        this.targetPhoneNumbers.forEach((phone, idx) => {
          const isSender = config.senderPhoneNumber === phone;
          console.log(`   ${idx + 1}. ${phone}${isSender ? ' (Sender - Hackathon Kafka)' : ''}`);
        });
        console.log(`\n✅ Will monitor group chats if ANY of these numbers are participants`);
      }
      console.log(`\n⚙️  Consumer starting from: latest messages (fromBeginning: false)`);
      console.log(`   To capture historical messages, set fromBeginning: true in kafka-event-consumer.js\n`);

      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          console.log(`\n📨 Raw message received from Kafka (topic: ${topic}, partition: ${partition}, offset: ${message.offset})`);
          await this.processMessageReceivedEvent(message);
        },
        // Add error handling for connection issues
        eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
          try {
            for (const message of batch.messages) {
              await this.processMessageReceivedEvent(message);
              await resolveOffset(message.offset);
              await heartbeat();
            }
          } catch (error) {
            console.error('Error processing batch:', error);
            // Continue processing other messages
          }
        }
      });
    } catch (error) {
      console.error('Error starting Kafka event consumer:', error);
      throw error;
    }
  }

  async stop() {
    try {
      await this.saveProcessedIds();
      await this.consumer.disconnect();
      console.log('Kafka event consumer stopped');
    } catch (error) {
      console.error('Error stopping Kafka event consumer:', error);
    }
  }
}

module.exports = KafkaEventConsumer;
