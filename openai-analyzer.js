// OpenAI Analysis Service - Extracts key moments from conversations
require('dotenv').config();
const OpenAI = require('openai');
const SeriesAPIClient = require('./api-client');
const DatabaseService = require('./database-service');
const config = require('./config.json');

class OpenAIAnalyzer {
  constructor(targetChatId = null) {
    if (!process.env.OPENAI_API_MY_KEY) {
      throw new Error('OPENAI_API_MY_KEY must be set in .env');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_MY_KEY
    });

    this.model = config.openaiModel || 'gpt-4o';
    this.apiClient = new SeriesAPIClient();
    this.db = new DatabaseService(); // Add database service to fetch recent messages
    this.targetChatId = targetChatId || config.chatId;
    this.processedBatches = new Set(); // Track processed batches to avoid duplicates
    this.onMomentExtractedCallback = null; // Callback for extracted moments
  }

  setCallback(onMomentExtracted) {
    this.onMomentExtractedCallback = onMomentExtracted;
  }

  /**
   * Create prompt for OpenAI to extract key moments
   */
  createAnalysisPrompt(conversationBatch) {
    const messages = conversationBatch.messages.map(msg => {
      const timestamp = new Date(msg.sentAt).toLocaleString();
      return `[${timestamp}] ${msg.fromPhone}: ${msg.text}`;
    }).join('\n');

    return `Analyze the following conversation between two people and identify key relationship moments. 

Conversation:
${messages}

Please identify and extract the following types of moments (be VERY generous - capture even the smallest moments):
1. First meeting/contact - When did they first start talking? (even a simple greeting, "hi", or first message counts)
2. Shared interests - What hobbies, anime, shows, topics, sports teams, activities do they both like? (even a single mention, question, or casual agreement counts - e.g., "I like X too", "Are you interested in Y?")
3. Important dates/events - Birthdays, anniversaries, special events mentioned, plans made (any date, event, or plan reference)
4. Relationship milestones - First time they did something together, inside jokes, memorable moments, compliments, positive interactions (any friendly or positive exchange)
5. Personal preferences - Food preferences, favorite things, likes/dislikes, opinions (any preference, opinion, or taste mentioned)

CRITICAL INSTRUCTIONS:
- Be EXTREMELY lenient - capture moments even if they seem trivial or small
- A single mention, question, or casual comment can be a key moment
- Examples of moments to capture:
  * "I like pizza" → Personal preference moment
  * "Do you watch anime?" → Shared interest moment (even if just a question)
  * "Hey, how are you?" → First contact moment
  * "That's cool!" → Positive interaction/milestone
  * "We should do X" → Event/plan moment
- Extract moments with very low confidence thresholds - even 0.2-0.3 confidence is acceptable
- It's better to extract too many moments than to miss important ones

Return your analysis as a JSON array of moment objects. Each moment should have:
- type: one of "first_contact", "shared_interest", "important_date", "milestone", "preference"
- description: A clear, concise description of the moment (e.g., "You and the other person first met on X day", "You both shared your liking for [anime/show] on Y date")
- date: The date when this moment occurred (ISO format if possible, or approximate)
- participants: Array of phone numbers involved
- context: Relevant conversation context or quote
- confidence: Your confidence level (0.0 to 1.0) - can be as low as 0.3 for small moments

Return ONLY valid JSON, no other text. Format:
[
  {
    "type": "first_contact",
    "description": "...",
    "date": "2025-12-05",
    "participants": ["+1234567890"],
    "context": "...",
    "confidence": 0.9
  }
]`;
  }

  /**
   * Check if model supports JSON response format
   */
  supportsJsonMode(model) {
    // Models that support response_format: json_object
    const jsonModeModels = [
      'gpt-4',
      'gpt-4-turbo',
      'gpt-4-turbo-preview',
      'gpt-4-0125-preview',
      'gpt-4-1106-preview',
      'gpt-3.5-turbo-1106',
      'gpt-4o',
      'gpt-4o-mini'
    ];
    
    // Check if model name contains any of the supported model identifiers
    return jsonModeModels.some(supported => model.includes(supported)) || 
           model.startsWith('gpt-4') || 
           model.includes('gpt-3.5-turbo');
  }

  /**
   * Analyze conversation batch with OpenAI
   */
  async analyzeConversation(conversationBatch) {
    try {
      const prompt = this.createAnalysisPrompt(conversationBatch);
      
      // Build request parameters
      const requestParams = {
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at analyzing conversations and identifying meaningful relationship moments. Be EXTREMELY lenient - capture even small, casual moments. A simple mention, question, or casual comment can be a key moment. It is better to extract too many moments than to miss important ones. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7 // Higher temperature for more creative/lenient extraction
      };

      // Only add response_format if model supports it
      if (this.supportsJsonMode(this.model)) {
        requestParams.response_format = { type: 'json_object' };
      }

      const response = await this.openai.chat.completions.create(requestParams);

      const content = response.choices[0].message.content;
      
      // Parse JSON response
      let moments;
      try {
        // Try parsing as JSON object first (if OpenAI wraps in object)
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          moments = parsed;
        } else if (parsed.moments && Array.isArray(parsed.moments)) {
          moments = parsed.moments;
        } else if (parsed.data && Array.isArray(parsed.data)) {
          moments = parsed.data;
        } else {
          // Try to extract array from any property
          moments = Object.values(parsed).find(v => Array.isArray(v)) || [];
        }
      } catch (parseError) {
        // If direct parse fails, try to extract JSON from text
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          moments = JSON.parse(jsonMatch[0]);
        } else {
          console.warn('Could not parse OpenAI response as JSON:', content);
          return [];
        }
      }

      // Validate and enrich moments (very low bar - accept moments with confidence >= 0.15)
      const validatedMoments = moments
        .filter(m => m && m.type && m.description && (m.confidence === undefined || m.confidence >= 0.15))
        .map(moment => ({
          ...moment,
          chatId: conversationBatch.chatId,
          extractedAt: new Date().toISOString(),
          conversationTimeRange: conversationBatch.timeRange,
          messageCount: conversationBatch.messageCount,
          // Ensure minimum confidence of 0.2 if not provided (lowered from 0.3)
          confidence: moment.confidence !== undefined ? moment.confidence : 0.2
        }));

      return validatedMoments;
    } catch (error) {
      console.error('Error analyzing conversation:', error);
      return [];
    }
  }

  /**
   * Process a conversation batch (called directly, not from Kafka)
   * Fetches all chat history from API to analyze the full conversation for key moments
   */
  async processBatch(conversationBatch) {
    try {
      // Create batch ID to avoid duplicates
      const batchId = `${conversationBatch.chatId}-${conversationBatch.timeRange.start}-${conversationBatch.messageCount}`;
      
      if (this.processedBatches.has(batchId)) {
        console.log(`Skipping already processed batch: ${batchId}`);
        return;
      }

      console.log(`🔍 Analyzing conversation for key moments (chat ${conversationBatch.chatId})...`);
      console.log(`   Messages in batch: ${conversationBatch.messages.length}`);

      // Fetch recent messages from MongoDB to ensure we include the latest messages
      let allMessages = conversationBatch.messages;
      try {
        // First, try to get recent messages from MongoDB (most reliable and up-to-date)
        if (this.db) {
          await this.db.connect();
          const recentDbMessages = await this.db.getConversationsByChat(conversationBatch.chatId, 100); // Get last 100 messages
          await this.db.disconnect();
          
          if (Array.isArray(recentDbMessages) && recentDbMessages.length > 0) {
            // Convert MongoDB messages to batch format
            const dbMessagesFormatted = recentDbMessages.map(msg => ({
              chatId: conversationBatch.chatId,
              messageId: String(msg.messageId || msg.id),
              fromPhone: msg.fromPhone,
              text: msg.text || '',
              sentAt: msg.sentAt,
              chatHandles: msg.chatHandles || [],
              attachments: msg.attachments || [],
              isRead: msg.isRead || false,
              service: msg.service || 'iMessage'
            }));

            // Combine batch messages with MongoDB messages, avoiding duplicates
            const batchMessageIds = new Set(conversationBatch.messages.map(m => m.messageId));
            const uniqueDbMessages = dbMessagesFormatted.filter(m => !batchMessageIds.has(m.messageId));
            
            // Merge and sort by timestamp (most recent first, then reverse to chronological)
            allMessages = [...conversationBatch.messages, ...uniqueDbMessages]
              .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
            
            console.log(`   ✅ Using ${allMessages.length} total messages for key moment analysis (${conversationBatch.messages.length} from batch + ${uniqueDbMessages.length} from MongoDB - includes recent messages)`);
          }
        }
      } catch (error) {
        console.warn(`   ⚠️  Error fetching recent messages from MongoDB, using batch only:`, error.message);
        // Fallback to API if MongoDB fails
        if (this.apiClient.enabled && this.targetChatId && String(conversationBatch.chatId) === String(this.targetChatId)) {
          try {
            console.log(`   📥 Fallback: Fetching recent messages from API...`);
            const messagesResponse = await this.apiClient.getChatMessages(conversationBatch.chatId, null, 100, false, true); // Increased from 25 to 100
            const apiMessages = messagesResponse?.data || messagesResponse || [];
            
            if (Array.isArray(apiMessages) && apiMessages.length > 0) {
              // Convert API messages to batch format
              const apiMessagesFormatted = apiMessages.map(msg => ({
                chatId: conversationBatch.chatId,
                messageId: String(msg.id || msg.message_id),
                fromPhone: msg.sent_from || msg.from_phone || msg.fromPhone,
                text: msg.text || '',
                sentAt: msg.sent_at || msg.sentAt || msg.timestamp,
                chatHandles: msg.chat_handles || [],
                attachments: msg.attachments || [],
                isRead: msg.is_read || false,
                service: msg.service || 'iMessage'
              }));

              // Combine batch messages with API messages, avoiding duplicates
              const batchMessageIds = new Set(conversationBatch.messages.map(m => m.messageId));
              const uniqueApiMessages = apiMessagesFormatted.filter(m => !batchMessageIds.has(m.messageId));
              
              // Merge and sort by timestamp
              allMessages = [...conversationBatch.messages, ...uniqueApiMessages]
                .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
              
              console.log(`   ✅ Using ${allMessages.length} total messages for key moment analysis (${conversationBatch.messages.length} from batch + ${uniqueApiMessages.length} from API)`);
            }
          } catch (apiError) {
            console.warn(`   ⚠️  Error fetching from API as well, using batch only:`, apiError.message);
          }
        }
      }

      // Prioritize recent messages - take the most recent 50 messages to ensure recent ones are included
      // This ensures we capture key moments from recent conversations while keeping token usage reasonable
      const recentMessages = allMessages.length > 50 
        ? allMessages.slice(-50) // Take last 50 messages (most recent)
        : allMessages; // Use all if less than 50
      
      console.log(`   📊 Analyzing ${recentMessages.length} messages (prioritizing most recent ${Math.min(50, allMessages.length)} messages)`);
      console.log(`   📅 Message time range: ${recentMessages[0]?.sentAt} to ${recentMessages[recentMessages.length - 1]?.sentAt}`);

      // Create enhanced batch with recent messages prioritized
      const enhancedBatch = {
        ...conversationBatch,
        messages: recentMessages,
        messageCount: recentMessages.length,
        timeRange: {
          start: recentMessages.length > 0 ? recentMessages[0].sentAt : conversationBatch.timeRange.start,
          end: recentMessages.length > 0 ? recentMessages[recentMessages.length - 1].sentAt : conversationBatch.timeRange.end
        }
      };

      const moments = await this.analyzeConversation(enhancedBatch);

      if (moments.length === 0) {
        console.log(`No key moments extracted for chat ${conversationBatch.chatId}`);
        this.processedBatches.add(batchId);
        return;
      }

      // Send moments via callback (in-memory, no Kafka topic needed)
      for (const moment of moments) {
        if (this.onMomentExtractedCallback) {
          await this.onMomentExtractedCallback(moment);
        }
      }

      console.log(`Extracted ${moments.length} key moments for chat ${conversationBatch.chatId}`);
      this.processedBatches.add(batchId);
    } catch (error) {
      console.error('Error processing batch:', error);
    }
  }

  /**
   * Analyze all past conversations from MongoDB to extract key moments
   * This runs on startup to process historical conversations
   * Uses MongoDB instead of API for reliability and to get latest messages
   */
  async analyzeAllPastConversations() {
    if (!this.targetChatId) {
      console.log('   ⏭️  Skipping past conversation analysis (no target chat ID)');
      return;
    }

    try {
      const chatId = String(this.targetChatId);
      console.log(`\n📚 Analyzing ALL past conversations for key moments (chat ${chatId})...`);
      console.log(`   Loading from MongoDB (messages stored from Kafka events)`);
      
      // Load ALL messages from MongoDB for this chat
      // Messages are stored in MongoDB as they come in via Kafka events
      const DatabaseService = require('./database-service');
      const db = new DatabaseService();
      await db.connect();
      
      const allMessages = await db.getConversationsByChat(chatId, 10000);
      
      if (!Array.isArray(allMessages) || allMessages.length === 0) {
        console.log(`   ⚠️  No messages found in MongoDB for chat ${chatId}`);
        console.log(`   💡 Messages will be stored in MongoDB as they come in via Kafka events`);
        await db.disconnect();
        return;
      }

      // Sort by timestamp (oldest first) to maintain chronological order
      allMessages.sort((a, b) => {
        const timeA = new Date(a.sentAt).getTime();
        const timeB = new Date(b.sentAt).getTime();
        return timeA - timeB;
      });

      console.log(`   ✅ Loaded ${allMessages.length} messages from MongoDB`);
      if (allMessages.length > 0) {
        const firstMsg = allMessages[0];
        const lastMsg = allMessages[allMessages.length - 1];
        console.log(`   📅 Time range: ${new Date(firstMsg.sentAt).toLocaleString()} to ${new Date(lastMsg.sentAt).toLocaleString()}`);
      }
      
      await db.disconnect();

      // Create a batch with all messages for comprehensive analysis
      const fullConversationBatch = {
        chatId: chatId,
        messages: allMessages,
        participantPhones: this.extractParticipantPhones(allMessages),
        timeRange: {
          start: allMessages.length > 0 ? allMessages[0].sentAt : new Date().toISOString(),
          end: allMessages.length > 0 ? allMessages[allMessages.length - 1].sentAt : new Date().toISOString()
        },
        messageCount: allMessages.length,
        processedAt: new Date().toISOString()
      };

      // Analyze the full conversation history for key moments
      console.log(`   🔍 Analyzing full conversation history for key moments...`);
      console.log(`   This may take a moment for large conversations...`);
      const moments = await this.analyzeConversation(fullConversationBatch);

      if (moments.length === 0) {
        console.log(`   ⚠️  No key moments extracted from past conversations`);
        console.log(`   This might mean the conversation doesn't contain extractable moments, or the AI needs adjustment.`);
        return;
      }

      // Store all extracted moments
      let storedCount = 0;
      let skippedCount = 0;
      for (const moment of moments) {
        if (this.onMomentExtractedCallback) {
          try {
            await this.onMomentExtractedCallback(moment);
            storedCount++;
          } catch (error) {
            console.warn(`   ⚠️  Error storing moment "${moment.description}":`, error.message);
            skippedCount++;
          }
        }
      }

      console.log(`   ✅ Extracted and stored ${storedCount} key moments from past conversations!`);
      if (skippedCount > 0) {
        console.log(`   ⚠️  Skipped ${skippedCount} moments due to errors`);
      }
      console.log(`   💡 These moments can now be used for conversation starters and user discussions.`);
    } catch (error) {
      console.error('   ❌ Error analyzing past conversations:', error.message);
      if (error.response) {
        console.error(`   API Response Status: ${error.response.status}`);
        console.error(`   API Response Data:`, JSON.stringify(error.response.data, null, 2));
      }
      console.error(`   Full error:`, error);
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

  async start() {
    console.log(`OpenAI analyzer started. Using model: ${this.model}`);
    // No Kafka consumer needed - receives batches via processBatch() callback
    
    // Analyze all past conversations on startup
    this.analyzeAllPastConversations().catch(error => {
      console.error('Error analyzing past conversations on startup:', error);
    });
  }

  async stop() {
    console.log('OpenAI analyzer stopped');
  }
}

module.exports = OpenAIAnalyzer;
