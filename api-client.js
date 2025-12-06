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
   */
  async getChatMessages(chatId) {
    if (!this.enabled) {
      throw new Error('API client is not enabled. Set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
    }
    try {
      const response = await this.client.get(`/api/chats/${chatId}/chat_messages`);
      return response.data;
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

      const response = await this.client.post(`/api/chats/${chatId}/chat_messages`, payload);
      return response.data;
    } catch (error) {
      console.error('Error sending message:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = SeriesAPIClient;
