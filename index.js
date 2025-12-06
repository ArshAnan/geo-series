// Main Orchestrator - Coordinates all services
require('dotenv').config();
const SeriesAPIClient = require('./api-client');
const KafkaEventConsumer = require('./kafka-event-consumer');
const MessageProcessor = require('./message-processor');
const OpenAIAnalyzer = require('./openai-analyzer');
const StorageService = require('./storage-service');
const NotificationService = require('./notification-service');
const AIResponseService = require('./ai-response-service');
const ConversationInitiatorService = require('./conversation-initiator-service');
const TaskAnalyzerService = require('./task-analyzer-service');
const TaskSchedulerService = require('./task-scheduler-service');
const config = require('./config.json');
const fs = require('fs-extra');
const path = require('path');

class ConversationLogger {
  constructor() {
    this.apiClient = null;
    this.eventConsumer = null;
    this.messageProcessor = null;
    this.openaiAnalyzer = null;
    this.storageService = null;
    this.notificationService = null;
    this.aiResponseService = null;
    this.conversationInitiatorService = null;
    this.taskAnalyzerService = null;
    this.taskSchedulerService = null;
    this.shutdownHandlers = [];
  }

  /**
   * Initialize API client and find/verify target chat (optional)
   */
  async initializeChat() {
    try {
      this.apiClient = new SeriesAPIClient();
      
      // If API client is not enabled, skip chat initialization
      if (!this.apiClient.enabled) {
        console.log('API client not configured. Skipping chat initialization.');
        console.log('The system will filter messages by phone numbers from Kafka events.');
        return config.chatId || null;
      }
      
      // If chatId is configured, verify it exists
      if (config.chatId) {
        console.log(`Verifying chat ID: ${config.chatId}`);
        try {
          const chat = await this.apiClient.getChat(config.chatId);
          console.log(`Chat verified: ${chat.id}`);
          return config.chatId;
        } catch (error) {
          console.warn(`Could not verify chat ID ${config.chatId}:`, error.message);
          console.log('Will filter by phone numbers instead.');
        }
      }

      // Otherwise, try to find chat by phone numbers
      if (config.targetPhoneNumbers && config.targetPhoneNumbers.length > 0) {
        console.log(`Finding chat for phone numbers: ${config.targetPhoneNumbers.join(', ')}`);
        
        // Try findChat endpoint
        try {
          const foundChat = await this.apiClient.findChat(
            config.targetPhoneNumbers[0],
            config.targetPhoneNumbers.slice(1)
          );
          
          if (foundChat && foundChat.id) {
            console.log(`Found chat ID: ${foundChat.id}`);
            // Update config with found chat ID
            config.chatId = foundChat.id;
            await fs.writeJson(path.join(__dirname, 'config.json'), config, { spaces: 2 });
            return foundChat.id;
          }
        } catch (error) {
          console.warn('findChat endpoint failed, trying listChats:', error.message);
        }

        // Fallback to listChats
        try {
          const chats = await this.apiClient.listChats(config.targetPhoneNumbers[0]);
          if (chats && chats.length > 0) {
            // Find chat that includes all target phone numbers
            const targetChat = chats.find(chat => {
              const chatPhones = (chat.participants || []).map(p => p.phone_number || p);
              return config.targetPhoneNumbers.every(target => 
                chatPhones.some(phone => phone === target || phone.includes(target))
              );
            });

            if (targetChat) {
              console.log(`Found chat ID: ${targetChat.id}`);
              config.chatId = targetChat.id;
              await fs.writeJson(path.join(__dirname, 'config.json'), config, { spaces: 2 });
              return targetChat.id;
            }
          }
        } catch (error) {
          console.warn('Could not list chats:', error.message);
        }
      }

      console.log('Could not find target chat via API. Will filter messages by phone numbers from Kafka events.');
      return null;
    } catch (error) {
      console.warn('Error initializing chat (non-fatal):', error.message);
      console.log('The system will work by filtering Kafka events by phone numbers.');
      return null;
    }
  }

