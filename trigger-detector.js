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
  async detectTriggers(conversationHistory, recentMessage, pastRecommendations = []) {
    try {
      // Use more conversation history (last 50 messages) to better understand context and preferences
      const recentHistory = conversationHistory.slice(-50);
      const conversationText = recentHistory.map(msg => {
        const role = msg.role === 'assistant' ? 'Agent' : 'User';
        return `${role}: ${msg.content}`;
      }).join('\n');

      // Extract user preferences from conversation history
      const preferences = this.extractPreferences(conversationHistory);
      let preferencesContext = '';
      if (preferences.cuisines.length > 0 || preferences.locations.length > 0 || preferences.mentionedPlaces.length > 0 || pastRecommendations.length > 0) {
        const pastRecsText = pastRecommendations.length > 0 
          ? pastRecommendations.slice(0, 3).map(r => `${r.type}: ${r.query}`).join('; ')
          : 'none';
        
        preferencesContext = `\n\nUSER PREFERENCES FROM CONVERSATION HISTORY:
- Preferred cuisines: ${preferences.cuisines.length > 0 ? preferences.cuisines.join(', ') : 'none mentioned'}
- Preferred locations: ${preferences.locations.length > 0 ? preferences.locations.join(', ') : 'none mentioned'}
- Previously mentioned places: ${preferences.mentionedPlaces.length > 0 ? preferences.mentionedPlaces.slice(0, 5).join(', ') : 'none'}
- Past recommendations sent: ${pastRecsText}

Use this preference context to make better, more personalized recommendations. Avoid repeating past recommendations unless the user explicitly asks for similar places.`;

      // Add the current message
      const fullContext = conversationText + `\nUser: ${recentMessage.text || ''}`;

      const prompt = `Analyze this conversation and determine if the users are ACTIVELY PLANNING an activity that would benefit from NEW recommendations or search results.

IMPORTANT CONTEXT RULES:
- DO NOT trigger if they're just casually discussing food/restaurants without planning to go
- DO NOT trigger if they're just mentioning preferences ("I like Indian food") without asking for recommendations
- DO NOT trigger if they're discussing restaurants they already know about
- DO NOT trigger if recommendations were already provided in this conversation
- ONLY trigger if they're ACTIVELY PLANNING and ASKING for suggestions (e.g., "where should we eat?", "looking for a restaurant", "need recommendations")
- Use the user preferences from conversation history to make BETTER, more personalized recommendations
- If similar recommendations were sent recently, suggest DIFFERENT options or variations

Look for ACTIVE PLANNING indicators:
1. **Restaurant/Food planning**: Explicit questions like "where should we eat?", "looking for restaurants", "need recommendations", "suggest a place", "going out for dinner" (with planning intent)
2. **Activity planning**: "things to do", "activities", "places to visit", "where to go", "entertainment" (with planning intent)
3. **Event planning**: "events", "concerts", "shows", "movies", "theater" (with planning intent)

Respond with a JSON object in this exact format:
{
  "shouldTrigger": true/false,
  "triggerType": "restaurant" | "food" | "activity" | "place" | "event" | null,
  "searchQuery": "specific search query string enriched with user preferences" | null,
  "location": "location mentioned if any" | null,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "preferences": {
    "cuisine": "preferred cuisine type if mentioned" | null,
    "location": "preferred location if mentioned" | null,
    "priceRange": "budget/preference if mentioned" | null
  }
}

If no trigger is detected, set "shouldTrigger" to false. Be specific with search queries - extract the actual intent AND incorporate user preferences from conversation history (e.g., if they previously mentioned liking Indian food and now ask "where should we eat?", the query should be "Indian restaurant" or similar).

CRITICAL: Only trigger if they're ACTIVELY ASKING for recommendations or planning to go somewhere. If they're just chatting about food preferences or discussing restaurants they know, set "shouldTrigger" to false. Be conservative - it's better to miss a trigger than to spam recommendations.

Conversation:
${fullContext}${preferencesContext}

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
        temperature: 0.2 // Lower temperature for more conservative detection
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

      // Only trigger if confidence is high enough (0.75+) - increased threshold
      if ((result.confidence || 0) < 0.75) {
        console.log(`🔍 Trigger detected but confidence too low (${result.confidence} < 0.75)`);
        console.log(`   Reasoning: ${result.reasoning || 'No reasoning provided'}`);
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

  /**
   * Extract user preferences from conversation history
   * This helps make better, more personalized recommendations
   */
  extractPreferences(conversationHistory) {
    const preferences = {
      cuisines: [],
      locations: [],
      mentionedPlaces: []
    };

    // Analyze last 100 messages for preferences
    const historyToAnalyze = conversationHistory.slice(-100);
    
    // Common cuisine types
    const cuisineKeywords = [
      'indian', 'italian', 'chinese', 'japanese', 'mexican', 'thai', 'korean',
      'french', 'mediterranean', 'american', 'pizza', 'sushi', 'bbq', 'steak',
      'seafood', 'vegetarian', 'vegan', 'halal', 'kosher', 'mexican', 'tacos',
      'burgers', 'pasta', 'ramen', 'curry', 'sushi', 'sashimi'
    ];

    // Extract cuisines mentioned
    historyToAnalyze.forEach(msg => {
      const text = (msg.content || '').toLowerCase();
      cuisineKeywords.forEach(cuisine => {
        if (text.includes(cuisine) && !preferences.cuisines.includes(cuisine)) {
          preferences.cuisines.push(cuisine);
        }
      });
    });

    // Extract locations mentioned
    const locationPatterns = [
      /(?:in|near|at|around|to)\s+([A-Z][a-zA-Z\s]+(?:City|Town|NYC|NY|CA|LA|SF|San Francisco|New York|Los Angeles|Brooklyn|Manhattan|Queens|Bronx|Staten Island)?)/gi,
      /\b(NYC|NY|New York|Los Angeles|LA|San Francisco|SF|Chicago|Houston|Phoenix|Philadelphia|San Antonio|San Diego|Dallas|San Jose|Austin|Jacksonville|Fort Worth|Columbus|Charlotte|Indianapolis|Seattle|Denver|Washington|Boston|Brooklyn|Manhattan|Queens|Bronx)\b/gi
    ];

    historyToAnalyze.forEach(msg => {
      const text = msg.content || '';
      locationPatterns.forEach(pattern => {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const location = match[1] || match[0];
          if (location && !preferences.locations.includes(location)) {
            preferences.locations.push(location);
          }
        }
      });
    });

    // Extract restaurant/place names (capitalized words that might be place names)
    historyToAnalyze.forEach(msg => {
      const text = msg.content || '';
      // Look for patterns like "Let's go to [Place Name]" or "[Place Name] is good"
      const placePatterns = [
        /(?:at|to|from|went to|tried|visited|liked|love|enjoyed)\s+([A-Z][a-zA-Z\s&']{2,})/g,
        /"([A-Z][a-zA-Z\s&']{2,})"/g
      ];
      
      placePatterns.forEach(pattern => {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const place = match[1].trim();
          // Filter out common words that aren't places
          if (place && place.length > 2 && 
              !['The', 'This', 'That', 'There', 'Here', 'Where', 'What', 'When', 'How'].includes(place.split(' ')[0]) &&
              !preferences.mentionedPlaces.includes(place)) {
            preferences.mentionedPlaces.push(place);
          }
        }
      });
    });

    return preferences;
  }
}

module.exports = TriggerDetector;
