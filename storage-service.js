// Storage Service - Persists conversations and key moments to JSON files
const fs = require('fs-extra');
const path = require('path');

class StorageService {
  constructor() {
    this.conversationsFile = path.join(__dirname, 'logs', 'conversations.json');
    this.keyMomentsFile = path.join(__dirname, 'logs', 'key-moments.json');
    
    // Initialize files if they don't exist
    this.initializeFiles();
  }

  async initializeFiles() {
    try {
      await fs.ensureDir(path.dirname(this.conversationsFile));
      await fs.ensureDir(path.dirname(this.keyMomentsFile));

      // Initialize conversations.json if it doesn't exist
      if (!(await fs.pathExists(this.conversationsFile))) {
        await fs.writeJson(this.conversationsFile, [], { spaces: 2 });
      }

      // Initialize key-moments.json if it doesn't exist
      if (!(await fs.pathExists(this.keyMomentsFile))) {
        await fs.writeJson(this.keyMomentsFile, [], { spaces: 2 });
      }
    } catch (error) {
      console.error('Error initializing storage files:', error);
      throw error;
    }
  }

  /**
   * Append message to conversations.json
   */
  async appendConversation(message) {
    try {
      console.log(`📝 Storage: Attempting to store message ${message.messageId}...`);
      // Read existing conversations
      const conversations = await fs.readJson(this.conversationsFile);
      
      // Check if message already exists (by messageId)
      const exists = conversations.some(c => c.messageId === message.messageId);
      if (exists) {
        console.log(`⚠️  Storage: Message ${message.messageId} already exists, skipping duplicate`);
        return; // Skip duplicates
      }

      // Add new message
      conversations.push({
        ...message,
        storedAt: new Date().toISOString()
      });

      // Sort by timestamp
      conversations.sort((a, b) => {
        const timeA = new Date(a.sentAt).getTime();
        const timeB = new Date(b.sentAt).getTime();
        return timeA - timeB;
      });

      // Write back to file
      await fs.writeJson(this.conversationsFile, conversations, { spaces: 2 });
      
      console.log(`✅ Storage: Successfully stored conversation message ${message.messageId}`);
      console.log(`   File: ${this.conversationsFile}`);
      console.log(`   Total conversations: ${conversations.length}`);
    } catch (error) {
      console.error('❌ Storage: Error appending conversation:', error);
      console.error('   Message ID:', message.messageId);
      console.error('   Error details:', error.stack);
    }
  }

  /**
   * Append key moment to key-moments.json
   */
  async appendKeyMoment(moment) {
    try {
      // Read existing moments
      const moments = await fs.readJson(this.keyMomentsFile);
      
      // Check if moment already exists (by description and date)
      const exists = moments.some(m => 
        m.description === moment.description && 
        m.date === moment.date &&
        m.chatId === moment.chatId
      );
      
      if (exists) {
        console.log(`Skipping duplicate moment: ${moment.description}`);
        return; // Skip duplicates
      }

      // Add new moment
      moments.push(moment);

      // Sort by date
      moments.sort((a, b) => {
        const dateA = new Date(a.date || a.extractedAt).getTime();
        const dateB = new Date(b.date || b.extractedAt).getTime();
        return dateA - dateB;
      });

      // Write back to file
      await fs.writeJson(this.keyMomentsFile, moments, { spaces: 2 });
      
      console.log(`Stored key moment: ${moment.description}`);
    } catch (error) {
      console.error('Error appending key moment:', error);
    }
  }

  async start() {
    console.log('Storage service started');
    console.log(`Conversations file: ${this.conversationsFile}`);
    console.log(`Key moments file: ${this.keyMomentsFile}`);
    // Storage happens via direct method calls, no Kafka consumer needed
  }

  // Public methods to be called directly
  async storeConversation(message) {
    await this.appendConversation(message);
  }

  async storeKeyMoment(moment) {
    await this.appendKeyMoment(moment);
  }

  async stop() {
    console.log('Storage service stopped');
  }
}

module.exports = StorageService;