  /**
   * Start all services
   */
  async start() {
    try {
      console.log('Starting iMessage Conversation Logger...\n');

      // Initialize chat
      const chatId = await this.initializeChat();

      // Initialize services
      this.eventConsumer = new KafkaEventConsumer(chatId, config.targetPhoneNumbers || []);
      this.messageProcessor = new MessageProcessor();
      this.openaiAnalyzer = new OpenAIAnalyzer(chatId);
      this.storageService = new StorageService();
      this.notificationService = new NotificationService();
      this.taskAnalyzerService = new TaskAnalyzerService(chatId);
      this.taskSchedulerService = new TaskSchedulerService();
      this.aiResponseService = new AIResponseService(chatId);
      // Set task analyzer reference in AI response service for task creation
      this.aiResponseService.taskAnalyzer = this.taskAnalyzerService;
      // Set AI response service reference in task analyzer for sending notifications
      this.taskAnalyzerService.aiResponseService = this.aiResponseService;
      this.conversationInitiatorService = new ConversationInitiatorService(chatId);

      // Wire up callbacks for in-memory processing (no internal Kafka topics needed)
      console.log('🔗 Setting up callbacks...');
      this.eventConsumer.setCallbacks(
        // onMessage: send to processor
        (message) => {
          console.log(`📤 Sending message ${message.messageId} to processor...`);
          this.messageProcessor.addMessage(message);
          // Track message activity for notifications
          this.notificationService.trackMessage(message.chatId, message);
          // Check if AI should respond to this message (fire and forget)
          this.aiResponseService.processMessage(message).catch(error => {
            console.error('Error in AI response service:', error);
          });
        },
        // onMessageStored: store conversation immediately
        async (message) => {
          try {
            console.log(`💾 Storage callback triggered for message ${message.messageId}`);
            console.log(`   Chat ID: ${message.chatId}`);
            console.log(`   From: ${message.fromPhone}`);
            console.log(`   Text: "${(message.text || '').substring(0, 50)}${(message.text || '').length > 50 ? '...' : ''}"`);
            
            await this.storageService.storeConversation(message);
            console.log(`✅ Successfully stored message ${message.messageId} to MongoDB`);
            
            // Reload conversation history in AI response service to use new message for recommendations
            // This ensures recommendations use the latest logged conversations
            try {
              await this.aiResponseService.loadConversationHistory();
              console.log(`🔄 Reloaded conversation history after storing new message`);
            } catch (error) {
              console.warn('⚠️  Error reloading conversation history after storage:', error.message);
              console.warn('   Stack:', error.stack);
            }
          } catch (error) {
            console.error(`❌ CRITICAL: Error in storage callback for message ${message.messageId}:`, error);
            console.error(`   Error message: ${error.message}`);
            console.error(`   Error stack:`, error.stack);
            console.error(`   This message may not be logged!`);
            // Don't throw - we want to continue processing other messages
          }
        }
      );
      
      // Verify callbacks are set
      if (!this.eventConsumer.onMessageCallback) {
        console.error('❌ CRITICAL: onMessageCallback not set!');
      }
      if (!this.eventConsumer.onMessageStoredCallback) {
        console.error('❌ CRITICAL: onMessageStoredCallback not set! Messages will NOT be logged!');
      } else {
        console.log('✅ Message storage callback verified');
      }
      
      console.log('✅ Callbacks set up successfully\n');

      // Track key moments extracted in current batch for task analyzer
      const currentBatchMoments = new Map(); // chatId -> array of moments

      this.messageProcessor.setCallback(
        // onBatchReady: send to analyzer
        async (batch) => {
          // Clear moments for this chat
          currentBatchMoments.set(batch.chatId, []);
          
          // Process with OpenAI analyzer first
          await this.openaiAnalyzer.processBatch(batch);
          
          // After key moments are extracted, analyze for tasks with context
          // Get moments extracted in this batch (plus any existing from storage)
          const batchKeyMoments = currentBatchMoments.get(batch.chatId) || [];
          const existingKeyMoments = await this.storageService.loadKeyMoments();
          const chatExistingMoments = existingKeyMoments.filter(m => m.chatId === batch.chatId);
          
          // Combine batch moments with existing moments (avoid duplicates)
          const allKeyMoments = [...batchKeyMoments];
          const existingIds = new Set(batchKeyMoments.map(m => `${m.type}-${m.date}-${m.description}`));
          chatExistingMoments.forEach(m => {
            const id = `${m.type}-${m.date}-${m.description}`;
            if (!existingIds.has(id)) {
              allKeyMoments.push(m);
            }
          });
          
          // Process batch for task extraction with key moments context
          await this.taskAnalyzerService.processBatch(batch, allKeyMoments);
          
          // Clean up
          currentBatchMoments.delete(batch.chatId);
        }
      );

      this.openaiAnalyzer.setCallback(
        // onMomentExtracted: store key moment and notify
        async (moment) => {
          await this.storageService.storeKeyMoment(moment);
          // Add to notification service for sending to user
          await this.notificationService.addKeyMoment(moment);
          
          // Track moment for current batch (for task analyzer)
          if (!currentBatchMoments.has(moment.chatId)) {
            currentBatchMoments.set(moment.chatId, []);
          }
          currentBatchMoments.get(moment.chatId).push(moment);
        }
      );

      // Wire up task analyzer to process batches and extract tasks
      this.taskAnalyzerService.setCallback(
        // onTaskExtracted: store task
        async (task) => {
          await this.taskSchedulerService.storeTask(task);
        }
      );

      // Start services (they run in parallel)
      console.log('\nStarting services...');
      await Promise.all([
        this.eventConsumer.start(),
        this.messageProcessor.start(),
        this.openaiAnalyzer.start(),
        this.storageService.start(),
        this.notificationService.start(),
        this.aiResponseService.start(),
        this.conversationInitiatorService.start(),
        this.taskAnalyzerService.start(),
        this.taskSchedulerService.start()
      ]);

      console.log('\n✓ All services started successfully!');
      console.log('The conversation logger is now monitoring messages...\n');
      console.log('Press Ctrl+C to stop.\n');

      // Setup graceful shutdown
      this.setupShutdown();
    } catch (error) {
      console.error('Error starting conversation logger:', error);
      await this.stop();
      process.exit(1);
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n${signal} received. Shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('unhandledRejection', (error) => {
      console.error('Unhandled rejection:', error);
    });
  }

  /**
   * Stop all services
   */
  async stop() {
    console.log('Stopping all services...');
    
    const stopPromises = [];
    
    if (this.eventConsumer) {
      stopPromises.push(this.eventConsumer.stop());
    }
    if (this.messageProcessor) {
      stopPromises.push(this.messageProcessor.stop());
    }
    if (this.openaiAnalyzer) {
      stopPromises.push(this.openaiAnalyzer.stop());
    }
    if (this.storageService) {
      stopPromises.push(this.storageService.stop());
    }
    if (this.notificationService) {
      stopPromises.push(this.notificationService.stop());
    }
    if (this.aiResponseService) {
      stopPromises.push(this.aiResponseService.stop());
    }
    if (this.conversationInitiatorService) {
      stopPromises.push(this.conversationInitiatorService.stop());
    }
    if (this.taskAnalyzerService) {
      stopPromises.push(this.taskAnalyzerService.stop());
    }
    if (this.taskSchedulerService) {
      stopPromises.push(this.taskSchedulerService.stop());
    }

    await Promise.all(stopPromises);
    console.log('All services stopped.');
  }
}

// Start the application
if (require.main === module) {
  const logger = new ConversationLogger();
  logger.start().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = ConversationLogger;
