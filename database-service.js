// Database Service - MongoDB storage for all data
require('dotenv').config();
const { MongoClient } = require('mongodb');

class DatabaseService {
  constructor() {
    this.client = null;
    this.db = null;
    this.isConnected = false;
    this.connectionString = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    this.dbName = process.env.MONGODB_DB_NAME || 'imessage_logger';
  }

  async connect() {
    if (this.isConnected) {
      return;
    }

    try {
      this.client = new MongoClient(this.connectionString);
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.isConnected = true;
      
      // Create indexes
      await this.createIndexes();
      
      console.log(`✅ Connected to MongoDB: ${this.dbName}`);
    } catch (error) {
      console.error('❌ MongoDB connection error:', error);
      throw error;
    }
  }

  async createIndexes() {
    try {
      // Conversations indexes
      await this.db.collection('conversations').createIndex({ chatId: 1, sentAt: 1 });
      await this.db.collection('conversations').createIndex({ messageId: 1 }, { unique: true });
      await this.db.collection('conversations').createIndex({ storedAt: -1 });

      // Key moments indexes
      await this.db.collection('keyMoments').createIndex({ chatId: 1, extractedAt: -1 });
      await this.db.collection('keyMoments').createIndex({ type: 1, date: -1 });

      // Tasks indexes
      await this.db.collection('tasks').createIndex({ chatId: 1, status: 1 });
      await this.db.collection('tasks').createIndex({ id: 1 }, { unique: true });
      await this.db.collection('tasks').createIndex({ status: 1, 'schedule.type': 1 });
      await this.db.collection('tasks').createIndex({ lastReminderSent: 1 });

      // Processed IDs indexes
      await this.db.collection('processedIds').createIndex({ eventId: 1 }, { unique: true, sparse: true });
      await this.db.collection('processedIds').createIndex({ messageId: 1 }, { unique: true, sparse: true });

      // Sent moments indexes
      await this.db.collection('sentMoments').createIndex({ momentId: 1 }, { unique: true });
      await this.db.collection('sentMoments').createIndex({ chatId: 1, sentAt: -1 });

      // Conversation initiations indexes
      await this.db.collection('conversationInitiations').createIndex({ chatId: 1, date: 1 });
      await this.db.collection('conversationInitiations').createIndex({ initiatedAt: -1 });

      console.log('✅ MongoDB indexes created');
    } catch (error) {
      console.warn('⚠️  Error creating indexes (may already exist):', error.message);
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.isConnected = false;
      console.log('MongoDB disconnected');
    }
  }

  // ========== CONVERSATIONS ==========
  async storeConversation(message) {
    await this.connect();
    try {
      const doc = {
        ...message,
        storedAt: new Date()
      };
      
      // Use upsert to handle duplicates
      await this.db.collection('conversations').updateOne(
        { messageId: message.messageId },
        { $setOnInsert: doc },
        { upsert: true }
      );
      
      return true;
    } catch (error) {
      console.error('Error storing conversation:', error);
      throw error;
    }
  }

