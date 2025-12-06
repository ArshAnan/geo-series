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

class AIResponseService {
  constructor() {
    if (!process.env.OPENAI_API_MY_KEY) {
      throw new Error('OPENAI_API_MY_KEY must be set in .env');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_MY_KEY
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
    this.storageService = new StorageService();
    
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
   * Load conversation history from stored conversations
   * This merges with existing history, avoiding duplicates
   */
  async loadConversationHistory() {
    try {
      const conversationsFile = path.join(__dirname, 'logs', 'conversations.json');
      if (await fs.pathExists(conversationsFile)) {
        const conversations = await fs.readJson(conversationsFile);
        
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
        
        // Group conversations by chatId
        conversations.forEach(msg => {
          // Skip if we've already loaded this message
          if (loadedMessageIds.has(msg.messageId)) {
            return;
          }
          
          if (!this.conversationHistory.has(msg.chatId)) {
            this.conversationHistory.set(msg.chatId, []);
          }
          
          this.conversationHistory.get(msg.chatId).push({
            role: this.isFromSender(msg.fromPhone) ? 'assistant' : 'user',
            content: msg.text || '',
            timestamp: msg.sentAt,
            messageId: msg.messageId // Store messageId to track duplicates
          });
          
          loadedMessageIds.add(msg.messageId);
          newMessagesCount++;
        });
        
        // Sort by timestamp
        this.conversationHistory.forEach((messages, chatId) => {
          messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          // Keep more messages in memory for better recommendations (increased from 100 to 200)
          if (messages.length > 200) {
            messages.splice(0, messages.length - 200);
          }
        });
        
        if (newMessagesCount > 0) {
          console.log(`📚 Reloaded conversation history: ${newMessagesCount} new messages across ${this.conversationHistory.size} chats`);
        }
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
   * Optionally loads directly from file for more complete history
   */
  async getConversationContext(chatId, maxMessages = 20, loadFromFile = false) {
    let history = this.conversationHistory.get(chatId) || [];
    
    // If we need more history or want to load from file, load directly from conversations.json
    if (loadFromFile || history.length < maxMessages) {
      try {
        const conversationsFile = path.join(__dirname, 'logs', 'conversations.json');
        if (await fs.pathExists(conversationsFile)) {
          const conversations = await fs.readJson(conversationsFile);
          // Filter for this chat and convert to conversation history format
          const chatMessages = conversations
            .filter(msg => msg.chatId === chatId)
            .map(msg => ({
              role: this.isFromSender(msg.fromPhone) ? 'assistant' : 'user',
              content: msg.text || '',
              timestamp: msg.sentAt,
              messageId: msg.messageId
            }))
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          
          // Use file history if it's more complete or if explicitly requested
          if (loadFromFile || chatMessages.length > history.length) {
            history = chatMessages;
          }
        }
      } catch (error) {
        console.warn('Error loading conversation context from file:', error.message);
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

      // Build context for analysis (conversationContext is already loaded from file)
      const recentMessages = conversationContext.slice(-10);
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

      // Add conversation history (last 15 messages for better context)
      // The conversationContext already includes the current message since we updated history first
      const recentContext = conversationContext.slice(-15);
      recentContext.forEach(msg => {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      });

      // The current message should already be in recentContext, but add it explicitly if needed
      // (it should be the last message in recentContext since we updated history first)

      console.log(`📝 Generating response with ${messages.length - 1} context messages (including current message)`);

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

      // Get conversation context (now includes the current message we just added)
      // Load from file to ensure we have all logged conversations for better recommendations
      const context = await this.getConversationContext(message.chatId, 50, true);
      console.log(`📚 Using ${context.length} messages for context (loaded from conversations.json)`);
      
      // Check for triggers that require recommendations
      const triggerResult = await this.checkForTriggers(message, context);
      
      let recommendationSent = false;
      
      // If trigger detected, send recommendations (this is always valuable, so send it)
      if (triggerResult.shouldTrigger && triggerResult.searchQuery) {
        recommendationSent = await this.sendRecommendations(message, triggerResult);
        // Update last response time
        this.lastResponseTime.set(message.chatId, Date.now());
        // If we sent recommendations, skip regular response (recommendations are enough)
        console.log(`✅ Sent recommendations - skipping regular response to avoid being too active`);
        this.processedMessageIds.add(message.messageId);
        return;
      }
      
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
          // Still update history and mark as processed
          this.updateConversationHistory(message.chatId, {
            text: responseText,
            sentAt: new Date().toISOString()
          }, true);
          this.processedMessageIds.add(message.messageId);
          return;
        }

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
            
            // Store AI response to conversations.json for better recommendations
            await this.storeAIResponse(message.chatId, responseText, result.id);
            
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
                // Still mark as processed to avoid retrying
                this.processedMessageIds.add(message.messageId);
                return;
              }
            }
            console.error('   Full error:', error.message);
            // Don't mark as processed if sending failed (unless it's a 404), so we can retry
            return;
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
      } else {
        console.log(`⏭️  Skipping AI response - not needed (${responseNecessity.reason})`);
      }

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
      // Load directly from file to ensure we have ALL logged conversations for recommendations
      const fullHistory = await this.getConversationContext(message.chatId, 100, true);
      console.log(`📚 Using ${fullHistory.length} messages from conversations.json for recommendation context`);
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
          await this.storeAIResponse(message.chatId, recommendationsMessage, result.id);
          
          // Log the recommendation for future reference
          console.log(`📝 Logged recommendation: ${triggerResult.triggerType} - "${enhancedQuery}" (location: ${location || 'none'})`);
          
          if (result && result.id) {
            console.log(`   Message ID: ${result.id}`);
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

    // Periodically reload conversation history from storage to catch any messages
    // that might have been stored by other processes or missed
    // Reload more frequently to ensure recommendations use latest conversations
    setInterval(async () => {
      try {
        await this.loadConversationHistory();
        console.log(`🔄 Reloaded conversation history from storage (periodic refresh)`);
      } catch (error) {
        console.warn('Error reloading conversation history:', error.message);
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
      
      // Store via storage service
      await this.storageService.storeConversation(aiMessage);
      console.log(`📝 Stored AI response to conversations.json for better recommendations`);
    } catch (error) {
      console.error('Error storing AI response:', error);
      // Don't throw - this is not critical for functionality
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
