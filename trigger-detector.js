// Trigger Detector - Analyzes conversation history to detect when users need recommendations
require('dotenv').config();
const OpenAI = require('openai');
const config = require('./config.json');

class TriggerDetector {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY must be set in .env');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.model = config.openaiModel || 'gpt-4o';
    
    // Trigger patterns to detect
    this.triggerTypes = {
      RESTAURANT: 'restaurant',
      FOOD: 'food',
      ACTIVITY: 'activity',
      PLACE: 'place',
      EVENT: 'event'
    };
  }

  /**
   * Analyze conversation history to detect if users need recommendations
   */
  async detectTriggers(conversationHistory, recentMessage) {
    try {
      // Build context from conversation history (last 20 messages)
      const recentHistory = conversationHistory.slice(-20);
      const conversationText = recentHistory.map(msg => {
        const role = msg.role === 'assistant' ? 'Agent' : 'User';
        return `${role}: ${msg.content}`;
      }).join('\n');

      // Add the current message
      const fullContext = conversationText + `\nUser: ${recentMessage.text || ''}`;

      const prompt = `Analyze this conversation and determine if the users are planning an activity that would benefit from recommendations or search results. Look for:

1. **Restaurant/Food planning**: mentions of "going out to eat", "dinner", "lunch", "restaurant", "food", "cuisine", "hungry", "where should we eat", etc.
2. **Activity planning**: mentions of "things to do", "activities", "places to visit", "where to go", "entertainment", etc.
3. **Event planning**: mentions of "events", "concerts", "shows", "movies", "theater", etc.

Respond with a JSON object in this exact format:
{
  "shouldTrigger": true/false,
  "triggerType": "restaurant" | "food" | "activity" | "place" | "event" | null,
  "searchQuery": "specific search query string" | null,
  "location": "location mentioned if any" | null,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

If no trigger is detected, set "shouldTrigger" to false. Be specific with search queries - extract the actual intent (e.g., if they say "want to go out for sushi", the query should be "sushi restaurant").

Conversation:
${fullContext}

JSON Response:`;

      // Build request parameters
      const requestParams = {
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at analyzing conversations to detect when users need location-based recommendations. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3
      };

      // Only add response_format if model supports it (using same logic as openai-analyzer)
      const supportsJsonMode = this.supportsJsonMode(this.model);
      
      if (supportsJsonMode) {
        requestParams.response_format = { type: 'json_object' };
      }

      const response = await this.openai.chat.completions.create(requestParams);

      const content = response.choices[0].message.content.trim();
      let result;
      
      try {
        result = JSON.parse(content);
      } catch (parseError) {
        // Try to extract JSON from text
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          console.warn('Could not parse trigger detection response:', content);
          return {
            shouldTrigger: false,
            triggerType: null,
            searchQuery: null,
            location: null,
            confidence: 0,
            reasoning: 'Failed to parse response'
          };
        }
      }

      // Validate result
      if (!result.shouldTrigger) {
        return {
          shouldTrigger: false,
          triggerType: null,
          searchQuery: null,
          location: result.location || null,
          confidence: result.confidence || 0,
          reasoning: result.reasoning || 'No trigger detected'
        };
      }

      // Only trigger if confidence is high enough (0.6+)
      if ((result.confidence || 0) < 0.6) {
        console.log(`🔍 Trigger detected but confidence too low (${result.confidence} < 0.6)`);
        return {
          shouldTrigger: false,
          triggerType: result.triggerType,
          searchQuery: result.searchQuery,
          location: result.location || null,
          confidence: result.confidence || 0,
          reasoning: result.reasoning || 'Confidence too low'
        };
      }

      console.log(`✅ Trigger detected: ${result.triggerType} (confidence: ${result.confidence})`);
      console.log(`   Search query: "${result.searchQuery}"`);
      if (result.location) {
        console.log(`   Location: "${result.location}"`);
      }

      return {
        shouldTrigger: true,
        triggerType: result.triggerType,
        searchQuery: result.searchQuery,
        location: result.location || null,
        confidence: result.confidence || 0.8,
        reasoning: result.reasoning || 'Trigger detected'
      };
    } catch (error) {
      console.error('Error detecting triggers:', error);
      return {
        shouldTrigger: false,
        triggerType: null,
        searchQuery: null,
        location: null,
        confidence: 0,
        reasoning: `Error: ${error.message}`
      };
    }
  }

  /**
   * Check if model supports JSON response format
   */
  supportsJsonMode(model) {
    // Models that support response_format: json_object
    // Only these specific models support JSON mode - be conservative
    const jsonModeModels = [
      'gpt-4-turbo',
      'gpt-4-turbo-preview',
      'gpt-4-0125-preview',
      'gpt-4-1106-preview',
      'gpt-3.5-turbo-1106',
      'gpt-4o',
      'gpt-4o-mini'
    ];
    
    // Check if model name exactly matches or contains a supported model identifier
    const modelLower = model.toLowerCase();
    return jsonModeModels.some(supported => {
      const supportedLower = supported.toLowerCase();
      // Exact match or model contains the supported identifier
      return modelLower === supportedLower || modelLower.includes(supportedLower);
    });
  }

  /**
   * Extract location from message text (simple keyword-based extraction)
   */
  extractLocation(messageText) {
    // Common location patterns
    const locationPatterns = [
      /(?:in|near|at|around)\s+([A-Z][a-zA-Z\s]+(?:City|Town|NYC|NY|CA|LA|SF|San Francisco|New York|Los Angeles)?)/i,
      /([A-Z][a-zA-Z\s]+(?:City|Town|NYC|NY|CA|LA|SF))/i
    ];

    for (const pattern of locationPatterns) {
      const match = messageText.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return null;
  }
}

module.exports = TriggerDetector;
