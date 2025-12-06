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
Generate a casual, engaging conversation starter (1-2 sentences max). 
Be genuine, friendly, and not overly formal. Use emojis sparingly (maybe 1-2 if appropriate).
The message should feel like a natural text message, not a formal email.

IMPORTANT: Consider the conversation history - reference previous topics, continue threads, or build on what was discussed before.${groupChatInstruction}`;

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
  async generateConversationStarter(sharedInterest, conversationHistory = [], isGroupChat = false) {
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
      
      const groupChatInstruction = isGroupChat 
        ? `\n\nCRITICAL: This is a GROUP CHAT with multiple participants. Address BOTH (or ALL) participants in your message. Use "you both", "you all", or ask questions that engage everyone. Make sure the conversation starter is inclusive and addresses the group, not just one person.`
        : '';
      
      const systemPrompt = `You are a friendly person who wants to start a natural conversation with someone you share interests with. 
Generate a casual, engaging conversation starter (1-2 sentences max) based on a shared interest. 
Be genuine, friendly, and not overly formal. Use emojis sparingly (maybe 1-2 if appropriate).
The message should feel like a natural text message, not a formal email.

IMPORTANT: 
- If the shared interest is related to sports, entertainment, or current events, reference what's happening RIGHT NOW (today's games, current events, recent news, etc.) when relevant.
- Consider the conversation history - reference previous topics, continue threads, or build on what was discussed before.
- Make it timely and relevant to the current moment and the relationship context.${groupChatInstruction}`;

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
            messageText = await this.generateConversationStarter(interest, conversationHistory, isGroupChat);
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
