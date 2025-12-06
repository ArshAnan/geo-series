// AI Response Service - Generates and sends AI responses for the 646... number
require('dotenv').config();
const OpenAI = require('openai');
const SeriesAPIClient = require('./api-client');
const config = require('./config.json');
const fs = require('fs-extra');
const path = require('path');
const TriggerDetector = require('./trigger-detector');
const GoogleSearchService = require('./google-search-service');
const StorageService = require('./storage-service');
const DatabaseService = require('./database-service');
const TaskAnalyzerService = require('./task-analyzer-service');

class AIResponseService {
  constructor(targetChatId = null) {
    if (!process.env.OPENAI_API_MY_KEY) {
      throw new Error('OPENAI_API_MY_KEY must be set in .env');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_MY_KEY
    });

    this.model = config.openaiModel || 'gpt-4o';
    this.apiClient = new SeriesAPIClient();
    this.senderPhoneNumber = config.senderPhoneNumber || '+16463458837';
    this.targetChatId = targetChatId || config.chatId; // Only monitor target chat ID
    
    // Track conversation history per chat for context
    this.conversationHistory = new Map(); // chatId -> array of messages
    
    // Track processed messages to avoid responding to the same message twice
    this.processedMessageIds = new Set();
    
    // Track messages we've already reacted to (to avoid duplicate reactions)
    this.reactedMessageIds = new Set();
    
    // Initialize trigger detector and Google search service
    this.triggerDetector = new TriggerDetector();
    this.googleSearchService = new GoogleSearchService();
    this.storageService = new StorageService();
    this.db = new DatabaseService();
    this.taskAnalyzer = null; // Will be set from index.js
    
    // Track if we've sent recommendations recently to avoid spam
    this.lastRecommendationTime = new Map(); // chatId -> timestamp
    this.recommendationCooldown = 30 * 60 * 1000; // 30 minutes cooldown between recommendations (increased)
    this.sentRecommendations = new Map(); // chatId -> array of {type, query, timestamp} to track what was sent
    
    // Track last response time per chat to avoid responding too frequently
    this.lastResponseTime = new Map(); // chatId -> timestamp
    this.minResponseInterval = (config.aiResponseMinIntervalMinutes || 5) * 60 * 1000; // Minimum 5 minutes between responses (increased)
    this.responseConfidenceThreshold = config.aiResponseConfidenceThreshold || 0.85; // Higher threshold - 0.85 (increased from 0.7)
    
    // Load conversation history from storage
    this.loadConversationHistory();
    
