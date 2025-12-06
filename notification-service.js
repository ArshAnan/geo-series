// Notification Service - Sends key moments to users after conversations
require('dotenv').config();
const SeriesAPIClient = require('./api-client');
const config = require('./config.json');
const DatabaseService = require('./database-service');

class NotificationService {
  constructor() {
    this.apiClient = new SeriesAPIClient();
    this.conversationActivity = new Map(); // chatId -> { lastMessageTime, timer, keyMoments }
    this.inactivityTimeout = (config.conversationInactivityMinutes || 30) * 60 * 1000; // Default 30 minutes
    this.onKeyMomentCallback = null;
    this.sentMomentIds = new Set(); // Track which moments we've already sent (in-memory cache)
    this.db = new DatabaseService();
    this.sendingSummaries = new Set(); // Track chats that are currently sending summaries to prevent duplicates
    
    // Note: MongoDB connection will happen in start() method
  }

  async loadSentMoments() {
    try {
      // Load from MongoDB and cache in memory
      await this.db.connect();
      // Note: We'll check MongoDB directly in isMomentSent, this is just for initial cache
    } catch (error) {
      console.warn('Could not load sent moments:', error.message);
    }
  }

  async saveSentMoments() {
    // No longer needed - MongoDB handles persistence
    // This method kept for compatibility but does nothing
  }

  setCallback(onKeyMoment) {
    this.onKeyMomentCallback = onKeyMoment;
  }

  /**
   * Track a new message in a conversation
   */
  trackMessage(chatId, message) {
    const now = new Date();
    
    if (!this.conversationActivity.has(chatId)) {
      this.conversationActivity.set(chatId, {
        lastMessageTime: now,
        keyMoments: [],
        timer: null
      });
    }

    const activity = this.conversationActivity.get(chatId);
    activity.lastMessageTime = now;

    // Reset inactivity timer
    if (activity.timer) {
      clearTimeout(activity.timer);
    }

    // Set new timer to send summary when conversation becomes inactive
    activity.timer = setTimeout(() => {
      this.sendConversationSummary(chatId);
    }, this.inactivityTimeout);
  }

  /**
   * Add a key moment to a conversation
   */
  async addKeyMoment(moment) {
    const chatId = moment.chatId;
    
    if (!this.conversationActivity.has(chatId)) {
      this.conversationActivity.set(chatId, {
        lastMessageTime: new Date(),
        keyMoments: [],
        timer: null
      });
    }

    const activity = this.conversationActivity.get(chatId);
    
    // Create a unique ID for this moment
    const momentId = `${chatId}-${moment.type}-${moment.date}-${moment.description.substring(0, 50)}`;
    
    // Check if we've already sent this moment (check MongoDB)
    const isSent = await this.db.isMomentSent(momentId);
    if (isSent) {
      console.log(`Skipping already sent moment: ${moment.description}`);
      return;
    }

    // Add moment to conversation
    activity.keyMoments.push(moment);
    
    // If callback is set, notify immediately (for real-time notifications)
    if (this.onKeyMomentCallback) {
      this.onKeyMomentCallback(moment);
    }
  }

  /**
   * Send conversation summary to user
   * Only sends UNSENT key moments in a single message
   */
  async sendConversationSummary(chatId) {
    // Prevent concurrent sends for the same chat
    if (this.sendingSummaries.has(chatId)) {
      console.log(`⏭️  Summary already being sent for chat ${chatId}, skipping duplicate`);
      return;
    }

    try {
      this.sendingSummaries.add(chatId);
      console.log(`📋 Preparing to send conversation summary for chat ${chatId}...`);
      
      // Load ALL key moments from storage for this chat
      const allMomentsFromStorage = await this.getAllMomentsFromStorage(chatId);
      
      if (allMomentsFromStorage.length === 0) {
        console.log(`⚠️  No key moments found in storage for chat ${chatId}`);
        return;
      }

      // Filter to only UNSENT moments
      const unsentMoments = [];
      for (const moment of allMomentsFromStorage) {
        const momentId = `${chatId}-${moment.type}-${moment.date}-${moment.description.substring(0, 50)}`;
        const isSent = await this.db.isMomentSent(momentId);
        if (!isSent) {
          unsentMoments.push(moment);
        }
      }

      if (unsentMoments.length === 0) {
        console.log(`ℹ️  All key moments for chat ${chatId} have already been sent`);
        return;
      }

      console.log(`📊 Found ${unsentMoments.length} unsent key moment(s) out of ${allMomentsFromStorage.length} total for chat ${chatId}`);

      // Send only UNSENT moments in a single message
      const summary = this.formatSummary(unsentMoments, chatId);
      
      // Only send if there are major moments to share
      if (!summary) {
        console.log(`   ℹ️  No major moments to share (filtered out trivial moments)`);
        return;
      }
      
      // Send to user via API
      if (this.apiClient.enabled) {
        await this.sendMessageToUser(chatId, summary);
      } else {
        // If API not enabled, just log it
        console.log('\n📬 Key Moments Summary (API not enabled, would send):');
        console.log(summary);
      }

      // Mark only the unsent moments as sent to avoid duplicate notifications
      for (const moment of unsentMoments) {
        const momentId = `${chatId}-${moment.type}-${moment.date}-${moment.description.substring(0, 50)}`;
        await this.db.markMomentSent(momentId, chatId);
        this.sentMomentIds.add(momentId); // Cache in memory too
      }

      console.log(`✅ Sent ${unsentMoments.length} key moment(s) to user for chat ${chatId} in a single message`);
    } catch (error) {
      console.error(`❌ Error sending conversation summary for chat ${chatId}:`, error);
      console.error(error.stack);
    } finally {
      // Remove from sending set after a short delay to prevent rapid re-sends
      setTimeout(() => {
        this.sendingSummaries.delete(chatId);
      }, 5000); // 5 second cooldown
    }
  }

