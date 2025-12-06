// Notification Service - Sends key moments to users after conversations
require('dotenv').config();
const SeriesAPIClient = require('./api-client');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config.json');

class NotificationService {
  constructor() {
    this.apiClient = new SeriesAPIClient();
    this.conversationActivity = new Map(); // chatId -> { lastMessageTime, timer, keyMoments }
    this.inactivityTimeout = (config.conversationInactivityMinutes || 30) * 60 * 1000; // Default 30 minutes
    this.onKeyMomentCallback = null;
    this.sentMomentIds = new Set(); // Track which moments we've already sent
    this.sentMomentsFile = path.join(__dirname, 'logs', 'sent-moments.json');
    
    // Load sent moments from file
    this.loadSentMoments();
  }

  async loadSentMoments() {
    try {
      if (await fs.pathExists(this.sentMomentsFile)) {
        const data = await fs.readJson(this.sentMomentsFile);
        this.sentMomentIds = new Set(data.sentMomentIds || []);
        if (this.sentMomentIds.size > 0) {
          console.log(`Loaded ${this.sentMomentIds.size} sent moment IDs`);
        }
      }
    } catch (error) {
      console.warn('Could not load sent moments:', error.message);
    }
  }

  async saveSentMoments() {
    try {
      await fs.ensureDir(path.dirname(this.sentMomentsFile));
      await fs.writeJson(this.sentMomentsFile, {
        sentMomentIds: Array.from(this.sentMomentIds)
      }, { spaces: 2 });
    } catch (error) {
      console.warn('Could not save sent moments:', error.message);
    }
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
  addKeyMoment(moment) {
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
    
    // Check if we've already sent this moment
    if (this.sentMomentIds.has(momentId)) {
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
   * Loads ALL key moments from storage for this chat and sends them
   */
  async sendConversationSummary(chatId) {
    try {
      console.log(`📋 Preparing to send conversation summary for chat ${chatId}...`);
      
      // Load ALL key moments from storage for this chat
      const allMomentsFromStorage = await this.getAllMomentsFromStorage(chatId);
      
      if (allMomentsFromStorage.length === 0) {
        console.log(`⚠️  No key moments found in storage for chat ${chatId}`);
        return;
      }

      console.log(`📊 Found ${allMomentsFromStorage.length} key moments in storage for chat ${chatId}`);

      // Send ALL moments from conversation history (not just new ones)
      // This ensures the user sees the complete picture of their conversation
      const summary = this.formatSummary(allMomentsFromStorage, chatId);
      
      // Send to user via API
      if (this.apiClient.enabled) {
        await this.sendMessageToUser(chatId, summary);
      } else {
        // If API not enabled, just log it
        console.log('\n📬 Key Moments Summary (API not enabled, would send):');
        console.log(summary);
      }

      // Mark all moments as sent to avoid duplicate notifications
      allMomentsFromStorage.forEach(moment => {
        const momentId = `${chatId}-${moment.type}-${moment.date}-${moment.description.substring(0, 50)}`;
        this.sentMomentIds.add(momentId);
      });

      await this.saveSentMoments();

      console.log(`✅ Sent all ${allMomentsFromStorage.length} key moments from conversation history to user for chat ${chatId}`);
    } catch (error) {
      console.error(`❌ Error sending conversation summary for chat ${chatId}:`, error);
      console.error(error.stack);
    }
  }

  /**
   * Format key moments into a readable summary
   */
  formatSummary(moments, chatId) {
    if (!moments || moments.length === 0) {
      return `📝 Key Moments from Your Conversation\n\nNo key moments have been detected yet.`;
    }

    const momentTypeLabels = {
      'first_contact': '👋 First Connection',
      'shared_interest': '🎯 Shared Interest',
      'important_date': '📅 Important Date',
      'milestone': '⭐ Milestone',
      'preference': '💭 Preference'
    };

    let summary = `📝 Key Moments from Your Conversation\n\n`;
    
    // Group by type
    const grouped = moments.reduce((acc, moment) => {
      if (!moment || !moment.type) {
        return acc; // Skip invalid moments
      }
      if (!acc[moment.type]) {
        acc[moment.type] = [];
      }
      acc[moment.type].push(moment);
      return acc;
    }, {});

    // Format each group
    Object.entries(grouped).forEach(([type, typeMoments]) => {
      const label = momentTypeLabels[type] || type;
      summary += `${label}:\n`;
      
      typeMoments.forEach(moment => {
        summary += `  • ${moment.description || 'Unknown moment'}`;
        if (moment.context) {
          summary += `\n    "${moment.context}"`;
        }
        if (moment.date) {
          summary += `\n    📅 ${moment.date}`;
        }
        summary += `\n`;
      });
      summary += `\n`;
    });

    summary += `\n💡 These moments were automatically detected from your conversation.`;

    return summary;
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
    const keyMomentsFile = path.join(__dirname, 'logs', 'key-moments.json');
    if (!(await fs.pathExists(keyMomentsFile))) {
      return [];
    }

    try {
      const allMoments = await fs.readJson(keyMomentsFile);
      const chatMoments = allMoments.filter(m => m.chatId === chatId);
      
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
    
    return allMoments.filter(moment => {
      const momentId = `${chatId}-${moment.type}-${moment.date}-${moment.description.substring(0, 50)}`;
      return !this.sentMomentIds.has(momentId);
    });
  }

  /**
   * Get all pending moments for a chat (from memory)
   */
  getPendingMoments(chatId) {
    const activity = this.conversationActivity.get(chatId);
    if (!activity) {
      return [];
    }
    
    return activity.keyMoments.filter(moment => {
      const momentId = `${chatId}-${moment.type}-${moment.date}-${moment.description.substring(0, 50)}`;
      return !this.sentMomentIds.has(momentId);
    });
  }

  async start() {
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
