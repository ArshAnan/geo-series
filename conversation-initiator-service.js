// Conversation Initiator Service - Proactively initiates conversations based on shared interests
require('dotenv').config();
const OpenAI = require('openai');
const SeriesAPIClient = require('./api-client');
const config = require('./config.json');
const GoogleSearchService = require('./google-search-service');
const DatabaseService = require('./database-service');

class ConversationInitiatorService {
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
    this.db = new DatabaseService();
    this.targetChatId = targetChatId || config.chatId; // Use configured chat ID if provided
    
    // Configuration
    this.checkInterval = (config.conversationInitiatorIntervalMinutes || 2) * 60 * 1000; // Default: 2 minutes
    this.minInactivityMinutes = config.conversationInitiatorMinInactivityMinutes || 2; // Default: 2 minutes
    this.maxInitiationFrequency = config.conversationInitiatorMaxFrequency || 1; // Max initiations per day per chat
    
    // Track when we last initiated conversations
    this.lastInitiationTime = new Map(); // chatId -> timestamp
    this.initiationCount = new Map(); // chatId -> count (reset daily)
    this.lastResetDate = new Date().toDateString();
    
    // Track last message time per chat to determine inactivity
    this.lastMessageTime = new Map(); // chatId -> timestamp
    
    // Interval timer
    this.checkIntervalId = null;
    
    // Initialize Google Search Service for current events
    this.googleSearchService = new GoogleSearchService();
    
