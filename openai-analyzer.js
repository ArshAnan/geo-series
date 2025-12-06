// OpenAI Analysis Service - Extracts key moments from conversations
require('dotenv').config();
const OpenAI = require('openai');
const config = require('./config.json');

class OpenAIAnalyzer {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY must be set in .env');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.model = config.openaiModel || 'gpt-4o';
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

Please identify and extract the following types of moments:
1. First meeting/contact - When did they first start talking?
2. Shared interests - What hobbies, anime, shows, topics do they both like?
3. Important dates/events - Birthdays, anniversaries, special events mentioned
4. Relationship milestones - First time they did something together, inside jokes, memorable moments
5. Personal preferences - Food preferences, favorite things, etc.

Return your analysis as a JSON array of moment objects. Each moment should have:
- type: one of "first_contact", "shared_interest", "important_date", "milestone", "preference"
- description: A clear, concise description of the moment (e.g., "You and the other person first met on X day", "You both shared your liking for [anime/show] on Y date")
- date: The date when this moment occurred (ISO format if possible, or approximate)
- participants: Array of phone numbers involved
- context: Relevant conversation context or quote
- confidence: Your confidence level (0.0 to 1.0)

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
            content: 'You are an expert at analyzing conversations and identifying meaningful relationship moments. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3 // Lower temperature for more consistent extraction
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

      // Validate and enrich moments
      const validatedMoments = moments
        .filter(m => m && m.type && m.description)
        .map(moment => ({
          ...moment,
          chatId: conversationBatch.chatId,
          extractedAt: new Date().toISOString(),
          conversationTimeRange: conversationBatch.timeRange,
          messageCount: conversationBatch.messageCount
        }));

      return validatedMoments;
    } catch (error) {
      console.error('Error analyzing conversation:', error);
      return [];
    }
  }

  /**
   * Process a conversation batch (called directly, not from Kafka)
   */
  async processBatch(conversationBatch) {
    try {
      // Create batch ID to avoid duplicates
      const batchId = `${conversationBatch.chatId}-${conversationBatch.timeRange.start}-${conversationBatch.messageCount}`;
      
      if (this.processedBatches.has(batchId)) {
        console.log(`Skipping already processed batch: ${batchId}`);
        return;
      }

      console.log(`Analyzing conversation batch for chat ${conversationBatch.chatId}...`);

      const moments = await this.analyzeConversation(conversationBatch);

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

  async start() {
    console.log(`OpenAI analyzer started. Using model: ${this.model}`);
    // No Kafka consumer needed - receives batches via processBatch() callback
  }

  async stop() {
    console.log('OpenAI analyzer stopped');
  }
}

module.exports = OpenAIAnalyzer;
