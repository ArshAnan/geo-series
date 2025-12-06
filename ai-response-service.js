// AI Response Service - Generates and sends AI responses for the 646... number
require('dotenv').config();
const OpenAI = require('openai');
const SeriesAPIClient = require('./api-client');
const config = require('./config.json');
const fs = require('fs-extra');
const path = require('path');
const TriggerDetector = require('./trigger-detector');
const GoogleSearchService = require('./google-search-service');

class AIResponseService {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY must be set in .env');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.model = config.openaiModel || 'gpt-4o';
    this.apiClient = new SeriesAPIClient();
    this.senderPhoneNumber = config.senderPhoneNumber || '+16463458837';
    
    // Track conversation history per chat for context
    this.conversationHistory = new Map(); // chatId -> array of messages
    
    // Track processed messages to avoid responding to the same message twice
    this.processedMessageIds = new Set();
    
    // Initialize trigger detector and Google search service
    this.triggerDetector = new TriggerDetector();
    this.googleSearchService = new GoogleSearchService();
    
    // Track if we've sent recommendations recently to avoid spam
    this.lastRecommendationTime = new Map(); // chatId -> timestamp
    this.recommendationCooldown = 5 * 60 * 1000; // 5 minutes cooldown between recommendations
    
    // Load conversation history from storage
    this.loadConversationHistory();
    
    // Callback for when a message is received
    this.onMessageReceivedCallback = null;
  }

  /**
   * Load conversation history from stored conversations
   */
  async loadConversationHistory() {
    try {
      const conversationsFile = path.join(__dirname, 'logs', 'conversations.json');
      if (await fs.pathExists(conversationsFile)) {
        const conversations = await fs.readJson(conversationsFile);
        
        // Group conversations by chatId
        conversations.forEach(msg => {
          if (!this.conversationHistory.has(msg.chatId)) {
            this.conversationHistory.set(msg.chatId, []);
          }
          this.conversationHistory.get(msg.chatId).push({
            role: this.isFromSender(msg.fromPhone) ? 'assistant' : 'user',
            content: msg.text || '',
            timestamp: msg.sentAt
          });
        });
        
        // Sort by timestamp
        this.conversationHistory.forEach((messages, chatId) => {
          messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        });
        
        console.log(`Loaded conversation history for ${this.conversationHistory.size} chats`);
      }
    } catch (error) {
      console.warn('Could not load conversation history:', error.message);
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
   */
  getConversationContext(chatId, maxMessages = 20) {
    const history = this.conversationHistory.get(chatId) || [];
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
    history.push({
      role: isFromSender ? 'assistant' : 'user',
      content: message.text || '',
      timestamp: message.sentAt
    });
    
    // Keep only last 50 messages to avoid memory issues
    if (history.length > 50) {
      history.shift();
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

Don't be overly formal. Use casual language as if texting a friend.`;

      // Build conversation messages for context
      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      // Add conversation history (last 10 messages for context)
      const recentContext = conversationContext.slice(-10);
      recentContext.forEach(msg => {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      });

      // Add the current message
      messages.push({
        role: 'user',
        content: message.text || ''
      });

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

      // Check if we should respond
      if (!this.shouldRespond(message)) {
        console.log(`🤖 AI Response: Not responding to message ${message.messageId}`);
        return;
      }

      console.log(`🤖 AI Response Service: Processing message ${message.messageId} from ${message.fromPhone}`);

      // Get conversation context
      const context = this.getConversationContext(message.chatId);
      
      // Check for triggers that require recommendations
      const triggerResult = await this.checkForTriggers(message, context);
      
      let recommendationSent = false;
      
      // If trigger detected, send recommendations
      if (triggerResult.shouldTrigger && triggerResult.searchQuery) {
        recommendationSent = await this.sendRecommendations(message, triggerResult);
      }
      
      // Generate regular AI response (always, or skip if we just sent recommendations)
      if (!recommendationSent || config.alwaysSendResponseAfterRecommendations !== false) {
        console.log(`💭 Generating AI response...`);
        const responseText = await this.generateResponse(message, context);
        console.log(`✅ Generated response: "${responseText}"`);

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
            if (result && result.id) {
              console.log(`   Message ID: ${result.id}`);
            }
            
            // Update conversation history with our response
            this.updateConversationHistory(message.chatId, {
              text: responseText,
              sentAt: new Date().toISOString()
            }, true);
          } catch (error) {
            console.error('❌ Error sending AI response:', error);
            if (error.response) {
              console.error('   Response status:', error.response.status);
              console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
            }
            console.error('   Full error:', error.message);
            // Don't mark as processed if sending failed, so we can retry
            return;
          }
        } else {
          console.warn('⚠️  API client not enabled. Cannot send AI response.');
          console.log(`Would send to chat ${message.chatId}: "${responseText}"`);
          console.log(`   From: ${this.senderPhoneNumber}`);
        }
      }

      // Update conversation history with incoming message
      this.updateConversationHistory(message.chatId, message, false);

      // Mark as processed
      this.processedMessageIds.add(message.messageId);
    } catch (error) {
      console.error('Error processing message for AI response:', error);
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

      console.log(`🔍 Checking for triggers in conversation...`);
      const triggerResult = await this.triggerDetector.detectTriggers(conversationContext, message);
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
      
      let recommendationsMessage = '';
      
      // Determine search type and perform search
      if (triggerResult.triggerType === 'restaurant' || triggerResult.triggerType === 'food') {
        // Search for restaurants
        const location = triggerResult.location || null;
        const restaurants = await this.googleSearchService.searchRestaurants(
          triggerResult.searchQuery,
          location
        );
        
        recommendationsMessage = this.googleSearchService.formatRestaurantRecommendations(
          restaurants,
          triggerResult.searchQuery
        );
      } else {
        // Search for general places/activities
        const location = triggerResult.location || null;
        const results = await this.googleSearchService.searchPlaces(
          triggerResult.searchQuery,
          location
        );
        
        recommendationsMessage = this.googleSearchService.formatPlaceRecommendations(
          results,
          triggerResult.searchQuery
        );
      }

      if (!recommendationsMessage) {
        console.log('⚠️  No recommendations to send');
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
          
          // Update conversation history
          this.updateConversationHistory(message.chatId, {
            text: recommendationsMessage,
            sentAt: new Date().toISOString()
          }, true);
          
          if (result && result.id) {
            console.log(`   Message ID: ${result.id}`);
          }
          
          return true;
        } catch (error) {
          console.error('❌ Error sending recommendations:', error);
          if (error.response) {
            console.error('   Response status:', error.response.status);
            console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
          }
          return false;
        }
      } else {
        console.warn('⚠️  API client not enabled. Cannot send recommendations.');
        console.log(`Would send recommendations to chat ${message.chatId}:`);
        console.log(recommendationsMessage);
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
    console.log(`   Trigger detection: Enabled`);
    console.log(`   Google Search: ${this.googleSearchService.enabled ? 'Enabled' : 'Disabled'}`);
    
    if (!this.apiClient.enabled) {
      console.warn('⚠️  API client not enabled. AI responses will be logged but not sent.');
    }
  }

  async stop() {
    console.log('AI Response Service stopped');
  }
}

module.exports = AIResponseService;
