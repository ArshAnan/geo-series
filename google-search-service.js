// Google Search Service - Finds restaurants and recommendations using Google Custom Search API
require('dotenv').config();
const axios = require('axios');

class GoogleSearchService {
  constructor() {
    this.customSearchApiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY || process.env.GOOGLE_SEARCH_API_KEY;
    this.customSearchEngineId = process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID || process.env.GOOGLE_SEARCH_ENGINE_ID;
    
    // Legacy Places API support (optional fallback)
    this.placesApiKey = process.env.GOOGLE_PLACES_API_KEY;
    
    if (!this.customSearchApiKey || !this.customSearchEngineId) {
      console.warn('⚠️  Google Custom Search API keys not configured. Search features will be disabled.');
      console.warn('   Set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_ENGINE_ID in .env');
      console.warn('   (or use GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID as alternative names)');
      this.enabled = false;
    } else {
      this.enabled = true;
    }

    this.customSearchBaseURL = 'https://www.googleapis.com/customsearch/v1';
  }

  /**
   * Search for restaurants using Google Custom Search API
   */
  async searchRestaurants(query, location = null) {
    if (!this.enabled) {
      throw new Error('Google Custom Search API not configured. Set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_ENGINE_ID in .env');
    }

    try {
      // Build search query for restaurants
      let searchQuery = query;
      if (!searchQuery.toLowerCase().includes('restaurant')) {
        searchQuery = `${query} restaurant`;
      }
      if (location) {
        searchQuery += ` near ${location}`;
      }

      const url = this.customSearchBaseURL;
      const params = {
        key: this.customSearchApiKey,
        cx: this.customSearchEngineId,
        q: searchQuery,
        num: 10 // Get more results to filter
      };

      console.log(`🔍 Searching Google for restaurants: "${searchQuery}"`);
      const response = await axios.get(url, { params });
      
      if (!response.data.items || response.data.items.length === 0) {
        console.log('No restaurant results found');
        return [];
      }

      // Format results - filter and map to restaurant format
      const restaurants = response.data.items.slice(0, 5).map((item, index) => {
        // Try to extract address from snippet or title
        const address = this.extractAddress(item.snippet || item.title || '');
        
        return {
          name: item.title.replace(/\s*-\s*(Restaurant|Menu|Menu & Prices|Yelp|TripAdvisor|Google).*$/i, '').trim(),
          address: address || item.displayLink || 'Address not available',
          rating: this.extractRating(item.snippet || ''),
          snippet: item.snippet,
          link: item.link
        };
      });

      console.log(`✅ Found ${restaurants.length} restaurants`);
      return restaurants;
    } catch (error) {
      console.error('Error searching restaurants:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Extract address from text snippet
   */
  extractAddress(text) {
    // Look for address patterns (street address, city, state)
    const addressPatterns = [
      /\d+\s+[\w\s]+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane)[\s,]+(?:[\w\s,]+(?:NY|CA|TX|FL|IL|PA|OH|GA|NC|MI|NJ|VA|WA|AZ|MA|TN|IN|MO|MD|WI|CO|MN|SC|AL|LA|KY|OR|OK|CT|IA|AR|MS|KS|UT|NV|NM|WV|HI|NH|ME|RI|MT|DE|SD|AK|ND|VT|WY|DC))?/i,
      /[\w\s]+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard)[\s,]+[\w\s,]+(?:NY|NYC|New York|Los Angeles|LA|San Francisco|SF|Chicago|Houston|Phoenix|Philadelphia|San Antonio|San Diego|Dallas|San Jose|Austin|Jacksonville|Fort Worth|Columbus|Charlotte|San Francisco|Indianapolis|Seattle|Denver|Washington|Boston|El Paso|Detroit|Nashville|Memphis|Portland|Oklahoma City|Las Vegas|Louisville|Baltimore|Milwaukee|Albuquerque|Tucson|Fresno|Sacramento|Kansas City|Mesa|Atlanta|Omaha|Colorado Springs|Raleigh|Virginia Beach|Miami|Oakland|Minneapolis|Tulsa|Cleveland|Wichita|Arlington)/i
    ];

    for (const pattern of addressPatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[0].trim();
      }
    }
    return null;
  }