    // Callback for when a message is received
    this.onMessageReceivedCallback = null;
  }

  /**
   * Load conversation history from MongoDB
   * Messages are stored in MongoDB as they come in via Kafka events
   */
  async loadConversationHistory() {
    try {
      // Only load conversation history for the target chat ID if configured
      if (!this.targetChatId) {
        console.log('📚 No target chat ID configured. Skipping conversation history load.');
        return;
      }

      const chatId = String(this.targetChatId);
      console.log(`   🎯 Loading conversation history from MongoDB for target chat: ${chatId}`);

      // Track which messages we've already loaded to avoid duplicates
      const loadedMessageIds = new Set();
      this.conversationHistory.forEach((messages) => {
        messages.forEach(msg => {
          if (msg.messageId) {
            loadedMessageIds.add(msg.messageId);
          }
        });
      });
      
      let newMessagesCount = 0;

      try {
        // Load from MongoDB instead of API - more reliable and faster
        await this.db.connect();
        const messages = await this.db.getConversationsByChat(chatId, 10000);
        await this.db.disconnect();
        
        if (!Array.isArray(messages)) {
          console.warn(`   ⚠️  Unexpected response format from MongoDB for chat ${chatId}`);
          return;
        }

        if (!this.conversationHistory.has(chatId)) {
          this.conversationHistory.set(chatId, []);
        }

        // Convert MongoDB messages to conversation history format
        messages.forEach(msg => {
          const messageId = String(msg.messageId || msg.id);
          // Skip if we've already loaded this message
          if (loadedMessageIds.has(messageId)) {
            return;
          }
          
          const fromPhone = msg.fromPhone;
          this.conversationHistory.get(chatId).push({
            role: this.isFromSender(fromPhone) ? 'assistant' : 'user',
            content: msg.text || '',
            timestamp: msg.sentAt,
            messageId: messageId
          });
          
          loadedMessageIds.add(messageId);
          newMessagesCount++;
        });
      } catch (error) {
        console.warn(`   ⚠️  Error loading messages from MongoDB for chat ${chatId}:`, error.message);
      }
      
      // Sort by timestamp
      this.conversationHistory.forEach((messages, chatId) => {
        messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        // Keep more messages in memory for better recommendations (increased from 100 to 200)
        if (messages.length > 200) {
          messages.splice(0, messages.length - 200);
        }
      });
      
      if (newMessagesCount > 0) {
        console.log(`📚 Reloaded conversation history from MongoDB: ${newMessagesCount} new messages for target chat ${chatId}`);
      }
    } catch (error) {
      console.warn('Could not load conversation history from MongoDB:', error.message);
    }
  }

  /**
   * Check if a phone number is the sender (646... number)
   */
  isFromSender(phoneNumber) {
    if (!phoneNumber) return false;
    const normalized = String(phoneNumber).trim();
    const senderNormalized = String(this.senderPhoneNumber).trim();
    
    // Exact match
    if (normalized === senderNormalized) return true;
    
    // Check if one contains the other
    if (normalized.includes(senderNormalized) || senderNormalized.includes(normalized)) return true;
    
    // Check last 10 digits
    const phoneLast10 = normalized.slice(-10);
    const senderLast10 = senderNormalized.slice(-10);
    if (phoneLast10 === senderLast10 && phoneLast10.length === 10) return true;
    
    return false;
  }

  /**
   * Check if message should trigger a response
   * Only respond to messages that are TO the sender number (not FROM it)
   * 
   * Since messages are already filtered by KafkaEventConsumer to only include
   * chats with target phone numbers (including the sender), we just need to
   * check that the message is not from the sender itself.
   */
  shouldRespond(message) {
    // Don't respond to messages from the sender itself
    if (this.isFromSender(message.fromPhone)) {
      console.log(`🤖 AI Response: Skipping message ${message.messageId} - it's from sender ${message.fromPhone}`);
      return false;
    }

    // Since the Kafka filter ensures this chat includes one of the target numbers
    // (which includes the sender number), we can respond to any message not from the sender
    const chatHandles = message.chatHandles || [];
    const allPhones = [
      message.fromPhone,
      ...chatHandles.map(h => String(h.identifier || h.phone_number || '').trim())
    ].filter(p => p);

    console.log(`🤖 AI Response: Checking message ${message.messageId}`);
    console.log(`   From: ${message.fromPhone}`);
    console.log(`   Chat ID: ${message.chatId}`);
    console.log(`   Chat participants: ${allPhones.length > 0 ? allPhones.join(', ') : 'none listed'}`);
    console.log(`   Sender number: ${this.senderPhoneNumber}`);

    // For 1-on-1 chats, chatHandles might only contain the other participant
    // For group chats, it should contain all participants
    // Since Kafka already filtered this message, the chat should include the sender
    // We'll respond to any message not from the sender
    
    // Double-check: verify sender is in chat (for extra safety)
    const hasSender = allPhones.some(phone => {
      const normalized = String(phone).trim();
      const senderNormalized = String(this.senderPhoneNumber).trim();
      
      if (normalized === senderNormalized) {
        console.log(`   ✅ Exact match found: ${normalized}`);
        return true;
      }
      if (normalized.includes(senderNormalized) || senderNormalized.includes(normalized)) {
        console.log(`   ✅ Contains match found: ${normalized} contains ${senderNormalized}`);
        return true;
      }
      
      const phoneLast10 = normalized.slice(-10);
      const senderLast10 = senderNormalized.slice(-10);
      if (phoneLast10 === senderLast10 && phoneLast10.length === 10) {
        console.log(`   ✅ Last 10 digits match: ${phoneLast10}`);
        return true;
      }
      
      return false;
    });

    // If chatHandles is empty or doesn't include sender, we still respond
    // because Kafka filter ensures the chat includes target numbers
    // (This handles cases where chatHandles might not be fully populated)
    if (allPhones.length === 0 || !hasSender) {
      console.log(`   ⚠️  Sender not explicitly in chatHandles, but responding anyway (Kafka filter ensures chat includes sender)`);
    }

    console.log(`   ✅ Should respond to this message`);
    return true; // Always respond if not from sender (Kafka already filtered for us)
  }

  /**
   * Get conversation context for a chat
   * Loads from MongoDB if needed for more complete history
   */
  async getConversationContext(chatId, maxMessages = 20, loadFromMongo = false) {
    let history = this.conversationHistory.get(chatId) || [];
    
    // If we need more history or want to load from MongoDB, fetch directly
    if (loadFromMongo || history.length < maxMessages) {
      try {
        // Load from MongoDB instead of API - more reliable and faster
        await this.db.connect();
        const messages = await this.db.getConversationsByChat(String(chatId), 10000);
        await this.db.disconnect();
        
        if (Array.isArray(messages) && messages.length > 0) {
          // Convert MongoDB messages to conversation history format
          const chatMessages = messages
            .map(msg => {
              const fromPhone = msg.fromPhone;
              return {
                role: this.isFromSender(fromPhone) ? 'assistant' : 'user',
                content: msg.text || '',
                timestamp: msg.sentAt,
                messageId: String(msg.messageId || msg.id)
              };
            })
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          
          // Use MongoDB history if it's more complete or if explicitly requested
          if (loadFromMongo || chatMessages.length > history.length) {
            history = chatMessages;
            // Update in-memory cache
            this.conversationHistory.set(chatId, chatMessages);
          }
        }
      } catch (error) {
        console.warn('Error loading conversation context from MongoDB:', error.message);
      }
    }
    
    // Get the last N messages for context
    return history.slice(-maxMessages);
  }

  /**
   * Update conversation history
   */
  updateConversationHistory(chatId, message, isFromSender = false) {
    if (!this.conversationHistory.has(chatId)) {
      this.conversationHistory.set(chatId, []);
    }
    
    const history = this.conversationHistory.get(chatId);
    
    // Check if message already exists (avoid duplicates)
    const messageId = message.messageId || message.id;
    const exists = history.some(msg => 
      (msg.messageId && msg.messageId === messageId) ||
      (msg.content === message.text && msg.timestamp === message.sentAt)
    );
    
    if (exists) {
      return; // Skip duplicate
    }
    
    history.push({
      role: isFromSender ? 'assistant' : 'user',
      content: message.text || '',
      timestamp: message.sentAt,
      messageId: messageId // Store messageId to track duplicates
    });
    
    // Sort by timestamp to maintain order
    history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Keep only last 100 messages to avoid memory issues
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
  }

  /**
   * Analyze if a response is actually needed
   */
  async shouldGenerateResponse(message, conversationContext) {
    try {
      // Check minimum interval - don't respond too frequently
      const lastResponse = this.lastResponseTime.get(message.chatId);
      const now = Date.now();
      if (lastResponse && (now - lastResponse) < this.minResponseInterval) {
        console.log(`🤖 Skipping response - too soon after last response (${Math.round((now - lastResponse) / 1000)}s ago)`);
        return { shouldRespond: false, reason: 'too_frequent' };
      }

      // Build context for analysis - use ALL unprocessed messages
      const recentMessages = conversationContext.slice(-20); // Use last 20 messages for context
      if (recentMessages.length === 0) {
        return { shouldRespond: false, reason: 'no_message', confidence: 0 };
      }
      const conversationText = recentMessages.map(msg => {
        const role = msg.role === 'assistant' ? 'Agent' : 'User';
        return `${role}: ${msg.content}`;
      }).join('\n');

      const analysisPrompt = `You are analyzing a conversation between two people. An AI agent is present as a background helper/overseer, but the two people are primarily talking to each other.

Conversation:
${conversationText}

IMPORTANT: The agent should ONLY respond in these specific situations:
1. **Direct question TO the agent** - Someone explicitly asks the agent something
2. **Conversation is stuck** - The conversation has stopped and needs a nudge
3. **Clear request for help** - Someone explicitly asks for help, suggestions, or input
4. **Planning assistance needed** - They're actively planning and need recommendations (this is handled separately)

DO NOT respond if:
- The two people are having a natural conversation with each other
- The message is just an acknowledgment ("ok", "thanks", "haha", "cool", "nice")
- They're just chatting casually
- The conversation is flowing naturally between the two people
- The message is a statement or comment that doesn't need a response
- The agent has already responded recently

Remember: The agent is a BACKGROUND helper, not an active participant. Most conversations should flow between the two people without agent intervention.

Respond with JSON:
{
  "shouldRespond": true/false,
  "reason": "brief explanation",
  "confidence": 0.0-1.0
}

Be VERY conservative - only respond if it's absolutely clear the agent is needed. Default to false.`;

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at determining when a background AI helper should step into a conversation. The agent is a background overseer, not an active participant. Be VERY conservative - only recommend responding when the agent is explicitly needed or asked for. Most conversations should flow naturally between the two people without agent intervention.'
          },
          {
            role: 'user',
            content: analysisPrompt
          }
        ],
        temperature: 0.2, // Lower temperature for more conservative detection
        max_tokens: 150
      });

      const content = response.choices[0].message.content.trim();
      let result;
      
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          result = JSON.parse(content);
        }
      } catch (parseError) {
        console.warn('Could not parse response necessity analysis:', content);
        // Default to not responding if we can't parse
        return { shouldRespond: false, reason: 'parse_error', confidence: 0 };
      }

      // Only respond if confidence meets threshold
      if (result.shouldRespond && (result.confidence || 0) >= this.responseConfidenceThreshold) {
        console.log(`✅ Response needed: ${result.reason} (confidence: ${result.confidence})`);
        return { shouldRespond: true, reason: result.reason, confidence: result.confidence };
      } else {
        console.log(`⏭️  Response not needed: ${result.reason || 'low confidence'} (confidence: ${result.confidence || 0}, threshold: ${this.responseConfidenceThreshold})`);
        return { shouldRespond: false, reason: result.reason || 'low_confidence', confidence: result.confidence || 0 };
      }
    } catch (error) {
      console.error('Error analyzing response necessity:', error);
      // Default to not responding on error
      return { shouldRespond: false, reason: 'error', confidence: 0 };
    }
  }

  /**
   * Generate AI response with personality
   */
  async generateResponse(message, conversationContext) {
    try {
      // Build system prompt with personality
      const systemPrompt = `You are a friendly, enthusiastic person who loves:
- Anime (especially popular series like Attack on Titan, Demon Slayer, Jujutsu Kaisen, One Piece, etc.)
- AI and technology (you're excited about AI developments, machine learning, and tech innovations)
- Hackathons (you enjoy coding challenges, building projects, and the hackathon community)

You're having a casual text conversation. Be natural, friendly, and engaging. Use emojis occasionally but not excessively. Show genuine interest in what the other person is saying. Keep responses concise (1-3 sentences typically, sometimes a bit longer if the topic is interesting). Be yourself - a tech-savvy person who loves anime and hackathons.

Don't be overly formal. Use casual language as if texting a friend.

IMPORTANT: Pay attention to the conversation history. Reference previous messages when relevant. Show that you're following the conversation and remember what was discussed.`;

      // Build conversation messages for context
      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      // Add conversation history - use ALL unprocessed messages (last 15 for context)
      const recentContext = conversationContext.slice(-15);
      recentContext.forEach(msg => {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      });

      console.log(`📝 Generating response using ${recentContext.length} messages for context`);

      // Generate response
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: messages,
        temperature: 0.8, // Higher temperature for more natural, varied responses
        max_tokens: 200 // Keep responses reasonably short
      });

      const generatedText = response.choices[0].message.content.trim();
      return generatedText;
    } catch (error) {
      console.error('Error generating AI response:', error);
      throw error;
    }
  }

  /**
   * Process incoming message and generate response
   */
  async processMessage(message) {
    try {
      console.log(`🤖 AI Response Service: Received message ${message.messageId} for processing`);
      
      // Skip if already processed
      if (this.processedMessageIds.has(message.messageId)) {
        console.log(`🤖 AI Response: Message ${message.messageId} already processed, skipping`);
        return;
      }

      // IMPORTANT: Reload conversation history from storage first to get latest logged messages
      // This ensures we use all stored conversations for better recommendations
      await this.loadConversationHistory();
      
      // IMPORTANT: Update conversation history FIRST with the incoming message
      // This ensures the current message is in context when generating responses
      const isFromSender = this.isFromSender(message.fromPhone);
      this.updateConversationHistory(message.chatId, message, isFromSender);
      console.log(`📝 Updated conversation history for chat ${message.chatId} (from sender: ${isFromSender})`);

      // Check if we should respond (only respond to messages NOT from sender)
      if (!this.shouldRespond(message)) {
        console.log(`🤖 AI Response: Not responding to message ${message.messageId} (from sender or other reason)`);
        // Mark as processed even if we don't respond (we've already tracked it)
        this.processedMessageIds.add(message.messageId);
        return;
      }

      console.log(`🤖 AI Response Service: Processing message ${message.messageId} from ${message.fromPhone}`);

      // Get conversation context - fetch ALL unprocessed messages from MongoDB
      // Load from MongoDB to get all messages, not just the current one
      const context = await this.getConversationContext(message.chatId, 100, true);
      console.log(`📚 Using ${context.length} unprocessed messages for context (loaded from MongoDB)`);
      
      // ============================================
      // TOOL 1: Check if Google search is needed
      // ============================================
      const searchDecision = await this.shouldPerformGoogleSearch(message, context);
      if (searchDecision.shouldSearch) {
        console.log(`✅ LLM determined Google search is needed: "${searchDecision.searchQuery}"`);
        await this.performAndSendGoogleSearch(message, searchDecision);
        this.lastResponseTime.set(message.chatId, Date.now());
        // Don't return - continue to reactions and tasks
      } else {
        // ============================================
        // TOOL 2: Check for triggers that require recommendations
        // ============================================
        const triggerResult = await this.checkForTriggers(message, context);
        
        // If trigger detected, send recommendations (this is always valuable, so send it)
        if (triggerResult.shouldTrigger && triggerResult.searchQuery) {
          await this.sendRecommendations(message, triggerResult);
          // Update last response time
          this.lastResponseTime.set(message.chatId, Date.now());
          console.log(`✅ Sent recommendations - skipping regular response to avoid being too active`);
          // Don't return - continue to reactions and tasks
        } else {
          // ============================================
          // TOOL 3: Check if AI should generate a response
          // ============================================
          // For regular AI responses, check if response is actually needed
          // The agent is a background helper - only respond when explicitly needed
          const responseNecessity = await this.shouldGenerateResponse(message, context);
          
          // Only generate and send response if it's clearly needed
          if (responseNecessity.shouldRespond) {
            console.log(`💭 Generating AI response (reason: ${responseNecessity.reason})...`);
            const responseText = await this.generateResponse(message, context);
            console.log(`✅ Generated response: "${responseText}"`);

            // Validate chatId before sending (avoid sending to test/invalid chats)
            if (!message.chatId || message.chatId.startsWith('test-')) {
              console.warn(`⚠️  Skipping send to invalid/test chat ID: ${message.chatId}`);
              console.log(`Would send to chat ${message.chatId}: "${responseText}"`);
              // Still update history
              this.updateConversationHistory(message.chatId, {
                text: responseText,
                sentAt: new Date().toISOString()
              }, true);
            } else {
              // Send response via API
              if (this.apiClient.enabled) {
                try {
                  console.log(`📤 Attempting to send AI response to chat ${message.chatId} from ${this.senderPhoneNumber}...`);
                  console.log(`   Response text: "${responseText}"`);
                  
                  // Send message with the sender phone number specified
                  const result = await this.apiClient.sendMessage(message.chatId, responseText, [], this.senderPhoneNumber);
                  console.log(`✅ Successfully sent AI response!`);
                  console.log(`   Chat ID: ${message.chatId}`);
                  console.log(`   From: ${this.senderPhoneNumber}`);
                  console.log(`   Response: "${responseText}"`);
                  // API response structure: { data: { id, ... } }
                  const messageId = result?.data?.id || result?.id;
                  if (messageId) {
                    console.log(`   Message ID: ${messageId}`);
                  }
                  
                  // Update conversation history with our response
                  this.updateConversationHistory(message.chatId, {
                    text: responseText,
                    sentAt: new Date().toISOString()
                  }, true);
                  
                  // Store AI response to conversations.json for better recommendations
                  await this.storeAIResponse(message.chatId, responseText, messageId);
                  
                  // Update last response time
                  this.lastResponseTime.set(message.chatId, Date.now());
                } catch (error) {
                  console.error('❌ Error sending AI response:', error);
                  if (error.response) {
                    console.error('   Response status:', error.response.status);
                    console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
                    // If it's a 404, the chat doesn't exist - don't retry
                    if (error.response.status === 404) {
                      console.error(`   ⚠️  Chat ${message.chatId} not found. This may be a test chat or invalid chat ID.`);
                      // Still continue to reactions and tasks even on 404
                    }
                  }
                  console.error('   Full error:', error.message);
                  // Continue to reactions and tasks even if sending failed
                }
              } else {
                console.warn('⚠️  API client not enabled. Cannot send AI response.');
                console.log(`Would send to chat ${message.chatId}: "${responseText}"`);
                console.log(`   From: ${this.senderPhoneNumber}`);
                // Still update history even if API is disabled
                this.updateConversationHistory(message.chatId, {
                  text: responseText,
                  sentAt: new Date().toISOString()
                }, true);
                
                // Store AI response to conversations.json for better recommendations
                await this.storeAIResponse(message.chatId, responseText, null);
                
                // Update last response time
                this.lastResponseTime.set(message.chatId, Date.now());
              }
            }
          } else {
            console.log(`⏭️  Skipping AI response - not needed (${responseNecessity.reason})`);
          }
        }
      }

      // ============================================
      // TOOL 4: Check if we should react to this message (positive/negative sentiment)
      // This runs AFTER all response decisions, regardless of what was sent
      // ============================================
      await this.checkAndReactToMessage(message, context);

      // ============================================
      // TOOL 5: Check for task creation
      // This runs AFTER all response decisions, regardless of what was sent
      // ============================================
      await this.checkAndCreateTasks(message, context);

      // Mark as processed
      this.processedMessageIds.add(message.messageId);
    } catch (error) {
      console.error('Error processing message for AI response:', error);
    }
  }

  /**
   * Check for tasks in the conversation and create them if found
   * Sends a notification message if tasks are created
   */
  async checkAndCreateTasks(message, conversationContext) {
    try {
      // Only check if task analyzer is available
      if (!this.taskAnalyzer) {
        console.log(`📋 Task analyzer not available, skipping task check`);
        return;
      }

      console.log(`📋 Checking for tasks in conversation...`);

      // Get key moments for context
      const keyMoments = await this.storageService.loadKeyMoments();
      const chatKeyMoments = keyMoments.filter(m => m.chatId === message.chatId);

      // CRITICAL: Only analyze the CURRENT message for tasks
      // Don't use old messages - only the message that was just received
      // This prevents creating tasks from previous conversations when user sends a simple "Hey"
      const messageBatch = [{
        chatId: message.chatId,
        messageId: message.messageId,
        fromPhone: message.fromPhone,
        text: message.text || '',
        sentAt: message.sentAt,
        chatHandles: message.chatHandles || [],
        attachments: message.attachments || [],
        isRead: message.isRead || false,
        service: message.service || 'iMessage'
      }];
      
      console.log(`   📋 Analyzing ONLY the current message for tasks: "${message.text}"`);

      // Create a conversation batch for task analysis
      const conversationBatch = {
        chatId: message.chatId,
        messages: messageBatch,
        participantPhones: this.extractParticipantPhones(messageBatch),
        timeRange: {
          start: messageBatch.length > 0 ? messageBatch[0].sentAt : new Date().toISOString(),
          end: messageBatch.length > 0 ? messageBatch[messageBatch.length - 1].sentAt : new Date().toISOString()
        },
        messageCount: messageBatch.length,
        processedAt: new Date().toISOString()
      };

      // Analyze for tasks
      const tasks = await this.taskAnalyzer.analyzeConversationForTasks(conversationBatch, chatKeyMoments);

      if (tasks.length === 0) {
        console.log(`   ℹ️  No tasks found in this conversation`);
        return;
      }

      console.log(`✅ Found ${tasks.length} task(s) in conversation!`);

      // Store tasks and send notification
      const createdTasks = [];
      for (const task of tasks) {
        try {
          // Store task via task analyzer callback (which stores in task scheduler)
          if (this.taskAnalyzer.onTaskExtractedCallback) {
            await this.taskAnalyzer.onTaskExtractedCallback(task);
            createdTasks.push(task);
            console.log(`   ✅ Created task: ${task.title} (${task.category})`);
          } else {
            console.warn(`   ⚠️  Task analyzer callback not set, cannot store task`);
          }
        } catch (error) {
          console.error(`   ❌ Error storing task "${task.title}":`, error.message);
        }
      }

      // Send notification message if tasks were created
      if (createdTasks.length > 0 && this.apiClient.enabled) {
        await this.sendTaskNotification(message, createdTasks);
      }
    } catch (error) {
      console.error('Error checking for tasks:', error);
      // Don't throw - task creation is not critical for message processing
    }
  }

  /**
   * Extract participant phone numbers from messages
   */
  extractParticipantPhones(messages) {
    const phones = new Set();
    messages.forEach(msg => {
      if (msg.fromPhone) {
        phones.add(msg.fromPhone);
      }
      if (msg.chatHandles && Array.isArray(msg.chatHandles)) {
        msg.chatHandles.forEach(handle => {
          const phone = handle.identifier || handle.phone_number || handle;
          if (phone) {
            phones.add(String(phone));
          }
        });
      }
    });
    return Array.from(phones);
  }

  /**
   * Send a notification message when tasks are created
   * Uses LLM to generate a natural, human-like response based on the task context
   */
  async sendTaskNotification(message, tasks) {
    try {
      // Generate a natural, human-like notification using LLM
      const taskDescriptions = tasks.map((task, idx) => {
        return `${idx + 1}. ${task.title}${task.context ? ` (${task.context})` : ''}`;
      }).join('\n');

      const prompt = `You're texting a friend about something you just noted. Generate a natural, casual text message (1-2 sentences max) acknowledging the task(s) that were just mentioned in the conversation.

Rules:
- Be casual and friendly, like texting a friend
- Don't use formal language like "Noted" or "I'll keep you updated"
- Make it feel natural and conversational
- If it's about sports/matches, reference the specific team/match naturally
- If it's about an event, mention it casually
- Use emojis sparingly (maybe 1 if it fits naturally)
- Keep it short and human-like

Task(s) mentioned:
${taskDescriptions}

User's message that triggered this: "${message.text}"

Generate a natural, casual text message:`;

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a friendly person texting a friend. Generate natural, casual text messages. Keep responses short (1-2 sentences) and conversational.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.8,
        max_tokens: 100
      });

      let notificationText = response.choices[0].message.content.trim();
      
      // Fallback if LLM response is too long or weird
      if (!notificationText || notificationText.length > 200) {
        // Simple fallback based on task type
        if (tasks.length === 1) {
          const task = tasks[0];
          if (task.category === 'sports' && task.metadata?.teamName) {
            notificationText = `Sounds good! I'll remind you about ${task.metadata.teamName} matches 🏆`;
          } else if (task.category === 'event') {
            notificationText = `Got it! I'll remind you about that 👍`;
          } else {
            notificationText = `Sounds good! I'll keep that in mind 😊`;
          }
        } else {
          notificationText = `Got it! I'll remind you about these 👍`;
        }
      }

      console.log(`📤 Sending task creation notification to chat ${message.chatId}...`);
      console.log(`   Generated message: "${notificationText}"`);

      // Send notification message
      const result = await this.apiClient.sendMessage(
        message.chatId,
        notificationText,
        [],
        this.senderPhoneNumber
      );

      console.log(`✅ Task notification sent successfully!`);
      
      // Store the notification in conversation history
      const messageId = result?.data?.id || result?.id;
      await this.storeAIResponse(message.chatId, notificationText, messageId);
    } catch (error) {
      console.error('Error sending task notification:', error);
      // Fallback to simple message if LLM fails
      try {
        const fallbackMessage = tasks.length === 1 
          ? `Sounds good! I'll keep that in mind 👍`
          : `Got it! I'll remind you about these 👍`;
        await this.apiClient.sendMessage(message.chatId, fallbackMessage, [], this.senderPhoneNumber);
      } catch (fallbackError) {
        console.error('Error sending fallback notification:', fallbackError);
      }
    }
  }

  /**
   * Check for triggers in conversation that require recommendations
   */
  async checkForTriggers(message, conversationContext) {
    try {
      // Check cooldown to avoid spam
      const lastRecTime = this.lastRecommendationTime.get(message.chatId);
      const now = Date.now();
      if (lastRecTime && (now - lastRecTime) < this.recommendationCooldown) {
        const remainingSeconds = Math.ceil((this.recommendationCooldown - (now - lastRecTime)) / 1000);
        console.log(`🔍 Trigger check skipped - cooldown active (${remainingSeconds}s remaining)`);
        return { shouldTrigger: false };
      }

      // Check if we've already sent similar recommendations recently
      const recentRecommendations = this.sentRecommendations.get(message.chatId) || [];
      const recentCutoff = now - (24 * 60 * 60 * 1000); // 24 hours
      const recentRecs = recentRecommendations.filter(r => r.timestamp > recentCutoff);
      
      if (recentRecs.length > 0) {
        console.log(`🔍 Found ${recentRecs.length} recent recommendation(s) in last 24 hours`);
        console.log(`   Recent: ${recentRecs.map(r => `${r.type}: ${r.query}`).join(', ')}`);
      }

      console.log(`🔍 Checking for triggers in conversation...`);
      
      // Get past recommendations for this chat to pass to trigger detector
      const pastRecommendations = this.sentRecommendations.get(message.chatId) || [];
      const pastRecsCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000); // Last 7 days
      const recentPastRecs = pastRecommendations.filter(r => r.timestamp > pastRecsCutoff);
      
      const triggerResult = await this.triggerDetector.detectTriggers(
        conversationContext, 
        message,
        recentPastRecs
      );
      
      // Additional check: if we've sent similar recommendations recently, be more conservative
      if (triggerResult.shouldTrigger && recentRecs.length > 0) {
        const similarRec = recentRecs.find(r => 
          r.type === triggerResult.triggerType && 
          (r.query === triggerResult.searchQuery || 
           (triggerResult.searchQuery && r.query && r.query.toLowerCase().includes(triggerResult.searchQuery.toLowerCase())))
        );
        
        if (similarRec) {
          const hoursSince = (now - similarRec.timestamp) / (1000 * 60 * 60);
          console.log(`🔍 Similar recommendation sent ${hoursSince.toFixed(1)} hours ago - skipping to avoid repetition`);
          return { shouldTrigger: false, reasoning: 'Similar recommendation sent recently' };
        }
      }
      
      return triggerResult;
    } catch (error) {
      console.error('Error checking for triggers:', error);
      return { shouldTrigger: false };
    }
  }

  /**
   * Send recommendations based on trigger
   */
  async sendRecommendations(message, triggerResult) {
    try {
      console.log(`🎯 Sending recommendations for: ${triggerResult.triggerType}`);
      console.log(`   Query: "${triggerResult.searchQuery}"`);
      
      // Get full conversation history for better context
      // Load directly from MongoDB to ensure we have ALL conversations for recommendations
      const fullHistory = await this.getConversationContext(message.chatId, 100, true);
      console.log(`📚 Using ${fullHistory.length} messages from MongoDB for recommendation context`);
      const preferences = this.extractUserPreferences(fullHistory);
      
      // Enhance search query with preferences if available
      let enhancedQuery = triggerResult.searchQuery;
      if (preferences.cuisine && !enhancedQuery.toLowerCase().includes(preferences.cuisine.toLowerCase())) {
        // If user has a preferred cuisine and it's not in the query, consider adding it
        // But only if the query is generic (e.g., "restaurant" -> "Indian restaurant")
        if (enhancedQuery.toLowerCase().includes('restaurant') && !enhancedQuery.toLowerCase().match(/\b(indian|italian|chinese|japanese|mexican|thai|korean|french|american|pizza|sushi|bbq|steak|seafood|vegetarian|vegan)\b/)) {
          enhancedQuery = `${preferences.cuisine} ${enhancedQuery}`;
          console.log(`   Enhanced query with preference: "${enhancedQuery}"`);
        }
      }
      
      // Use preferred location if available and not specified
      const location = triggerResult.location || preferences.location || null;
      if (location) {
        console.log(`   Using location: "${location}"`);
      }
      
      let recommendationsMessage = '';
      
      // Determine search type and perform search
      if (triggerResult.triggerType === 'restaurant' || triggerResult.triggerType === 'food') {
        // Search for restaurants
        const restaurants = await this.googleSearchService.searchRestaurants(
          enhancedQuery,
          location
        );
        
        recommendationsMessage = this.googleSearchService.formatRestaurantRecommendations(
          restaurants,
          enhancedQuery,
          preferences
        );
      } else {
        // Search for general places/activities
        const results = await this.googleSearchService.searchPlaces(
          enhancedQuery,
          location
        );
        
        recommendationsMessage = this.googleSearchService.formatPlaceRecommendations(
          results,
          enhancedQuery,
          preferences
        );
      }

      if (!recommendationsMessage) {
        console.log('⚠️  No recommendations to send');
        return false;
      }

      // Validate chatId before sending (avoid sending to test/invalid chats)
      if (!message.chatId || message.chatId.startsWith('test-')) {
        console.warn(`⚠️  Skipping send recommendations to invalid/test chat ID: ${message.chatId}`);
        console.log(`Would send recommendations to chat ${message.chatId}:`);
        console.log(recommendationsMessage);
        // Still update history and cooldown
        this.lastRecommendationTime.set(message.chatId, Date.now());
        this.updateConversationHistory(message.chatId, {
          text: recommendationsMessage,
          sentAt: new Date().toISOString()
        }, true);
        // Store recommendation even for test chats
        await this.storeAIResponse(message.chatId, recommendationsMessage, null);
        return false;
      }

      // Send recommendations via API
      if (this.apiClient.enabled) {
        try {
          console.log(`📤 Sending recommendations to chat ${message.chatId} from ${this.senderPhoneNumber}...`);
          
          const result = await this.apiClient.sendMessage(
            message.chatId,
            recommendationsMessage,
            [],
            this.senderPhoneNumber
          );
          
          console.log(`✅ Successfully sent recommendations!`);
          console.log(`   Chat ID: ${message.chatId}`);
          console.log(`   Trigger type: ${triggerResult.triggerType}`);
          
          // Update cooldown
          this.lastRecommendationTime.set(message.chatId, Date.now());
          
          // Track what recommendation was sent
          if (!this.sentRecommendations.has(message.chatId)) {
            this.sentRecommendations.set(message.chatId, []);
          }
          this.sentRecommendations.get(message.chatId).push({
            type: triggerResult.triggerType,
            query: triggerResult.searchQuery,
            timestamp: Date.now()
          });
          
          // Keep only last 10 recommendations per chat
          const recs = this.sentRecommendations.get(message.chatId);
          if (recs.length > 10) {
            recs.shift();
          }
          
          // Update conversation history
          this.updateConversationHistory(message.chatId, {
            text: recommendationsMessage,
            sentAt: new Date().toISOString()
          }, true);
          
          // Store recommendation to conversations.json for better future recommendations
          // API response structure: { data: { id, ... } }
          const messageId = result?.data?.id || result?.id;
          await this.storeAIResponse(message.chatId, recommendationsMessage, messageId);
          
          // Log the recommendation for future reference
          console.log(`📝 Logged recommendation: ${triggerResult.triggerType} - "${enhancedQuery}" (location: ${location || 'none'})`);
          
          if (messageId) {
            console.log(`   Message ID: ${messageId}`);
          }
          
          return true;
        } catch (error) {
          console.error('❌ Error sending recommendations:', error);
          if (error.response) {
            console.error('   Response status:', error.response.status);
            console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
            // If it's a 404, the chat doesn't exist - don't retry
            if (error.response.status === 404) {
              console.error(`   ⚠️  Chat ${message.chatId} not found. This may be a test chat or invalid chat ID.`);
            }
          }
          return false;
        }
      } else {
        console.warn('⚠️  API client not enabled. Cannot send recommendations.');
        console.log(`Would send recommendations to chat ${message.chatId}:`);
        console.log(recommendationsMessage);
        // Still store recommendation for logging purposes
        await this.storeAIResponse(message.chatId, recommendationsMessage, null);
        return false;
      }
    } catch (error) {
      console.error('Error sending recommendations:', error);
      return false;
    }
  }

  /**
   * Set callback for when messages are received
   */
  setCallback(onMessageReceived) {
    this.onMessageReceivedCallback = onMessageReceived;
  }

  async start() {
    console.log(`AI Response Service started for ${this.senderPhoneNumber}`);
    console.log(`   Personality: Anime enthusiast, AI/tech lover, hackathon participant`);
    console.log(`   Model: ${this.model}`);
    console.log(`   Response strategy: Selective (only responds when needed)`);
    console.log(`   Min interval: ${this.minResponseInterval / 60000} minutes between responses`);
    console.log(`   Confidence threshold: ${this.responseConfidenceThreshold}`);
    console.log(`   Trigger detection: Enabled`);
    console.log(`   Google Search: ${this.googleSearchService.enabled ? 'Enabled' : 'Disabled'}`);
    
    if (!this.apiClient.enabled) {
      console.warn('⚠️  API client not enabled. AI responses will be logged but not sent.');
    }

    // Periodically reload conversation history from MongoDB to catch any new messages
    // Reload more frequently to ensure recommendations use latest conversations
    setInterval(async () => {
      try {
        await this.loadConversationHistory();
        console.log(`🔄 Reloaded conversation history from MongoDB (periodic refresh)`);
      } catch (error) {
        console.warn('Error reloading conversation history from MongoDB:', error.message);
      }
    }, 2 * 60 * 1000); // Reload every 2 minutes (increased frequency)
  }

  /**
   * Store AI response/recommendation to conversations.json
   * This ensures all conversations are logged for better recommendations
   */
  async storeAIResponse(chatId, responseText, messageId = null) {
    try {
      // Create a message object representing the AI response
      const aiMessage = {
        chatId: chatId,
        messageId: messageId || `ai-response-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        fromPhone: this.senderPhoneNumber,
        text: responseText,
        sentAt: new Date().toISOString(),
        chatHandles: [], // Will be populated from original message if needed
        attachments: [],
        isRead: false,
        service: 'AI',
        eventType: 'message.sent',
        createdAt: new Date().toISOString()
      };
      
      // Store via storage service (conversations are stored in MongoDB as they come in via Kafka)
      await this.storageService.storeConversation(aiMessage);
      console.log(`📝 Stored AI response in MongoDB`);
    } catch (error) {
      console.error('Error storing AI response:', error);
      // Don't throw - this is not critical for functionality
    }
  }

  /**
   * Use LLM to determine if a Google search is needed based on conversation context
   */
  async shouldPerformGoogleSearch(message, conversationContext) {
    try {
      const recentMessages = conversationContext.slice(-15); // Check last 15 messages for context
      const conversationText = recentMessages.map(msg => {
        const role = msg.role === 'assistant' ? 'Agent' : 'User';
        return `${role}: ${msg.content}`;
      }).join('\n');

      const currentMessage = message.text || '';
      
      const prompt = `Analyze the conversation and determine if a Google search would be helpful to answer the user's question or fulfill their request.

CRITICAL RULES:
- Only recommend a search if the user is ACTIVELY asking for information that requires current/real-time data
- Examples that NEED search:
  * User agrees to watch a match/game → search for "sports bars near [location]" or "places to watch [team] match"
  * User asks "where can we go?" after planning an activity → search for relevant venues
  * User asks "what's happening?" or "any events?" → search for events/activities
  * User asks for recommendations for places to do something specific
  * User agrees to meet/go somewhere and needs venue suggestions
- Examples that DON'T need search:
  * Casual conversation without planning intent
  * Questions that can be answered from conversation history
  * General questions that don't require location/venue data
  * User is just acknowledging something without asking for info

If a search is needed, determine:
1. What to search for (be specific and relevant to the conversation)
2. Search type: "restaurant", "sports_bar", "place", "event", or "general"
3. Location if mentioned or can be inferred

Respond with JSON in this exact format:
{
  "shouldSearch": true/false,
  "searchQuery": "specific search query string" | null,
  "searchType": "restaurant" | "sports_bar" | "place" | "event" | "general" | null,
  "location": "location if mentioned" | null,
  "reasoning": "brief explanation"
}

Conversation context:
${conversationText}

Current message: ${currentMessage}

JSON Response:`;

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at analyzing conversations to determine when Google search would be helpful. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3, // Lower temperature for more consistent decisions
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0].message.content.trim();
      let result;
      
      try {
        result = JSON.parse(content);
      } catch (parseError) {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          console.warn('Could not parse Google search decision response:', content);
          return { shouldSearch: false };
        }
      }

      if (!result.shouldSearch) {
        return { shouldSearch: false };
      }

      // Validate that we have a search query
      if (!result.searchQuery || result.searchQuery.trim().length === 0) {
        console.warn('LLM recommended search but no query provided');
        return { shouldSearch: false };
      }

      console.log(`✅ LLM determined search is needed: "${result.searchQuery}" (type: ${result.searchType || 'general'})`);
      console.log(`   Reasoning: ${result.reasoning || 'No reasoning provided'}`);

      return {
        shouldSearch: true,
        searchQuery: result.searchQuery.trim(),
        searchType: result.searchType || 'general',
        location: result.location || null,
        reasoning: result.reasoning || 'Search recommended by LLM'
      };
    } catch (error) {
      console.error('Error determining if Google search is needed:', error);
      return { shouldSearch: false };
    }
  }

  /**
   * Perform Google search and send formatted results
   */
  async performAndSendGoogleSearch(message, searchDecision) {
    try {
      if (!this.googleSearchService.enabled) {
        console.warn('⚠️  Google Search not enabled. Cannot perform search.');
        const fallbackMessage = `I'd like to help you with that, but I need Google Search enabled to find current information. Let me know if you'd like me to search for something specific! 🔍`;
        await this.apiClient.sendMessage(message.chatId, fallbackMessage, [], this.senderPhoneNumber);
        await this.storeAIResponse(message.chatId, fallbackMessage, null);
        return false;
      }

      const { searchQuery, searchType, location } = searchDecision;
      
      console.log(`🔍 Performing Google search: "${searchQuery}"${location ? ` in ${location}` : ''} (type: ${searchType})`);
      
      let results = [];
      let recommendationsMessage = '';

      // Perform search based on type
      switch (searchType) {
        case 'restaurant':
          results = await this.googleSearchService.searchRestaurants(searchQuery, location);
          const preferences = this.extractUserPreferences(await this.getConversationContext(message.chatId, 50, true));
          recommendationsMessage = this.googleSearchService.formatRestaurantRecommendations(
            results,
            searchQuery,
            preferences
          );
          break;
        
        case 'sports_bar':
          results = await this.googleSearchService.searchSportsBars(searchQuery, location);
          if (results && results.length > 0) {
            recommendationsMessage = `🏟️ Here are some places where you can watch:\n\n`;
            results.forEach((venue, index) => {
              recommendationsMessage += `${index + 1}. **${venue.name}**`;
              if (venue.rating) {
                const stars = '⭐'.repeat(Math.round(venue.rating));
                recommendationsMessage += ` ${stars} (${venue.rating}/5)`;
              }
              recommendationsMessage += `\n`;
              if (venue.address && venue.address !== 'Address not available') {
                recommendationsMessage += `   📍 ${venue.address}\n`;
              }
              if (venue.snippet) {
                const snippet = venue.snippet.length > 120 
                  ? venue.snippet.substring(0, 120) + '...'
                  : venue.snippet;
                recommendationsMessage += `   ${snippet}\n`;
              }
              recommendationsMessage += `\n`;
            });
            recommendationsMessage += `Hope you find a great spot! 🎉`;
          } else {
            recommendationsMessage = `I couldn't find specific places for that. Try searching for "sports bars near me" or let me know your location! 🏟️`;
          }
          break;
        
        case 'place':
        case 'event':
        case 'general':
        default:
          results = await this.googleSearchService.searchPlaces(searchQuery, location);
          const prefs = this.extractUserPreferences(await this.getConversationContext(message.chatId, 50, true));
          recommendationsMessage = this.googleSearchService.formatPlaceRecommendations(
            results,
            searchQuery,
            prefs
          );
          break;
      }

      if (!recommendationsMessage || recommendationsMessage.trim().length === 0) {
        recommendationsMessage = `I searched for "${searchQuery}" but couldn't find specific results. Try rephrasing your request or let me know more details! 🔍`;
      }

      console.log(`📤 Sending Google search results to chat ${message.chatId}...`);

      // Send recommendations
      const result = await this.apiClient.sendMessage(
        message.chatId,
        recommendationsMessage,
        [],
        this.senderPhoneNumber
      );

      console.log(`✅ Google search results sent successfully!`);
      
      // Store the response
      const messageId = result?.data?.id || result?.id;
      await this.storeAIResponse(message.chatId, recommendationsMessage, messageId);
      
      return true;
    } catch (error) {
      console.error('Error performing and sending Google search:', error);
      return false;
    }
  }

  /**
   * Check if we should react to a message based on sentiment and context
   */
  async checkAndReactToMessage(message, conversationContext) {
    try {
      // Skip if message is from sender (don't react to our own messages)
      if (this.isFromSender(message.fromPhone)) {
        return;
      }

      // Skip if we already reacted to this message
      if (this.reactedMessageIds.has(message.messageId)) {
        return;
      }

      console.log(`🎭 Checking if we should react to message ${message.messageId}...`);

      const recentMessages = conversationContext.slice(-10); // Last 10 messages for context
      const conversationText = recentMessages.map(msg => {
        const role = msg.role === 'assistant' ? 'Agent' : 'User';
        return `${role}: ${msg.content}`;
      }).join('\n');

      const currentMessage = message.text || '';
      
      const prompt = `Analyze the user's message and determine if it warrants a reaction based on sentiment and context.

Examples that warrant POSITIVE reactions (celebrations, achievements, good news):
- Favorite team won a match/game → "love" or "emphasize"
- Completed a goal (weight loss, fitness, learning) → "love" or "emphasize"
- Achieved a milestone → "love" or "emphasize"
- Good news or positive updates → "like" or "love"
- Expressing happiness or excitement → "laugh" or "love"
- Progress on goals → "like" or "emphasize"

Examples that warrant NEGATIVE reactions (sympathy, support):
- Favorite team lost → "dislike" (to show empathy)
- Disappointment or frustration → "dislike"
- Setbacks or challenges → "dislike" (to acknowledge difficulty)

Examples that DON'T warrant reactions:
- Casual conversation
- Questions
- Neutral statements
- Already reacted messages

Respond with JSON in this exact format:
{
  "shouldReact": true/false,
  "sentiment": "positive" | "negative" | null,
  "reactionType": "like" | "love" | "laugh" | "emphasize" | "dislike" | "question" | null,
  "reasoning": "brief explanation"
}

Available reaction types:
- "like" - General positive acknowledgment
- "love" - Strong positive emotion, achievements, celebrations
- "laugh" - Humor, fun, excitement
- "emphasize" - Important moments, milestones, emphasis
- "dislike" - Sympathy for negative events, acknowledging difficulty
- "question" - When user asks a question (rarely used)

Conversation context:
${conversationText}

Current message: ${currentMessage}

JSON Response:`;

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at analyzing messages for sentiment and determining appropriate reactions. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0].message.content.trim();
      let result;
      
      try {
        result = JSON.parse(content);
      } catch (parseError) {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          console.warn('Could not parse reaction decision response:', content);
          return;
        }
      }

      if (!result.shouldReact || !result.reactionType) {
        return;
      }

      console.log(`✅ Decided to react with ${result.reactionType} (${result.sentiment} sentiment)`);
      console.log(`   Reasoning: ${result.reasoning || 'No reasoning provided'}`);

      // Add reaction via API
      if (this.apiClient.enabled && message.messageId && !message.messageId.startsWith('context-')) {
        try {
          // Extract numeric message ID if it's a string
          const messageId = typeof message.messageId === 'string' 
            ? parseInt(message.messageId.replace('context-', '')) 
            : message.messageId;

          if (isNaN(messageId)) {
            console.warn(`⚠️  Invalid message ID for reaction: ${message.messageId}`);
            return;
          }

          await this.apiClient.addReaction(messageId, result.reactionType);
          console.log(`✅ Added reaction ${result.reactionType} to message ${messageId}`);
          
          // Mark as reacted to avoid duplicate reactions
          this.reactedMessageIds.add(message.messageId);
        } catch (error) {
          console.error('Error adding reaction:', error);
          // Don't throw - reaction failure shouldn't break the flow
        }
      } else {
        console.log(`Would react with ${result.reactionType} to message ${message.messageId} (API not enabled or invalid message ID)`);
      }
    } catch (error) {
      console.error('Error checking for reaction:', error);
      // Don't throw - reaction checking is not critical
    }
  }

  /**
   * Extract user preferences from conversation history
   * This helps make better, more personalized recommendations
   */
  extractUserPreferences(conversationHistory) {
    const preferences = {
      cuisine: null,
      location: null,
      priceRange: null,
      mentionedPlaces: []
    };

    // Analyze last 50 messages for preferences
    const historyToAnalyze = conversationHistory.slice(-50);
    
    // Common cuisine types (prioritize most recent mentions)
    const cuisineKeywords = [
      'indian', 'italian', 'chinese', 'japanese', 'mexican', 'thai', 'korean',
      'french', 'mediterranean', 'american', 'pizza', 'sushi', 'bbq', 'steak',
      'seafood', 'vegetarian', 'vegan', 'halal', 'kosher', 'tacos', 'burgers',
      'pasta', 'ramen', 'curry', 'sashimi'
    ];

    // Extract most recent cuisine preference
    for (let i = historyToAnalyze.length - 1; i >= 0; i--) {
      const text = (historyToAnalyze[i].content || '').toLowerCase();
      for (const cuisine of cuisineKeywords) {
        if (text.includes(cuisine)) {
          preferences.cuisine = cuisine;
          break;
        }
      }
      if (preferences.cuisine) break;
    }

    // Extract most recent location preference
    const locationPatterns = [
      /(?:in|near|at|around|to)\s+([A-Z][a-zA-Z\s]+(?:City|Town|NYC|NY|CA|LA|SF|San Francisco|New York|Los Angeles|Brooklyn|Manhattan|Queens|Bronx)?)/i,
      /\b(NYC|NY|New York|Los Angeles|LA|San Francisco|SF|Chicago|Houston|Phoenix|Philadelphia|San Antonio|San Diego|Dallas|San Jose|Austin|Jacksonville|Fort Worth|Columbus|Charlotte|Indianapolis|Seattle|Denver|Washington|Boston|Brooklyn|Manhattan|Queens|Bronx)\b/i
    ];

    for (let i = historyToAnalyze.length - 1; i >= 0; i--) {
      const text = historyToAnalyze[i].content || '';
      for (const pattern of locationPatterns) {
        const match = text.match(pattern);
        if (match) {
          preferences.location = (match[1] || match[0]).trim();
          break;
        }
      }
      if (preferences.location) break;
    }

    // Extract price range preferences
    const priceKeywords = ['cheap', 'affordable', 'budget', 'expensive', 'upscale', 'fine dining', 'casual'];
    for (let i = historyToAnalyze.length - 1; i >= 0; i--) {
      const text = (historyToAnalyze[i].content || '').toLowerCase();
      for (const keyword of priceKeywords) {
        if (text.includes(keyword)) {
          preferences.priceRange = keyword;
          break;
        }
      }
      if (preferences.priceRange) break;
    }

    return preferences;
  }

  async stop() {
    console.log('AI Response Service stopped');
  }
}

module.exports = AIResponseService;
