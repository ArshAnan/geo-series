// Conversation Initiator Service - Proactively initiates conversations based on shared interests
require('dotenv').config();
const OpenAI = require('openai');
const SeriesAPIClient = require('./api-client');
const config = require('./config.json');
const fs = require('fs-extra');
const path = require('path');
const GoogleSearchService = require('./google-search-service');

class ConversationInitiatorService {
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
    
    // File paths
    this.keyMomentsFile = path.join(__dirname, 'logs', 'key-moments.json');
    this.conversationsFile = path.join(__dirname, 'logs', 'conversations.json');
    this.initiatedConversationsFile = path.join(__dirname, 'logs', 'initiated-conversations.json');
    
    // Interval timer
    this.checkIntervalId = null;
    
    // Initialize Google Search Service for current events
    this.googleSearchService = new GoogleSearchService();
    
    // Initialize files
    this.initializeFiles();
  }

  /**
   * Initialize storage files
   */
  async initializeFiles() {
    try {
      await fs.ensureDir(path.dirname(this.initiatedConversationsFile));
      if (!(await fs.pathExists(this.initiatedConversationsFile))) {
        await fs.writeJson(this.initiatedConversationsFile, [], { spaces: 2 });
      }
    } catch (error) {
      console.error('Error initializing conversation initiator files:', error);
    }
  }

  /**
   * Load key moments from storage
   */
  async loadKeyMoments() {
    try {
      if (await fs.pathExists(this.keyMomentsFile)) {
        const moments = await fs.readJson(this.keyMomentsFile);
        return moments || [];
      }
      return [];
    } catch (error) {
      console.error('Error loading key moments:', error);
      return [];
    }
  }

  /**
   * Load conversations to track activity
   */
  async loadConversations() {
    try {
      if (await fs.pathExists(this.conversationsFile)) {
        const conversations = await fs.readJson(this.conversationsFile);
        return conversations || [];
      }
      return [];
    } catch (error) {
      console.error('Error loading conversations:', error);
      return [];
    }
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
  async generateGenericConversationStarter(conversationHistory = []) {
    try {
      const now = new Date();
      const currentDate = now.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });

      const systemPrompt = `You are a friendly person who wants to start a natural conversation. 
Generate a casual, engaging conversation starter (1-2 sentences max). 
Be genuine, friendly, and not overly formal. Use emojis sparingly (maybe 1-2 if appropriate).
The message should feel like a natural text message, not a formal email.

IMPORTANT: Consider the conversation history - reference previous topics, continue threads, or build on what was discussed before.`;

      // Build conversation history context
      let historyContext = '';
      if (conversationHistory && conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-10); // Last 10 messages for context
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
        max_tokens: 100
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
      if (await fs.pathExists(this.initiatedConversationsFile)) {
        const initiated = await fs.readJson(this.initiatedConversationsFile);
        const today = new Date().toISOString().split('T')[0];
        
        return initiated.some(init => 
          init.chatId === chatId &&
          init.date === today &&
          init.interestDescription === interestDescription
        );
      }
      return false;
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
      if (await fs.pathExists(this.initiatedConversationsFile)) {
        const initiated = await fs.readJson(this.initiatedConversationsFile);
        const cutoffTime = Date.now() - (minutesAgo * 60 * 1000);
        
        return initiated.some(init => {
          if (init.chatId === chatId && init.interestDescription === interestDescription) {
            const initiatedTime = new Date(init.initiatedAt).getTime();
            return initiatedTime > cutoffTime;
          }
          return false;
        });
      }
      return false;
    } catch (error) {
      console.error('Error checking recent initiations:', error);
      return false;
    }
  }

  /**
   * Record that we initiated a conversation
   */
  async recordInitiation(chatId, interestDescription, messageText) {
    try {
      const initiated = await fs.readJson(this.initiatedConversationsFile);
      const today = new Date().toISOString().split('T')[0];
      
      initiated.push({
        chatId,
        date: today,
        interestDescription,
        messageText,
        initiatedAt: new Date().toISOString()
      });
      
      await fs.writeJson(this.initiatedConversationsFile, initiated, { spaces: 2 });
      
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
   */
  async getCurrentEventsForInterest(sharedInterest) {
    if (!this.googleSearchService.enabled) {
      return null;
    }

    try {
      // Extract keywords from the shared interest description
      const interestText = sharedInterest.description.toLowerCase();
      
      // Determine if this is a sport/team interest
      const sportsKeywords = ['soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'nfl', 'nba', 'mlb', 'nhl', 'premier league', 'champions league', 'world cup', 'olympics'];
      const isSportInterest = sportsKeywords.some(keyword => interestText.includes(keyword));
      
      if (!isSportInterest) {
        // For non-sports interests, we'll let OpenAI handle it with current date context
        return null;
      }

      // Build search query for current events
      let searchQuery = '';
      if (interestText.includes('soccer') || interestText.includes('football')) {
        searchQuery = 'soccer games today live scores';
      } else if (interestText.includes('basketball')) {
        searchQuery = 'NBA games today live scores';
      } else if (interestText.includes('baseball')) {
        searchQuery = 'MLB games today live scores';
      } else if (interestText.includes('hockey')) {
        searchQuery = 'NHL games today live scores';
      } else {
        // Generic sports search
        searchQuery = `${interestText} games today live`;
      }

      console.log(`   🔍 Searching for current events: "${searchQuery}"`);
      const results = await this.googleSearchService.searchPlaces(searchQuery);
      
      if (results && results.length > 0) {
        // Extract relevant information from search results
        const currentEvents = results.slice(0, 3).map(result => ({
          title: result.title,
          snippet: result.snippet
        }));
        return currentEvents;
      }
      
      return null;
    } catch (error) {
      console.warn('   ⚠️  Error searching for current events:', error.message);
      return null;
    }
  }

  /**
   * Get conversation history for a specific chat
   */
  getConversationHistoryForChat(chatId, conversations, maxMessages = 20) {
    const chatMessages = conversations
      .filter(msg => msg.chatId === chatId)
      .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime())
      .slice(-maxMessages); // Get last N messages
    
    return chatMessages.map(msg => ({
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
  async generateConversationStarter(sharedInterest, conversationHistory = []) {
    try {
      // Get current date and time
      const now = new Date();
      const currentDate = now.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      const currentTime = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        timeZoneName: 'short'
      });

      // Try to get current events related to the interest
      const currentEvents = await this.getCurrentEventsForInterest(sharedInterest);
      
      const systemPrompt = `You are a friendly person who wants to start a natural conversation with someone you share interests with. 
Generate a casual, engaging conversation starter (1-2 sentences max) based on a shared interest. 
Be genuine, friendly, and not overly formal. Use emojis sparingly (maybe 1-2 if appropriate).
The message should feel like a natural text message, not a formal email.

IMPORTANT: 
- If the shared interest is related to sports, entertainment, or current events, reference what's happening RIGHT NOW (today's games, current events, recent news, etc.) when relevant.
- Consider the conversation history - reference previous topics, continue threads, or build on what was discussed before.
- Make it timely and relevant to the current moment and the relationship context.`;

      // Build conversation history context
      let historyContext = '';
      if (conversationHistory && conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-10); // Last 10 messages for context
        historyContext = `\n\nPrevious Conversation Context (most recent messages):
${recentHistory.map((msg, idx) => {
          const role = msg.isFromSender ? 'You' : 'Them';
          const time = new Date(msg.sentAt).toLocaleString();
          return `${role} (${time}): ${msg.text}`;
        }).join('\n')}

Use this conversation history to make your starter more relevant. You can reference previous topics, continue a discussion, or build on what was talked about before.`;
      }

      let userPrompt = `Generate a conversation starter based on this shared interest:
${sharedInterest.description}

Context: ${sharedInterest.context || 'No additional context'}

Current Date and Time: ${currentDate} at ${currentTime}${historyContext}`;

      if (currentEvents && currentEvents.length > 0) {
        userPrompt += `\n\nCurrent Events/News Related to This Interest:
${currentEvents.map((event, idx) => `${idx + 1}. ${event.title}: ${event.snippet}`).join('\n')}

Use this current information to make your conversation starter timely and relevant. Reference specific games, events, or news if appropriate.`;
      } else {
        userPrompt += `\n\nTry to reference what's happening right now related to this interest (current games, events, news, etc.) if it's relevant. Make it timely and engaging.`;
      }

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.8,
        max_tokens: 150 // Increased slightly for more context
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating conversation starter:', error);
      // Fallback to a simple message
      return `Hey! I was thinking about ${sharedInterest.description.toLowerCase()}. Want to chat about it?`;
    }
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
      
      // Load data
      const keyMoments = await this.loadKeyMoments();
      const conversations = await this.loadConversations();
      
      // Get all chat IDs
      const chatIds = this.getChatIds(conversations);
      
      if (chatIds.length === 0) {
        console.log('   No chats found. Waiting for conversations...');
        return;
      }
      
      console.log(`   Found ${chatIds.length} chat(s) to check`);
      console.log(`   Key moments available: ${keyMoments.length}`);
      
      let initiatedCount = 0;
      
      // Check each chat
      for (const chatId of chatIds) {
        try {
          console.log(`\n   📋 Checking chat ${chatId}...`);
          
          // No daily limit - allow unlimited initiations as long as inactivity threshold is met
          
          // Check if chat is inactive
          const isInactive = this.isChatInactive(chatId, conversations);
          if (!isInactive) {
            const chatMessages = conversations
              .filter(msg => msg.chatId === chatId)
              .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
            if (chatMessages.length > 0) {
              const lastMessage = chatMessages[0];
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
          
          // Get conversation history for context
          const conversationHistory = this.getConversationHistoryForChat(chatId, conversations, 20);
          console.log(`   📚 Loaded ${conversationHistory.length} previous messages for context`);
          
          // Get shared interests for this chat
          const sharedInterests = this.getSharedInterestsForChat(keyMoments, chatId);
          
          let messageText;
          let interestDescription = 'generic_starter';
          
          if (sharedInterests.length > 0) {
            // Pick the most recent or highest confidence shared interest
            const interest = sharedInterests
              .sort((a, b) => {
                // Prefer higher confidence, then more recent
                if (b.confidence !== a.confidence) {
                  return b.confidence - a.confidence;
                }
                return new Date(b.extractedAt || b.date).getTime() - new Date(a.extractedAt || a.date).getTime();
              })[0];
            
          // Check if we've already initiated about this specific interest recently (within last hour)
          // This prevents spamming the same interest, but allows different interests
          const recentlyInitiated = await this.hasRecentlyInitiated(chatId, interest.description, 60); // 60 minutes
          if (recentlyInitiated) {
            console.log(`   ⏭️  Chat ${chatId}: Already initiated about this interest recently (within last hour)`);
            continue;
          }
            
            // Generate conversation starter based on shared interest with conversation history
            console.log(`   💭 Generating conversation starter for chat ${chatId}...`);
            console.log(`      Shared interest: ${interest.description}`);
            messageText = await this.generateConversationStarter(interest, conversationHistory);
            interestDescription = interest.description;
          } else {
            // No shared interests - use generic starter with conversation history
            console.log(`   💭 No shared interests found for chat ${chatId}, using generic conversation starter...`);
            messageText = await this.generateGenericConversationStarter(conversationHistory);
          }
          
          console.log(`      Generated message: "${messageText}"`);
          
          // Send message
          if (this.apiClient.enabled) {
            try {
              console.log(`   📤 Sending conversation starter to chat ${chatId}...`);
              const result = await this.apiClient.sendMessage(
                chatId,
                messageText,
                [],
                this.senderPhoneNumber
              );
              
              console.log(`   ✅ Successfully initiated conversation!`);
              console.log(`      Chat ID: ${chatId}`);
              console.log(`      Message: "${messageText}"`);
              
              // Record initiation
              await this.recordInitiation(chatId, interestDescription, messageText);
              initiatedCount++;
            } catch (error) {
              console.error(`   ❌ Error sending message to chat ${chatId}:`, error.message);
              if (error.response) {
                console.error(`      Status: ${error.response.status}`);
                console.error(`      Data: ${JSON.stringify(error.response.data, null, 2)}`);
              }
              // Log the full error for debugging
              console.error(`      Full error:`, error);
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
    console.log('Conversation Initiator Service started');
    console.log(`   Check interval: ${this.checkInterval / (60 * 1000)} minutes`);
    console.log(`   Min inactivity: ${this.minInactivityMinutes} minutes`);
    console.log(`   Frequency: Unlimited (initiates whenever inactive for ${this.minInactivityMinutes}+ minutes)`);
    console.log(`   Duplicate prevention: Same interest blocked for 1 hour`);
    console.log(`   Current events: ${this.googleSearchService.enabled ? 'Enabled (will reference live games/events)' : 'Disabled (will use date context only)'}`);
    
    if (!this.apiClient.enabled) {
      console.warn('⚠️  API client not enabled. Conversation initiations will be logged but not sent.');
    }
    
    // Run initial check immediately on startup
    console.log('   Running initial check now...');
    this.checkAndInitiate().catch(error => {
      console.error('Error in initial conversation initiator check:', error);
    });
    
    // Set up periodic checks
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