    // Rate limiting for Google Search API
    this.lastGoogleSearchTime = 0;
    this.googleSearchCooldown = 10 * 1000; // 10 seconds between searches
    this.googleSearchRateLimitHit = false;
    this.googleSearchRateLimitResetTime = 0;
    this.googleSearchRateLimitResetDuration = 60 * 60 * 1000; // 1 hour cooldown if rate limited
  }

  /**
   * Load key moments from MongoDB
   */
  async loadKeyMoments() {
    try {
      return await this.db.getAllKeyMoments();
    } catch (error) {
      console.error('Error loading key moments:', error);
      return [];
    }
  }

  /**
   * Load conversations from API for a specific chat
   * Fetches messages for the target chat ID only
   */
  async loadConversationsForChat(chatId) {
    if (!chatId) {
      return [];
    }

    try {
      // Load from MongoDB instead of API - more reliable and faster
      // Get all messages for this chat from MongoDB
      const messages = await this.db.getConversationsByChat(String(chatId), 10000);
      
      if (!Array.isArray(messages) || messages.length === 0) {
        console.log(`   📥 No messages found in MongoDB for chat ${chatId}`);
        return [];
      }

      // Sort by sentAt timestamp (oldest first) to ensure chronological order
      messages.sort((a, b) => {
        const timeA = new Date(a.sentAt).getTime();
        const timeB = new Date(b.sentAt).getTime();
        return timeA - timeB;
      });

      console.log(`   📥 Loaded ${messages.length} messages from MongoDB for chat ${chatId}`);
      
      return messages;
    } catch (error) {
      console.warn(`   ⚠️  Error loading messages from MongoDB for chat ${chatId}:`, error.message);
      return [];
    }
  }

  /**
   * Load conversations from API (deprecated - use loadConversationsForChat instead)
   * Kept for backward compatibility but only loads target chat
   */
  async loadConversations() {
    if (!this.targetChatId) {
      return [];
    }
    return await this.loadConversationsForChat(this.targetChatId);
  }
  
  /**
   * Check if message is from sender phone number
   */
  isFromSender(fromPhone) {
    return fromPhone === this.senderPhoneNumber;
  }

  /**
   * Get shared interests for a specific chat
   */
  getSharedInterestsForChat(keyMoments, chatId) {
    return keyMoments.filter(moment => 
      moment.chatId === chatId && 
      moment.type === 'shared_interest' &&
      moment.confidence >= 0.3 // Lower threshold for hackathon - capture more moments
    );
  }

  /**
   * Generate a generic conversation starter when no shared interests are available
   */
  async generateGenericConversationStarter(conversationHistory = [], isGroupChat = false) {
    try {
      const now = new Date();
      const currentDate = now.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });

      const groupChatInstruction = isGroupChat 
        ? `\n\nCRITICAL: This is a GROUP CHAT with multiple participants. Address BOTH (or ALL) participants in your message. Use "you both", "you all", or ask questions that engage everyone. Make sure the conversation starter is inclusive and addresses the group, not just one person.`
        : '';

      const systemPrompt = `You are a friendly person who wants to start a natural conversation. 
The commonality between you and the other person is that you are both founders and investors. This is your primary connection point.
Generate a casual, engaging conversation starter (1 sentence max, rarely 2 if absolutely necessary). 
Be genuine, friendly, and not overly formal. Use emojis sparingly (maybe 1 if appropriate).
The message should feel like a natural text message, not a formal email.
CRITICAL: Keep it SHORT - one sentence is ideal. Be brief and conversational.

IMPORTANT: 
- Consider the conversation history - reference previous topics, continue threads, or build on what was discussed before.
- Focus on topics relevant to founders and investors - startups, funding, business, entrepreneurship, investments, etc.
- Keep the conversation natural and don't force founder/investor topics if the conversation flows elsewhere.${groupChatInstruction}`;

      // Build conversation history context - only use the last 2-3 messages
      let historyContext = '';
      if (conversationHistory && conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-3); // Last 3 messages for context
        historyContext = `\n\nPrevious Conversation Context (most recent messages):
${recentHistory.map((msg, idx) => {
          const role = msg.isFromSender ? 'You' : 'Them';
          const time = new Date(msg.sentAt).toLocaleString();
          return `${role} (${time}): ${msg.text}`;
        }).join('\n')}

Use this conversation history to make your starter more relevant. You can reference previous topics, continue a discussion, or build on what was talked about before.`;
      }

      const userPrompt = `Generate a friendly conversation starter. It's ${currentDate}. 
Make it natural and engaging. You could reference the day of the week, ask how they're doing, 
or mention something light and friendly. Keep it casual and warm.${historyContext}`;

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.8,
        max_tokens: 80 // Keep generic starters very short
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating generic conversation starter:', error);
      // Fallback to a simple message
      return `Hey! How's it going? 👋`;
    }
  }

  /**
   * Check if we've already initiated a conversation today for this chat
   * DISABLED: Now allows unlimited initiations as long as inactivity threshold is met
   */
  hasInitiatedToday(chatId) {
    // Disabled - allow unlimited initiations
    return false;
  }

  /**
   * Check if the introduction message has been sent
   * Checks for actual messages from the agent, not just records
   */
  async hasIntroductionBeenSent(chatId) {
    try {
      // First check if there are actual messages from the agent in the chat
      await this.db.connect();
      const messages = await this.db.getConversationsByChat(String(chatId), 100);
      await this.db.disconnect();
      
      // Check if any message is from the sender (agent)
      const hasAgentMessage = messages.some(msg => this.isFromSender(msg.fromPhone));
      
      if (!hasAgentMessage) {
        console.log(`   📋 No messages from agent found in chat ${chatId} - introduction needed`);
        return false;
      }
      
      // Also check for introduction record to be sure
      await this.db.connect();
      const initiations = await this.db.getInitiationsByChat(String(chatId), 100);
      await this.db.disconnect();
      
      const hasIntroductionRecord = initiations.some(init => init.interestDescription === 'introduction');
      
      if (hasAgentMessage && hasIntroductionRecord) {
        console.log(`   ✅ Introduction already sent (found agent messages and introduction record for chat ${chatId})`);
        return true;
      }
      
      // If agent has sent messages but no introduction record, still consider it sent
      if (hasAgentMessage) {
        console.log(`   ✅ Agent has sent messages in chat ${chatId} - assuming introduction was sent`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error(`   ⚠️  Error checking introduction status:`, error.message);
      // If we can't check, assume introduction was NOT sent to ensure we send it
      return false;
    }
  }

  /**
   * Generate the introduction message introducing Rahul and Arsh
   */
  generateIntroductionMessage() {
    return `Hey! 👋 I'm connecting you both here.

Rahul is a startup founder working in the AI space, and is looking to raise funds for his startup.

Arsh is a well-reputed investor in the space, and could be a potential investor for Rahul.

I thought it would be great to connect you both! Feel free to take it from here. 🚀`;
  }

  /**
   * Record that the introduction has been sent
   */
  async recordIntroduction(chatId, messageText) {
    try {
      await this.db.connect();
      const initiation = {
        chatId: String(chatId),
        date: new Date().toISOString().split('T')[0],
        interestDescription: 'introduction',
        messageText: messageText,
        initiatedAt: new Date().toISOString()
      };
      await this.db.recordInitiation(initiation);
      await this.db.disconnect();
      console.log(`   ✅ Recorded introduction for chat ${chatId}`);
    } catch (error) {
      console.error(`   ⚠️  Error recording introduction:`, error.message);
    }
  }

  /**
   * Get the introduction record for a chat
   */
  async getIntroductionRecord(chatId) {
    try {
      await this.db.connect();
      const initiations = await this.db.getInitiationsByChat(String(chatId));
      await this.db.disconnect();
      
      // Find the introduction record
      const introduction = initiations.find(init => init.interestDescription === 'introduction');
      return introduction || null;
    } catch (error) {
      console.error(`   ⚠️  Error getting introduction record:`, error.message);
      return null;
    }
  }

  /**
   * Send introduction message immediately on startup (always sends)
   */
  async sendIntroductionIfNeeded() {
    try {
      // Only check the target chat ID if configured
      if (!this.targetChatId) {
        console.log('   No target chat ID configured. Skipping introduction.');
        return;
      }
      
      const targetChatId = String(this.targetChatId);
      console.log(`   👋 Sending introduction message immediately on startup...`);
      const introductionMessage = this.generateIntroductionMessage();
      
      if (this.apiClient.enabled) {
        try {
          console.log(`   📤 Sending introduction message to chat ${targetChatId}...`);
          const result = await this.apiClient.sendMessage(
            targetChatId,
            introductionMessage,
            [],
            this.senderPhoneNumber
          );
          
          const messageId = result?.data?.id || result?.id || result?.message_id || result?.chat_message?.id;
          if (messageId) {
            console.log(`   ✅ Introduction message sent successfully on startup (ID: ${messageId})`);
            
            // Record the introduction
            await this.recordIntroduction(targetChatId, introductionMessage);
          } else {
            console.warn(`   ⚠️  Introduction message may not have been sent (no message ID in response)`);
            // Still record it
            await this.recordIntroduction(targetChatId, introductionMessage);
          }
        } catch (error) {
          console.error(`   ❌ Error sending introduction message on startup:`, error);
          // Still record it even if sending failed
          await this.recordIntroduction(targetChatId, introductionMessage);
        }
      } else {
        console.log(`   📝 Introduction message (API not enabled, would send):`);
        console.log(`   "${introductionMessage}"`);
        await this.recordIntroduction(targetChatId, introductionMessage);
      }
    } catch (error) {
      console.error('Error in sendIntroductionIfNeeded:', error);
    }
  }

  /**
   * Check if chat has been inactive long enough
   */
  isChatInactive(chatId, conversations) {
    // Get the most recent message for this chat
    const chatMessages = conversations
      .filter(msg => msg.chatId === chatId)
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
    
    if (chatMessages.length === 0) {
      // No messages yet - can initiate
      return true;
    }
    
    const lastMessage = chatMessages[0];
    const lastMessageTime = new Date(lastMessage.sentAt).getTime();
    const now = Date.now();
    const inactivityMinutes = (now - lastMessageTime) / (1000 * 60);
    
    return inactivityMinutes >= this.minInactivityMinutes;
  }

  /**
   * Check if we've already sent this type of initiation
   */
  async hasAlreadyInitiated(chatId, interestDescription) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const initiations = await this.db.getInitiationsByChatAndDate(chatId, today);
      
      return initiations.some(init => 
        init.interestDescription === interestDescription
      );
    } catch (error) {
      console.error('Error checking initiated conversations:', error);
      return false;
    }
  }

  /**
   * Check if we've initiated about this interest recently (within specified minutes)
   */
  async hasRecentlyInitiated(chatId, interestDescription, minutesAgo = 60) {
    try {
      const cutoffTime = Date.now() - (minutesAgo * 60 * 1000);
      const today = new Date().toISOString().split('T')[0];
      const initiations = await this.db.getInitiationsByChatAndDate(chatId, today);
      
      return initiations.some(init => {
        if (init.interestDescription === interestDescription) {
          const initiatedTime = new Date(init.initiatedAt).getTime();
          return initiatedTime > cutoffTime;
        }
        return false;
      });
    } catch (error) {
      console.error('Error checking recent initiations:', error);
      return false;
    }
  }

  /**
   * Get recent initiations to check for diversity
   */
  async getRecentInitiations(chatId, hoursAgo = 24) {
    try {
      const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);
      const today = new Date().toISOString().split('T')[0];
      const initiations = await this.db.getInitiationsByChatAndDate(chatId, today);
      
      return initiations.filter(init => {
        const initiatedTime = new Date(init.initiatedAt).getTime();
        return initiatedTime > cutoffTime;
      });
    } catch (error) {
      console.error('Error getting recent initiations:', error);
      return [];
    }
  }

  /**
   * Categorize an interest to help with diversity
   */
  categorizeInterest(interestDescription) {
    const desc = interestDescription.toLowerCase();
    
    // Business/Startup category
    if (desc.includes('startup') || desc.includes('business') || desc.includes('company') ||
        desc.includes('venture') || desc.includes('entrepreneur') || desc.includes('founder')) {
      return 'business';
    }
    
    // Investment category
    if (desc.includes('invest') || desc.includes('funding') || desc.includes('capital') ||
        desc.includes('vc') || desc.includes('angel') || desc.includes('portfolio')) {
      return 'investment';
    }
    
    // Technology category
    if (desc.includes('tech') || desc.includes('ai') || desc.includes('software') ||
        desc.includes('product') || desc.includes('platform')) {
      return 'technology';
    }
    
    // Default to 'other'
    return 'other';
  }

  /**
   * Select a diverse interest from available shared interests
   * Prioritizes interests that haven't been used recently
   */
  async selectDiverseInterest(sharedInterests, chatId) {
    if (sharedInterests.length === 0) {
      return null;
    }

    // Get recent initiations to see what we've been using
    const recentInitiations = await this.getRecentInitiations(chatId, 24); // Last 24 hours
    const recentCategories = recentInitiations.map(init => 
      this.categorizeInterest(init.interestDescription)
    );
    
    // Count category usage
    const categoryCounts = {};
    recentCategories.forEach(cat => {
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
    
    console.log(`   📊 Recent initiation categories: ${JSON.stringify(categoryCounts)}`);
    
    // Categorize all available interests
    const categorizedInterests = sharedInterests.map(interest => ({
      interest,
      category: this.categorizeInterest(interest.description),
      confidence: interest.confidence || 0.5,
      date: new Date(interest.extractedAt || interest.date).getTime()
    }));
    
    // Score each interest based on:
    // 1. Lower category usage = higher score (diversity bonus)
    // 2. Higher confidence = higher score
    // 3. More recent = higher score
    // 4. Penalty for cricket/sports if sports have been used a lot
    const scoredInterests = categorizedInterests.map(item => {
      const categoryUsage = categoryCounts[item.category] || 0;
      const diversityScore = 1 / (1 + categoryUsage); // Less used categories get higher score
      
      const score = diversityScore * item.confidence;
      
      return {
        ...item,
        score
      };
    });
    
    // Sort by score (highest first)
    scoredInterests.sort((a, b) => b.score - a.score);
    
    console.log(`   🎯 Interest selection scores:`);
    scoredInterests.slice(0, 3).forEach((item, idx) => {
      console.log(`      ${idx + 1}. ${item.interest.description.substring(0, 50)} (${item.category}, score: ${item.score.toFixed(3)})`);
    });
    
    return scoredInterests[0].interest;
  }

  /**
   * Record that we initiated a conversation
   */
  async recordInitiation(chatId, interestDescription, messageText) {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      await this.db.recordInitiation({
        chatId,
        date: today,
        interestDescription,
        messageText,
        initiatedAt: new Date().toISOString()
      });
      
      // Update in-memory counters
      const count = this.initiationCount.get(chatId) || 0;
      this.initiationCount.set(chatId, count + 1);
      this.lastInitiationTime.set(chatId, Date.now());
    } catch (error) {
      console.error('Error recording initiation:', error);
    }
  }

  /**
   * Get current events related to a shared interest using web search
   * Includes rate limiting to avoid hitting API limits
   */
  async getCurrentEventsForInterest(sharedInterest) {
    if (!this.googleSearchService.enabled) {
      return null;
    }

    // Check if we're currently rate limited
    const now = Date.now();
    if (this.googleSearchRateLimitHit) {
      if (now < this.googleSearchRateLimitResetTime) {
        const minutesRemaining = Math.ceil((this.googleSearchRateLimitResetTime - now) / (60 * 1000));
        console.log(`   ⏸️  Google Search API rate limited. Skipping search (cooldown: ${minutesRemaining} minutes remaining)`);
        return null;
      } else {
        // Rate limit period has passed, reset
        console.log(`   ✅ Google Search API rate limit cooldown expired. Resuming searches.`);
        this.googleSearchRateLimitHit = false;
        this.googleSearchRateLimitResetTime = 0;
      }
    }

    // Check cooldown between searches
    const timeSinceLastSearch = now - this.lastGoogleSearchTime;
    if (timeSinceLastSearch < this.googleSearchCooldown) {
      const secondsRemaining = Math.ceil((this.googleSearchCooldown - timeSinceLastSearch) / 1000);
      console.log(`   ⏸️  Google Search cooldown active. Skipping search (${secondsRemaining}s remaining)`);
      return null;
    }

    try {
      // Extract keywords from the shared interest description
      const interestText = sharedInterest.description.toLowerCase();
      
      // For founder/investor focused interests, we'll let OpenAI handle it with current date context
      // This reduces API calls and keeps things simple
      return null;
    } catch (error) {
      // Check if it's a rate limit error (429)
      if (error.response && error.response.status === 429) {
        console.warn('   ⚠️  Google Search API rate limit hit (429). Enabling cooldown period.');
        this.googleSearchRateLimitHit = true;
        this.googleSearchRateLimitResetTime = now + this.googleSearchRateLimitResetDuration;
        console.warn(`   ⏸️  Google Search API disabled for ${this.googleSearchRateLimitResetDuration / (60 * 1000)} minutes`);
        return null;
      }
      
      // For other errors, log and continue
      console.warn('   ⚠️  Error searching for current events:', error.message);
      if (error.response) {
        console.warn(`      Status: ${error.response.status}, StatusText: ${error.response.statusText}`);
      }
      return null;
    }
  }

  /**
   * Get conversation history for a specific chat
   */
  getConversationHistoryForChat(chatId, conversations, maxMessages = 20) {
    // Filter messages for this chat only
    const chatMessages = conversations.filter(msg => String(msg.chatId) === String(chatId));
    
    // Deduplicate by messageId (extra safety)
    const messageMap = new Map();
    chatMessages.forEach(msg => {
      const messageId = String(msg.messageId || msg.id);
      if (messageId && !messageMap.has(messageId)) {
        messageMap.set(messageId, msg);
      }
    });
    
    // Sort by timestamp (oldest first) to ensure chronological order
    const sortedMessages = Array.from(messageMap.values())
      .sort((a, b) => {
        const timeA = new Date(a.sentAt).getTime();
        const timeB = new Date(b.sentAt).getTime();
        return timeA - timeB;
      })
      .slice(-maxMessages); // Get last N messages
    
    // Log for debugging
    if (sortedMessages.length > 0) {
      const firstMsg = sortedMessages[0];
      const lastMsg = sortedMessages[sortedMessages.length - 1];
      console.log(`   📚 Conversation history: ${sortedMessages.length} messages (from ${new Date(firstMsg.sentAt).toLocaleString()} to ${new Date(lastMsg.sentAt).toLocaleString()})`);
    }
    
    return sortedMessages.map(msg => ({
      fromPhone: msg.fromPhone,
      text: msg.text || '',
      sentAt: msg.sentAt,
      isFromSender: this.isFromSender(msg.fromPhone)
    }));
  }

  /**
   * Check if a phone number is the sender
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
   * Generate a natural conversation starter based on shared interest
   */
  async generateConversationStarter(sharedInterest, conversationHistory = [], isGroupChat = false, chatId = null) {
    // Hardcoded message for now
    return "looks like you guys did not connect, can you connect sometime next week?";
  }

  /**
   * Get all unique chat IDs from conversations
   */
  getChatIds(conversations) {
    const chatIds = new Set();
    conversations.forEach(msg => {
      if (msg.chatId) {
        chatIds.add(msg.chatId);
      }
    });
    return Array.from(chatIds);
  }

  /**
   * Check and initiate conversations for eligible chats
   */
  async checkAndInitiate() {
    try {
      console.log('\n🔔 Conversation Initiator: Checking for opportunities to start conversations...');
      
      // Only check the target chat ID if configured
      if (!this.targetChatId) {
        console.log('   No target chat ID configured. Skipping conversation initiation.');
        return;
      }
      
      const targetChatId = String(this.targetChatId);
      console.log(`   🎯 Only checking target chat ID: ${targetChatId}`);
      
      // Load data only for the target chat
      const keyMoments = await this.loadKeyMoments();
      const conversations = await this.loadConversationsForChat(targetChatId);
      
      // Use only the target chat ID
      const chatIds = [targetChatId];
      
      console.log(`   Found 1 chat to check (target chat: ${targetChatId})`);
      console.log(`   Key moments available: ${keyMoments.length}`);
      
      let initiatedCount = 0;
      
      // Check each chat
      for (const chatId of chatIds) {
        try {
          console.log(`\n   📋 Checking chat ${chatId}...`);
          
          // No daily limit - allow unlimited initiations as long as inactivity threshold is met
          
          // Check if chat is inactive
          const chatMessages = conversations.filter(msg => msg.chatId === chatId);
          const isInactive = this.isChatInactive(chatId, conversations);
          
          // If no messages from API but we have a target chat ID, treat as inactive (allow initial message)
          if (!isInactive && chatMessages.length === 0 && this.targetChatId && String(chatId) === String(this.targetChatId)) {
            console.log(`   ✅ Chat ${chatId}: No messages found from API yet, will send initial message`);
          } else if (!isInactive) {
            const sortedMessages = chatMessages
              .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
            if (sortedMessages.length > 0) {
              const lastMessage = sortedMessages[0];
              const lastMessageTime = new Date(lastMessage.sentAt).getTime();
              const now = Date.now();
              const inactivityMinutes = (now - lastMessageTime) / (1000 * 60);
              console.log(`   ⏭️  Chat ${chatId}: Chat is still active (last message ${inactivityMinutes.toFixed(1)} minutes ago, need ${this.minInactivityMinutes} minutes)`);
            } else {
              console.log(`   ⏭️  Chat ${chatId}: No messages found`);
            }
            continue;
          }
          
          console.log(`   ✅ Chat ${chatId}: Inactive for ${this.minInactivityMinutes}+ minutes`);
          
          // Check if introduction has been sent (check if agent has sent the introduction message specifically)
          const hasIntroductionBeenSent = await this.hasIntroductionBeenSent(chatId);
          
          if (!hasIntroductionBeenSent) {
            // Send introduction message first - this is the FIRST message ever
            console.log(`   👋 Chat ${chatId}: Sending introduction message (FIRST MESSAGE - introducing Rahul and Arsh)`);
            const introductionMessage = this.generateIntroductionMessage();
            
            if (this.apiClient.enabled) {
              try {
                console.log(`   📤 Sending introduction message to chat ${chatId}...`);
                const result = await this.apiClient.sendMessage(
                  chatId,
                  introductionMessage,
                  [],
                  this.senderPhoneNumber
                );
                
                const messageId = result?.data?.id || result?.id || result?.message_id || result?.chat_message?.id;
                if (messageId) {
                  console.log(`   ✅ Introduction message sent successfully (ID: ${messageId})`);
                  
                  // Record the introduction
                  await this.recordIntroduction(chatId, introductionMessage);
                  
                  // IMPORTANT: Don't send regular conversation starter immediately
                  // Wait for the next check cycle after the inactivity period
                  console.log(`   ⏸️  Introduction sent. Regular conversation starters will begin after ${this.minInactivityMinutes} minutes of inactivity from now.`);
                  initiatedCount++;
                  continue; // Skip regular conversation starter - introduction is the first message
                } else {
                  console.warn(`   ⚠️  Introduction message may not have been sent (no message ID in response)`);
                  // Still record it
                  await this.recordIntroduction(chatId, introductionMessage);
                  continue;
                }
              } catch (error) {
                console.error(`   ❌ Error sending introduction message:`, error);
                // Still record it even if sending failed
                await this.recordIntroduction(chatId, introductionMessage);
                continue;
              }
            } else {
              console.log(`   📝 Introduction message (API not enabled, would send):`);
              console.log(`   "${introductionMessage}"`);
              await this.recordIntroduction(chatId, introductionMessage);
              initiatedCount++;
            }
            continue; // Skip regular conversation starter - introduction must be sent first
          }
          
          // If we get here, introduction has been sent
          // Now check if enough time has passed since introduction to send regular starters
          const introductionRecord = await this.getIntroductionRecord(chatId);
          if (introductionRecord) {
            const introductionTime = new Date(introductionRecord.initiatedAt).getTime();
            const now = Date.now();
            const minutesSinceIntroduction = (now - introductionTime) / (1000 * 60);
            
            if (minutesSinceIntroduction < this.minInactivityMinutes) {
              console.log(`   ⏸️  Chat ${chatId}: Introduction was sent ${minutesSinceIntroduction.toFixed(1)} minutes ago. Waiting ${(this.minInactivityMinutes - minutesSinceIntroduction).toFixed(1)} more minutes before sending regular conversation starters.`);
              continue; // Wait for the inactivity period after introduction
            }
          }
          
          // Get conversation history for context - only last 2-3 messages from MongoDB
          // Get latest messages directly from MongoDB for better reliability
          const latestMessages = await this.db.getLatestMessagesByChat(String(chatId), 3);
          const conversationHistory = latestMessages.map(msg => ({
            fromPhone: msg.fromPhone,
            text: msg.text || '',
            sentAt: msg.sentAt,
            isFromSender: this.isFromSender(msg.fromPhone)
          }));
          console.log(`   📚 Loaded ${conversationHistory.length} latest messages from MongoDB for context`);
          
          // Detect if this is a group chat by checking chat handles
          const allChatHandles = new Set();
          chatMessages.forEach(msg => {
            if (msg.chatHandles && Array.isArray(msg.chatHandles)) {
              msg.chatHandles.forEach(handle => {
                const phone = handle.identifier || handle.phone_number || handle;
                if (phone) {
                  allChatHandles.add(String(phone));
                }
              });
            }
          });
          const isGroupChat = allChatHandles.size > 2; // More than 2 participants (excluding sender)
          const participantCount = allChatHandles.size;
          
          if (isGroupChat) {
            console.log(`   👥 Group chat detected with ${participantCount} participants`);
          }
          
          // Get shared interests for this chat
          const sharedInterests = this.getSharedInterestsForChat(keyMoments, chatId);
          
          let messageText;
          let interestDescription = 'generic_starter';
          
          if (sharedInterests.length > 0) {
            // Use diversity-aware interest selection to avoid repeating the same topics
            const interest = await this.selectDiverseInterest(sharedInterests, chatId);
            
            if (!interest) {
              console.log(`   ⏭️  Chat ${chatId}: No suitable interest selected after diversity filtering`);
              continue;
            }
            
          // Check if we've already initiated about this specific interest recently (within last hour)
          // This prevents spamming the same interest, but allows different interests
          // TEMPORARILY REDUCED TO 5 MINUTES FOR TESTING
          const recentlyInitiated = await this.hasRecentlyInitiated(chatId, interest.description, 5); // 5 minutes (reduced from 60 for testing)
          if (recentlyInitiated) {
            console.log(`   ⏭️  Chat ${chatId}: Already initiated about this interest recently (within last 5 minutes)`);
            console.log(`   💡 To allow more frequent initiations, reduce the cooldown period or clear initiation records in MongoDB`);
            continue;
          }
            
            // Generate conversation starter based on shared interest with conversation history
            console.log(`   💭 Generating conversation starter for chat ${chatId}...`);
            console.log(`      Shared interest: ${interest.description}`);
            messageText = await this.generateConversationStarter(interest, conversationHistory, isGroupChat, chatId);
            interestDescription = interest.description;
          } else {
            // No shared interests - use generic starter with conversation history
            // Check if we've sent a generic starter recently
            const recentlyInitiatedGeneric = await this.hasRecentlyInitiated(chatId, 'generic_starter', 5); // 5 minutes
            if (recentlyInitiatedGeneric) {
              console.log(`   ⏭️  Chat ${chatId}: Already sent generic starter recently (within last 5 minutes)`);
              continue;
            }
            console.log(`   💭 No shared interests found for chat ${chatId}, using generic conversation starter...`);
            messageText = await this.generateGenericConversationStarter(conversationHistory, isGroupChat);
          }
          
          console.log(`      Generated message: "${messageText}"`);
          
          // Send message
          if (this.apiClient.enabled) {
            try {
              console.log(`   📤 Sending conversation starter to chat ${chatId}...`);
              console.log(`      Using sender phone: ${this.senderPhoneNumber}`);
              const result = await this.apiClient.sendMessage(
                chatId,
                messageText,
                [],
                this.senderPhoneNumber
              );
              
              console.log(`   ✅ API Response received:`);
              console.log(`      Response: ${JSON.stringify(result, null, 2).substring(0, 500)}`);
              
              // Check if message was actually sent
              // API response structure: { data: { id, text, sent_at, delivery_status, ... } }
              const messageId = result?.data?.id || result?.id || result?.message_id || result?.chat_message?.id;
              const deliveryStatus = result?.data?.delivery_status || result?.delivery_status;
              
              if (result && messageId) {
                console.log(`   ✅ Successfully initiated conversation!`);
                console.log(`      Chat ID: ${chatId}`);
                console.log(`      Message ID: ${messageId}`);
                console.log(`      Delivery Status: ${deliveryStatus || 'N/A'}`);
                console.log(`      Message: "${messageText}"`);
                
                // Record initiation
                await this.recordInitiation(chatId, interestDescription, messageText);
                initiatedCount++;
              } else {
                console.warn(`   ⚠️  API returned response but no message ID found. Response:`, JSON.stringify(result));
                // Still record it
                await this.recordInitiation(chatId, interestDescription, messageText);
                initiatedCount++;
              }
            } catch (error) {
              console.error(`   ❌ Error sending message to chat ${chatId}:`, error.message);
              if (error.response) {
                console.error(`      Status: ${error.response.status}`);
                console.error(`      Status Text: ${error.response.statusText}`);
                console.error(`      Response Data: ${JSON.stringify(error.response.data, null, 2)}`);
              }
              if (error.request) {
                console.error(`      Request made but no response received`);
              }
              // Log the full error for debugging
              console.error(`      Full error:`, error);
              console.error(`      Stack:`, error.stack);
            }
          } else {
            console.warn(`   ⚠️  API client not enabled. Would send: "${messageText}"`);
            // Still record it for testing
            await this.recordInitiation(chatId, interestDescription, messageText);
            initiatedCount++;
          }
        } catch (error) {
          console.error(`   ❌ Error processing chat ${chatId}:`, error.message);
          console.error(`      Full error:`, error);
        }
      }
      
      if (initiatedCount > 0) {
        console.log(`\n✨ Conversation Initiator: Successfully initiated ${initiatedCount} conversation(s)!`);
      } else {
        console.log(`\n✨ Conversation Initiator: No conversations initiated (all chats either active or already initiated today)`);
      }
    } catch (error) {
      console.error('Error in conversation initiator check:', error);
    }
  }

  /**
   * Start the service
   */
  async start() {
    await this.db.connect();
    console.log('Conversation Initiator Service started');
    console.log(`   Check interval: ${this.checkInterval / (60 * 1000)} minutes`);
    console.log(`   Min inactivity: ${this.minInactivityMinutes} minutes`);
    console.log(`   Frequency: Unlimited (initiates whenever inactive for ${this.minInactivityMinutes}+ minutes)`);
    console.log(`   Duplicate prevention: Same interest blocked for 1 hour`);
    console.log(`   Current events: ${this.googleSearchService.enabled ? 'Enabled (will reference live games/events)' : 'Disabled (will use date context only)'}`);
    if (this.googleSearchService.enabled) {
      console.log(`   Google Search rate limiting: ${this.googleSearchCooldown / 1000}s cooldown between searches`);
      console.log(`   Rate limit protection: ${this.googleSearchRateLimitResetDuration / (60 * 1000)} minute cooldown if 429 error occurs`);
    }
    
    if (!this.apiClient.enabled) {
      console.warn('⚠️  API client not enabled. Conversation initiations will be logged but not sent.');
    }
    
    // Send introduction message immediately on startup if not sent yet
    console.log('   Checking if introduction message needs to be sent...');
    this.sendIntroductionIfNeeded().catch(error => {
      console.error('Error sending introduction message on startup:', error);
    });
    
    // Set up periodic checks (conversation starters will only trigger after minInactivityMinutes)
    this.checkIntervalId = setInterval(() => {
      this.checkAndInitiate().catch(error => {
        console.error('Error in periodic conversation initiator check:', error);
      });
    }, this.checkInterval);
  }

  /**
   * Stop the service
   */
  async stop() {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
    console.log('Conversation Initiator Service stopped');
  }
}

module.exports = ConversationInitiatorService;