  async getConversationsByChat(chatId, limit = 1000) {
    await this.connect();
    try {
      return await this.db.collection('conversations')
        .find({ chatId })
        .sort({ sentAt: 1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Error getting conversations:', error);
      return [];
    }
  }

  /**
   * Get latest N messages for a chat (sorted by sentAt descending, then take last N)
   * Useful for conversation initiator to get recent context
   */
  async getLatestMessagesByChat(chatId, limit = 3) {
    await this.connect();
    try {
      return await this.db.collection('conversations')
        .find({ chatId })
        .sort({ sentAt: -1 }) // Sort descending (newest first)
        .limit(limit)
        .toArray()
        .then(messages => {
          // Reverse to get chronological order (oldest to newest)
          return messages.reverse();
        });
    } catch (error) {
      console.error('Error getting latest messages:', error);
      return [];
    }
  }

  async getAllConversations(limit = 10000) {
    await this.connect();
    try {
      return await this.db.collection('conversations')
        .find({})
        .sort({ sentAt: 1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Error getting all conversations:', error);
      return [];
    }
  }

  // ========== KEY MOMENTS ==========
  async storeKeyMoment(moment) {
    await this.connect();
    try {
      const doc = {
        ...moment,
        extractedAt: moment.extractedAt ? new Date(moment.extractedAt) : new Date(),
        date: moment.date || new Date().toISOString().split('T')[0]
      };
      
      await this.db.collection('keyMoments').insertOne(doc);
      return true;
    } catch (error) {
      console.error('Error storing key moment:', error);
      throw error;
    }
  }

  async getKeyMomentsByChat(chatId) {
    await this.connect();
    try {
      return await this.db.collection('keyMoments')
        .find({ chatId })
        .sort({ extractedAt: -1 })
        .toArray();
    } catch (error) {
      console.error('Error getting key moments:', error);
      return [];
    }
  }

  async getAllKeyMoments() {
    await this.connect();
    try {
      return await this.db.collection('keyMoments')
        .find({})
        .sort({ extractedAt: -1 })
        .toArray();
    } catch (error) {
      console.error('Error getting all key moments:', error);
      return [];
    }
  }

  // ========== TASKS ==========
  async storeTask(task) {
    await this.connect();
    try {
      const doc = {
        ...task,
        extractedAt: task.extractedAt ? new Date(task.extractedAt) : new Date(),
        createdAt: task.createdAt ? new Date(task.createdAt) : new Date(),
        lastReminderSent: task.lastReminderSent ? new Date(task.lastReminderSent) : null
      };
      
      // Use upsert to handle duplicates
      await this.db.collection('tasks').updateOne(
        { id: task.id },
        { $setOnInsert: doc },
        { upsert: true }
      );
      
      return true;
    } catch (error) {
      console.error('Error storing task:', error);
      throw error;
    }
  }

  async updateTask(taskId, updates) {
    await this.connect();
    try {
      const updateDoc = { ...updates };
      if (updates.lastReminderSent) {
        updateDoc.lastReminderSent = new Date(updates.lastReminderSent);
      }
      
      await this.db.collection('tasks').updateOne(
        { id: taskId },
        { $set: updateDoc }
      );
      
      return true;
    } catch (error) {
      console.error('Error updating task:', error);
      throw error;
    }
  }

  async getTasksByChat(chatId, status = 'active') {
    await this.connect();
    try {
      return await this.db.collection('tasks')
        .find({ chatId, status })
        .sort({ createdAt: -1 })
        .toArray();
    } catch (error) {
      console.error('Error getting tasks:', error);
      return [];
    }
  }

  async getAllActiveTasks() {
    await this.connect();
    try {
      return await this.db.collection('tasks')
        .find({ status: 'active' })
        .toArray();
    } catch (error) {
      console.error('Error getting active tasks:', error);
      return [];
    }
  }

  // ========== PROCESSED IDS ==========
  async isEventProcessed(eventId) {
    await this.connect();
    try {
      const result = await this.db.collection('processedIds').findOne({ eventId });
      return !!result;
    } catch (error) {
      console.error('Error checking event:', error);
      return false;
    }
  }

  async isMessageProcessed(messageId) {
    await this.connect();
    try {
      const result = await this.db.collection('processedIds').findOne({ messageId });
      return !!result;
    } catch (error) {
      console.error('Error checking message:', error);
      return false;
    }
  }

  async markEventProcessed(eventId) {
    await this.connect();
    try {
      await this.db.collection('processedIds').updateOne(
        { eventId },
        { $set: { eventId, processedAt: new Date() } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error marking event processed:', error);
    }
  }

  async markMessageProcessed(messageId) {
    await this.connect();
    try {
      await this.db.collection('processedIds').updateOne(
        { messageId },
        { $set: { messageId, processedAt: new Date() } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error marking message processed:', error);
    }
  }

  // ========== SENT MOMENTS ==========
  async isMomentSent(momentId) {
    await this.connect();
    try {
      const result = await this.db.collection('sentMoments').findOne({ momentId });
      return !!result;
    } catch (error) {
      console.error('Error checking sent moment:', error);
      return false;
    }
  }

  async markMomentSent(momentId, chatId) {
    await this.connect();
    try {
      await this.db.collection('sentMoments').updateOne(
        { momentId },
        { $set: { momentId, chatId, sentAt: new Date() } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error marking moment sent:', error);
    }
  }

  // ========== CONVERSATION INITIATIONS ==========
  async getInitiationsByChatAndDate(chatId, date) {
    await this.connect();
    try {
      // Query by chatId and date (date is stored as YYYY-MM-DD string)
      return await this.db.collection('conversationInitiations')
        .find({ chatId, date })
        .toArray();
    } catch (error) {
      console.error('Error getting initiations:', error);
      return [];
    }
  }

  async getInitiationsByChat(chatId, limit = 100) {
    await this.connect();
    try {
      return await this.db.collection('conversationInitiations')
        .find({ chatId })
        .sort({ initiatedAt: -1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Error getting initiations:', error);
      return [];
    }
  }

  async recordInitiation(initiation) {
    await this.connect();
    try {
      const doc = {
        ...initiation,
        initiatedAt: initiation.initiatedAt ? new Date(initiation.initiatedAt) : new Date()
      };
      
      await this.db.collection('conversationInitiations').insertOne(doc);
      return true;
    } catch (error) {
      console.error('Error recording initiation:', error);
      throw error;
    }
  }
}

module.exports = DatabaseService;

