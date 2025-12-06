// Series iMessage API Client
require('dotenv').config();
const axios = require('axios');

class SeriesAPIClient {
  constructor() {
    this.baseURL = process.env.SERIES_API_BASE_URL;
    this.apiKey = process.env.SERIES_API_KEY;
    
    // API client is optional - only needed if you want to find/verify chats
    // If not provided, the system will work purely from Kafka events
    if (!this.baseURL || !this.apiKey) {
      console.warn('SERIES_API_BASE_URL and SERIES_API_KEY not set. API client will be disabled.');
      console.warn('The system will work by filtering Kafka events by phone numbers.');
      this.enabled = false;
      return;
    }
    
    this.enabled = true;

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * List chats with optional phone number filter
   */
  async listChats(phoneNumber = null, page = 1, perPage = 25) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      const params = { page, per_page: perPage };
      if (phoneNumber) {
        params.phone_number = phoneNumber;
      }
      const response = await this.client.get('/api/chats', { params });
      return response.data;
    } catch (error) {
      console.error('Error listing chats:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Find chat by phone numbers
   */
  async findChat(phoneNumber = null, phoneNumbers = []) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      const params = {};
      if (phoneNumber) {
        params.phone_number = phoneNumber;
      }
      if (phoneNumbers.length > 0) {
        params['phone_numbers[]'] = phoneNumbers;
      }
      const response = await this.client.get('/api/chats/find', { params });
      return response.data;
    } catch (error) {
      console.error('Error finding chat:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get chat details by ID
   */
  async getChat(chatId) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      const response = await this.client.get(`/api/chats/${chatId}`);
      return response.data;
    } catch (error) {
      console.error('Error getting chat:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get messages for a chat
   * Supports pagination to get latest messages or all messages
   * @param {string} chatId - The chat ID
   * @param {number} page - Page number (default: null)
   * @param {number} perPage - Messages per page (default: 25)
   * @param {boolean} getLatest - If true, fetches the last page to get latest messages
   * @param {boolean} getAllPages - If true, fetches ALL pages to get all unprocessed messages
   */
  async getChatMessages(chatId, page = null, perPage = 25, getLatest = true, getAllPages = false) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      // First, get the first page to check pagination metadata
      const firstPageResponse = await this.client.get(`/api/chats/${chatId}/chat_messages`, {
        params: { page: 1, per_page: perPage }
      });
      
      const firstPageData = firstPageResponse.data;
      const meta = firstPageData?.meta || firstPageResponse.data?.meta;
      const totalPages = meta?.total_pages || meta?.last_page || meta?.pages;
      
      // If we want all pages, fetch all of them
      if (getAllPages && totalPages && totalPages > 1) {
        console.log(`   📄 Found ${totalPages} pages of messages, fetching ALL pages for unprocessed messages...`);
        const allMessages = [];
        
        // Get messages from first page
        const firstPageMessages = firstPageData?.data || firstPageData || [];
        if (Array.isArray(firstPageMessages)) {
          allMessages.push(...firstPageMessages);
        }
        
        // Fetch remaining pages
        for (let p = 2; p <= totalPages; p++) {
          try {
            const pageResponse = await this.client.get(`/api/chats/${chatId}/chat_messages`, {
              params: { page: p, per_page: perPage }
            });
            const pageMessages = pageResponse.data?.data || pageResponse.data || [];
            if (Array.isArray(pageMessages)) {
              allMessages.push(...pageMessages);
            }
          } catch (error) {
            console.warn(`   ⚠️  Error fetching page ${p}:`, error.message);
            // Continue with other pages
          }
        }
        
        // Return all messages in the same format
        return {
          data: allMessages,
          meta: meta
        };
      }
      
      // If we want latest messages and there are multiple pages, fetch the last page
      if (getLatest && totalPages && totalPages > 1) {
        console.log(`   📄 Found ${totalPages} pages of messages, fetching last page for latest messages...`);
        const lastPageResponse = await this.client.get(`/api/chats/${chatId}/chat_messages`, {
          params: { page: totalPages, per_page: perPage }
        });
        return lastPageResponse.data;
      }
      
      // If page is specified, use it
      if (page !== null) {
        const response = await this.client.get(`/api/chats/${chatId}/chat_messages`, {
          params: { page, per_page: perPage }
        });
        return response.data;
      }
      
      // Otherwise return first page
      return firstPageData;
    } catch (error) {
      console.error('Error getting chat messages:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Check iMessage availability for a phone number
   */
  async checkiMessageAvailability(phoneNumber) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      const response = await this.client.post('/api/i_message_availability/check', {
        phone_number: phoneNumber
      });
      return response.data;
    } catch (error) {
      console.error('Error checking iMessage availability:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Create a group chat with multiple phone numbers and send an initial message
   * Based on OpenAPI spec: POST /api/chats
   */
  async createGroupChat(phoneNumbers, messageText, sendFromPhoneNumber, displayName = null) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      const payload = {
        chat: {
          phone_numbers: phoneNumbers
        },
        message: {
          text: messageText
        },
        send_from: sendFromPhoneNumber
      };

      // Add optional display name if provided
      if (displayName) {
        payload.chat.display_name = displayName;
      }

      const response = await this.client.post('/api/chats', payload);
      return response.data;
    } catch (error) {
      console.error('Error creating group chat:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Send a message to an existing chat
   * Based on OpenAPI spec: POST /api/chats/{chat_id}/chat_messages
   */
  async sendMessage(chatId, text, attachments = [], sendFromPhoneNumber = null) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      const payload = {
        message: {
          text: text
        }
      };

      // Add attachments if provided
      if (attachments && attachments.length > 0) {
        payload.message.attachments = attachments;
      }

      // Add send_from if specified
      if (sendFromPhoneNumber) {
        payload.send_from = sendFromPhoneNumber;
      }

      console.log(`   📡 API Request: POST /api/chats/${chatId}/chat_messages`);
      console.log(`   📤 Payload: ${JSON.stringify(payload, null, 2)}`);
      
      const response = await this.client.post(`/api/chats/${chatId}/chat_messages`, payload);
      
      console.log(`   📥 API Response Status: ${response.status}`);
      console.log(`   📥 API Response Data: ${JSON.stringify(response.data, null, 2)}`);
      
      return response.data;
    } catch (error) {
      console.error('   ❌ Error sending message:', error.message);
      if (error.response) {
        console.error(`   ❌ Response Status: ${error.response.status}`);
        console.error(`   ❌ Response Data: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      if (error.request) {
        console.error(`   ❌ Request made but no response:`, error.request);
      }
      throw error;
    }
  }

  /**
   * Add a reaction to a message
   * Based on API spec: POST /api/chat_messages/{id}/reactions
   * @param {number} messageId - The message ID to react to
   * @param {string} reactionType - The reaction type: "like", "love", "laugh", "emphasize", "dislike", "question"
   */
  async addReaction(messageId, reactionType) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      const payload = {
        operation: "add",
        type: reactionType
      };

      console.log(`   📡 API Request: POST /api/chat_messages/${messageId}/reactions`);
      console.log(`   📤 Payload: ${JSON.stringify(payload, null, 2)}`);
      
      const response = await this.client.post(
        `/api/chat_messages/${messageId}/reactions`,
        payload
      );
      
      console.log(`   📥 API Response Status: ${response.status}`);
      console.log(`   📥 API Response Data: ${JSON.stringify(response.data, null, 2)}`);
      
      return response.data;
    } catch (error) {
      console.error('   ❌ Error adding reaction:', error.message);
      if (error.response) {
        console.error(`   ❌ Response Status: ${error.response.status}`);
        console.error(`   ❌ Response Data: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }
}

module.exports = SeriesAPIClient;
