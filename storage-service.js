// Storage Service - Persists conversations and key moments to MongoDB
const DatabaseService = require('./database-service');

class StorageService {
  constructor() {
    this.db = new DatabaseService();
  }

  /**
   * Store message to MongoDB
   */
  async appendConversation(message) {
    try {
      console.log(`📝 Storage: Attempting to store message ${message.messageId}...`);
      console.log(`   Chat ID: ${message.chatId}`);
      console.log(`   From: ${message.fromPhone}`);
      console.log(`   Text: ${(message.text || '').substring(0, 50)}${(message.text || '').length > 50 ? '...' : ''}`);
      
      await this.db.storeConversation(message);
      
      console.log(`✅ Storage: Successfully stored conversation message ${message.messageId}`);
      console.log(`   Database: MongoDB`);
      console.log(`   This message will be used for better recommendations!`);
    } catch (error) {
      console.error('❌ Storage: Error storing conversation:', error);
      console.error('   Message ID:', message.messageId);
      throw error;
    }
  }

  /**
   * Store key moment to MongoDB
   */
  async appendKeyMoment(moment) {
    try {
      await this.db.storeKeyMoment(moment);
      console.log(`Stored key moment: ${moment.description}`);
    } catch (error) {
      console.error('Error storing key moment:', error);
    }
  }

  async start() {
    await this.db.connect();
    console.log('Storage service started (MongoDB)');
  }

  // Public methods to be called directly
  async storeConversation(message) {
    try {
      // Ensure database is connected (connect() handles reconnection automatically)
      await this.db.connect();
      // Conversations are fetched on-demand from API, not stored
      await this.appendConversation(message);
    } catch (error) {
      console.error('❌ Error in storeConversation:', error);
      console.error('   Message ID:', message.messageId);
      console.error('   Error details:', error.message);
      console.error('   Error stack:', error.stack);
      throw error; // Re-throw so caller can handle it
    }
  }

  async storeKeyMoment(moment) {
    await this.appendKeyMoment(moment);
  }

  /**
   * Load key moments from MongoDB (for task analyzer context)
   */
  async loadKeyMoments() {
    try {
      return await this.db.getAllKeyMoments();
    } catch (error) {
      console.error('Error loading key moments:', error);
      return [];
    }
  }

  async stop() {
    await this.db.disconnect();
    console.log('Storage service stopped');
  }
}

module.exports = StorageService;