  /**
   * Format key moments into a readable summary
   * Show major moments with day/time and actual messages to make it personal
   */
  formatSummary(moments, chatId) {
    if (!moments || moments.length === 0) {
      return null; // Don't send if no moments
    }

    // Filter to only major moments (higher confidence, important types)
    // Focus on milestones, shared interests, important dates - skip trivial preferences
    const majorMoments = moments
      .filter(moment => {
        if (!moment || !moment.type) return false;
        // Only include major moment types
        const majorTypes = ['milestone', 'shared_interest', 'important_date', 'first_contact'];
        if (!majorTypes.includes(moment.type)) return false;
        // Require higher confidence for major moments (0.5+)
        const confidence = moment.confidence || 0.3;
        return confidence >= 0.5;
      })
      .sort((a, b) => {
        // Sort by confidence (highest first), then by date (most recent first)
        const confDiff = (b.confidence || 0.3) - (a.confidence || 0.3);
        if (confDiff !== 0) return confDiff;
        const dateA = new Date(a.date || a.extractedAt || 0).getTime();
        const dateB = new Date(b.date || b.extractedAt || 0).getTime();
        return dateB - dateA;
      })
      .slice(0, 3); // Only show top 3 major moments

    if (majorMoments.length === 0) {
      return null; // No major moments to share
    }

    // Format each moment with date/time and context
    const formattedMoments = majorMoments.map(moment => {
      // Format date/time in a friendly way
      let dateTimeStr = '';
      const momentDate = moment.date || moment.extractedAt;
      if (momentDate) {
        try {
          const date = new Date(momentDate);
          const now = new Date();
          const daysDiff = Math.floor((now - date) / (1000 * 60 * 60 * 24));
          
          if (daysDiff === 0) {
            // Today - show time
            dateTimeStr = `Today at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
          } else if (daysDiff === 1) {
            dateTimeStr = `Yesterday at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
          } else if (daysDiff < 7) {
            dateTimeStr = `${date.toLocaleDateString('en-US', { weekday: 'short' })} at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
          } else {
            dateTimeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          }
        } catch (e) {
          // If date parsing fails, skip it
        }
      }

      // Get the actual message/context to make it personal
      const context = moment.context || '';
      const description = moment.description || 'Something happened';
      
      // Build the moment line
      let momentLine = description;
      if (context && context.length > 0 && context.length < 100) {
        // Include context if it's short and meaningful
        momentLine += ` "${context}"`;
      }
      if (dateTimeStr) {
        momentLine += ` (${dateTimeStr})`;
      }
      
      return momentLine;
    });

    // Build the message - keep it personal and concise
    if (formattedMoments.length === 1) {
      return `Hey! I noticed: ${formattedMoments[0]}`;
    } else {
      let message = `Hey! Here are some moments I noticed:\n\n`;
      formattedMoments.forEach((moment, idx) => {
        message += `${idx + 1}. ${moment}\n`;
      });
      return message.trim();
    }
  }

  /**
   * Send message to user via Series API
   */
  async sendMessageToUser(chatId, messageText) {
    if (!this.apiClient.enabled) {
      console.warn('API client not enabled. Cannot send message.');
      console.log('\n📬 Key Moments Summary (would send if API enabled):');
      console.log(messageText);
      return;
    }

    try {
      // Get the sender phone number from config
      const senderPhone = config.senderPhoneNumber;
      
      if (!senderPhone) {
        console.warn('No sender phone number configured. Cannot send message.');
        console.log('\n📬 Key Moments Summary:');
        console.log(messageText);
        return;
      }

      // Check if we should send to a notification phone number or to the chat
      const notificationPhone = config.notificationPhoneNumber;
      
      if (notificationPhone && notificationPhone !== senderPhone) {
        // Send to a separate notification phone number (user's personal number)
        try {
          // Try to find or create a chat with the notification phone
          const notificationChat = await this.findOrCreateNotificationChat(notificationPhone, senderPhone);
          await this.apiClient.sendMessage(notificationChat.id, messageText);
          console.log(`📤 Sent key moments summary to notification chat ${notificationChat.id} (${notificationPhone})`);
        } catch (error) {
          console.warn(`Could not send to notification phone ${notificationPhone}, sending to conversation instead:`, error.message);
          // Fallback to sending to the conversation chat
          await this.apiClient.sendMessage(chatId, messageText);
          console.log(`📤 Sent key moments summary to conversation chat ${chatId}`);
        }
      } else {
        // Send to the conversation chat itself
        await this.apiClient.sendMessage(chatId, messageText);
        console.log(`📤 Sent key moments summary to conversation chat ${chatId}`);
      }
    } catch (error) {
      console.error('Error sending message to user:', error);
      // Log the summary anyway so user can see it
      console.log('\n📬 Key Moments Summary (sending failed):');
      console.log(messageText);
      throw error;
    }
  }

  /**
   * Find or create a chat for sending notifications to the user
   */
  async findOrCreateNotificationChat(notificationPhone, senderPhone) {
    try {
      // Try to find existing chat
      const chats = await this.apiClient.listChats(notificationPhone);
      const existingChat = chats.find(chat => {
        const participants = (chat.participants || chat.chat_handles || []).map(p => 
          p.phone_number || p.identifier || p
        );
        return participants.includes(senderPhone) && participants.length === 2;
      });

      if (existingChat) {
        return existingChat;
      }

      // Create a new chat for notifications
      const newChat = await this.apiClient.createGroupChat(
        [notificationPhone],
        '🔔 Key Moments notifications will appear here',
        senderPhone
      );
      
      return newChat.data || newChat;
    } catch (error) {
      console.error('Error finding/creating notification chat:', error);
      throw error;
    }
  }

  /**
   * Manually trigger summary for a chat (useful for testing or immediate sending)
   */
  async sendSummaryNow(chatId) {
    const activity = this.conversationActivity.get(chatId);
    if (activity && activity.timer) {
      clearTimeout(activity.timer);
    }
    await this.sendConversationSummary(chatId);
  }

  /**
   * Get ALL key moments from storage for a chat (regardless of sent status)
   */
  async getAllMomentsFromStorage(chatId) {
    try {
      const chatMoments = await this.db.getKeyMomentsByChat(chatId);
      
      // Sort by date
      chatMoments.sort((a, b) => {
        const dateA = new Date(a.date || a.extractedAt).getTime();
        const dateB = new Date(b.date || b.extractedAt).getTime();
        return dateA - dateB;
      });
      
      return chatMoments;
    } catch (error) {
      console.error(`Error loading moments from storage for chat ${chatId}:`, error);
      return [];
    }
  }

  /**
   * Get pending moments from storage (for testing/utility scripts)
   */
  async getPendingMomentsFromStorage(chatId) {
    const allMoments = await this.getAllMomentsFromStorage(chatId);
    
    const pending = [];
    for (const moment of allMoments) {
      const momentId = `${chatId}-${moment.type}-${moment.date}-${moment.description.substring(0, 50)}`;
      const isSent = await this.db.isMomentSent(momentId);
      if (!isSent) {
        pending.push(moment);
      }
    }
    return pending;
  }

  /**
   * Get all pending moments for a chat (from memory)
   */
  async getPendingMoments(chatId) {
    const activity = this.conversationActivity.get(chatId);
    if (!activity) {
      return [];
    }
    
    const pending = [];
    for (const moment of activity.keyMoments) {
      const momentId = `${chatId}-${moment.type}-${moment.date}-${moment.description.substring(0, 50)}`;
      const isSent = await this.db.isMomentSent(momentId);
      if (!isSent) {
        pending.push(moment);
      }
    }
    return pending;
  }

  async start() {
    await this.db.connect();
    console.log('Notification service started');
    console.log(`Inactivity timeout: ${config.conversationInactivityMinutes || 30} minutes`);
    console.log(`API client enabled: ${this.apiClient.enabled}`);
    
    // Periodically check for old conversations and send summaries
    // This ensures we don't miss conversations that ended without new messages
    setInterval(async () => {
      const now = new Date();
      for (const [chatId, activity] of this.conversationActivity.entries()) {
        const timeSinceLastMessage = now - activity.lastMessageTime;
        if (timeSinceLastMessage >= this.inactivityTimeout) {
          // Check if there are any key moments in storage for this chat
          const momentsFromStorage = await this.getAllMomentsFromStorage(chatId);
          if (momentsFromStorage.length > 0) {
            // Conversation has been inactive and has key moments, send summary
            await this.sendConversationSummary(chatId);
          }
        }
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  async stop() {
    // Send summaries for all active conversations before stopping
    console.log('Sending final summaries for all active conversations...');
    for (const chatId of this.conversationActivity.keys()) {
      await this.sendConversationSummary(chatId);
    }

    // Clear all timers
    for (const activity of this.conversationActivity.values()) {
      if (activity.timer) {
        clearTimeout(activity.timer);
      }
    }

    await this.saveSentMoments();
    console.log('Notification service stopped');
  }
}

module.exports = NotificationService;