  /**
   * Extract rating from text snippet
   */
  extractRating(text) {
    // Look for rating patterns (X.X/5, X.X stars, etc.)
    const ratingPatterns = [
      /(\d+\.\d+)\s*\/\s*5/,
      /(\d+\.\d+)\s*stars?/i,
      /rating[:\s]+(\d+\.\d+)/i,
      /(\d+\.\d+)\s*out of 5/i
    ];

    for (const pattern of ratingPatterns) {
      const match = text.match(pattern);
      if (match) {
        return parseFloat(match[1]);
      }
    }
    return null;
  }

  /**
   * Search for places/activities using Google Custom Search API
   */
  async searchPlaces(query, location = null) {
    if (!this.enabled) {
      throw new Error('Google Custom Search API not configured. Set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_ENGINE_ID in .env');
    }

    try {
      const searchQuery = location 
        ? `${query} near ${location}`
        : query;

      const url = this.customSearchBaseURL;
      const params = {
        key: this.customSearchApiKey,
        cx: this.customSearchEngineId,
        q: searchQuery,
        num: 10
      };

      console.log(`🔍 Searching Google for: "${searchQuery}"`);
      const response = await axios.get(url, { params });
      
      if (!response.data.items || response.data.items.length === 0) {
        return [];
      }

      // Format results
      const results = response.data.items.slice(0, 5).map(item => ({
        title: item.title,
        snippet: item.snippet,
        link: item.link,
        displayLink: item.displayLink
      }));

      console.log(`✅ Found ${results.length} results`);
      return results;
    } catch (error) {
      console.error('Error searching places:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Format restaurant recommendations as a message
   */
  formatRestaurantRecommendations(restaurants, query = null, preferences = {}) {
    if (!restaurants || restaurants.length === 0) {
      return `I couldn't find any restaurants matching "${query || 'your request'}". Try adjusting your search!`;
    }

    let message = `🍽️ Here are some restaurant recommendations`;
    if (query) {
      message += ` for "${query}"`;
    }
    
    // Add personalization based on preferences
    if (preferences.cuisine) {
      message += ` (based on your preference for ${preferences.cuisine} food)`;
    }
    if (preferences.location) {
      message += ` in ${preferences.location}`;
    }
    
    message += `:\n\n`;

    restaurants.forEach((restaurant, index) => {
      message += `${index + 1}. **${restaurant.name}**`;
      if (restaurant.rating) {
        const stars = '⭐'.repeat(Math.round(restaurant.rating));
        message += ` ${stars} (${restaurant.rating}/5)`;
      }
      message += `\n`;
      if (restaurant.address && restaurant.address !== 'Address not available') {
        message += `   📍 ${restaurant.address}\n`;
      }
      if (restaurant.snippet) {
        // Show first 100 chars of snippet if available
        const snippet = restaurant.snippet.length > 100 
          ? restaurant.snippet.substring(0, 100) + '...'
          : restaurant.snippet;
        message += `   ${snippet}\n`;
      }
      message += `\n`;
    });

    message += `Hope you find something great! 🎉`;
    return message;
  }

  /**
   * Format general place/activity recommendations as a message
   */
  formatPlaceRecommendations(results, query = null, preferences = {}) {
    if (!results || results.length === 0) {
      return `I couldn't find anything matching "${query || 'your request'}". Try a different search!`;
    }

    let message = `📍 Here are some recommendations`;
    if (query) {
      message += ` for "${query}"`;
    }
    
    // Add personalization based on preferences
    if (preferences.location) {
      message += ` in ${preferences.location}`;
    }
    
    message += `:\n\n`;

    results.forEach((result, index) => {
      message += `${index + 1}. **${result.title}**\n   ${result.snippet}\n`;
    });

    return message;
  }
}

module.exports = GoogleSearchService;
