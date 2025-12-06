// Message Processor - Batches messages for analysis
const config = require('./config.json');

class MessageProcessor {
  constructor() {
    this.batchingWindow = config.batchingWindowMinutes * 60 * 1000; // Convert to milliseconds
    this.messageBuffers = new Map(); // chatId -> array of messages
    this.batchTimers = new Map(); // chatId -> timer
    this.onBatchReadyCallback = null; // Callback for when batch is ready
  }

  setCallback(onBatchReady) {
    this.onBatchReadyCallback = onBatchReady;
  }

  /**
   * Schedule batch processing for a chat
   */
  scheduleBatch(chatId) {
    // Clear existing timer if any
    if (this.batchTimers.has(chatId)) {
      clearTimeout(this.batchTimers.get(chatId));
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.processBatch(chatId);
    }, this.batchingWindow);

    this.batchTimers.set(chatId, timer);
  }

  /**
   * Process a batch of messages for a chat
   */
  async processBatch(chatId) {
    const messages = this.messageBuffers.get(chatId) || [];
    
    if (messages.length === 0) {
      this.batchTimers.delete(chatId);
      return;
    }

    // Check if we have minimum messages for analysis
    if (messages.length < config.minMessagesForAnalysis) {
      // Reschedule if not enough messages yet
      this.scheduleBatch(chatId);
      return;
    }

    try {
      // Sort messages by timestamp
      messages.sort((a, b) => {
        const timeA = new Date(a.sentAt).getTime();
        const timeB = new Date(b.sentAt).getTime();
        return timeA - timeB;
      });

      // Create conversation context
      const conversationBatch = {
        chatId: chatId,
        messages: messages,
        participantPhones: this.extractParticipantPhones(messages),
        timeRange: {
          start: messages[0].sentAt,
          end: messages[messages.length - 1].sentAt
        },
        messageCount: messages.length,
        processedAt: new Date().toISOString()
      };

      // Send batch to analyzer via callback (in-memory, no Kafka topic needed)
      if (this.onBatchReadyCallback) {
        await this.onBatchReadyCallback(conversationBatch);
      }

      console.log(`Processed batch for chat ${chatId}: ${messages.length} messages`);

      // Clear buffer and timer
      this.messageBuffers.delete(chatId);
      this.batchTimers.delete(chatId);
    } catch (error) {
      console.error(`Error processing batch for chat ${chatId}:`, error);
      // Reschedule on error
      this.scheduleBatch(chatId);
    }
  }

  /**
   * Extract unique participant phone numbers from messages
   */
  extractParticipantPhones(messages) {
    const phones = new Set();
    messages.forEach(msg => {
      phones.add(msg.fromPhone);
      if (msg.chatHandles) {
        msg.chatHandles.forEach(handle => {
          phones.add(handle.identifier);
        });
      }
    });
    return Array.from(phones);
  }

  /**
   * Add message to buffer
   */
  addMessage(message) {
    const chatId = message.chatId;
    
    if (!this.messageBuffers.has(chatId)) {
      this.messageBuffers.set(chatId, []);
    }

    this.messageBuffers.get(chatId).push(message);
    
    // Schedule batch processing
    this.scheduleBatch(chatId);
  }

  async start() {
    console.log(`Message processor started. Batching window: ${config.batchingWindowMinutes} minutes`);
    // No Kafka consumer needed - receives messages via addMessage() callback
  }

  async stop() {
    try {
      // Process any remaining batches
      for (const chatId of this.messageBuffers.keys()) {
        await this.processBatch(chatId);
      }

      // Clear all timers
      for (const timer of this.batchTimers.values()) {
        clearTimeout(timer);
      }

      console.log('Message processor stopped');
    } catch (error) {
      console.error('Error stopping message processor:', error);
    }
  }
}

module.exports = MessageProcessor;

