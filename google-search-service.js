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
    
    // Rate limiting to prevent 429 errors
    this.lastSearchTime = 0;
    this.searchCooldown = 15 * 1000; // 15 seconds between searches (increased from 10)
    this.rateLimitHit = false;
    this.rateLimitResetTime = 0;
    this.rateLimitResetDuration = 60 * 60 * 1000; // 1 hour cooldown if rate limited
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3; // After 3 errors, disable for a while
  }

  /**
   * Search for restaurants using Google Custom Search API
   * Enhanced to get more specific restaurant pages (menus, reservations, etc.)
   */
  async searchRestaurants(query, location = null) {
    if (!this.enabled) {
      throw new Error('Google Custom Search API not configured. Set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_ENGINE_ID in .env');
    }

    // Check rate limiting
    const rateLimitCheck = this.canMakeSearch();
    if (!rateLimitCheck.canSearch) {
      console.log(`⏸️  Skipping Google Search: ${rateLimitCheck.reason}`);
      throw new Error(`Rate limited: ${rateLimitCheck.reason}`);
    }

    try {
      // Build search query for restaurants - prioritize official sites and booking pages
      let searchQuery = query;
      if (!searchQuery.toLowerCase().includes('restaurant')) {
        searchQuery = `${query} restaurant`;
      }
      if (location) {
        searchQuery += ` near ${location}`;
      }
      
      // Add terms to get more actionable results (official sites, menus, reservations)
      // This helps find specific restaurant pages rather than just review sites
      if (!query.toLowerCase().includes('menu') && !query.toLowerCase().includes('reserve') && !query.toLowerCase().includes('book')) {
        searchQuery = `${searchQuery} official menu reservation`;
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
      // Prioritize official restaurant sites, menus, and booking pages
      const restaurants = response.data.items
        .map((item, index) => {
          // Try to extract address from snippet or title
          const address = this.extractAddress(item.snippet || item.title || '');
          
          // Check if this is an official restaurant site or actionable page
          const isOfficial = /(official|website|menu|reservation|book|order)/i.test(item.title + ' ' + item.link);
          const isReviewSite = /(yelp|tripadvisor|zomato|opentable|google maps)/i.test(item.title + ' ' + item.displayLink);
          
          return {
            name: item.title.replace(/\s*-\s*(Restaurant|Menu|Menu & Prices|Yelp|TripAdvisor|Google|OpenTable|Reservation).*$/i, '').trim(),
            address: address || item.displayLink || 'Address not available',
            rating: this.extractRating(item.snippet || ''),
            snippet: item.snippet,
            link: item.link,
            isOfficial: isOfficial,
            isReviewSite: isReviewSite,
            displayLink: item.displayLink
          };
        })
        // Sort to prioritize official sites and actionable pages
        .sort((a, b) => {
          if (a.isOfficial && !b.isOfficial) return -1;
          if (!a.isOfficial && b.isOfficial) return 1;
          if (!a.isReviewSite && b.isReviewSite) return -1;
          if (a.isReviewSite && !b.isReviewSite) return 1;
          return 0;
        })
        .slice(0, 5); // Take top 5 after sorting

      console.log(`✅ Found ${restaurants.length} restaurants`);
      this.recordSuccessfulSearch();
      return restaurants;
    } catch (error) {
      // Check if it's a rate limit error (429)
      if (error.response && error.response.status === 429) {
        this.handleRateLimitError();
        console.error('❌ Google Search API rate limit error (429). Searches disabled temporarily.');
      } else {
        this.consecutiveErrors++;
        console.error('Error searching restaurants:', error.response?.data || error.message);
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          console.warn(`⚠️  Too many consecutive errors (${this.consecutiveErrors}). Temporarily disabling searches.`);
          this.rateLimitHit = true;
          this.rateLimitResetTime = Date.now() + (30 * 60 * 1000); // 30 minute cooldown
        }
      }
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
   * Check if we can make a search request (rate limiting)
   */
  canMakeSearch() {
    if (!this.enabled) {
      return { canSearch: false, reason: 'Service disabled' };
    }

    const now = Date.now();

    // Check if we're rate limited
    if (this.rateLimitHit) {
      if (now < this.rateLimitResetTime) {
        const minutesRemaining = Math.ceil((this.rateLimitResetTime - now) / (60 * 1000));
        return { canSearch: false, reason: `Rate limited (${minutesRemaining} minutes remaining)` };
      } else {
        // Rate limit period has passed, reset
        console.log('✅ Google Search API rate limit cooldown expired. Resuming searches.');
        this.rateLimitHit = false;
        this.rateLimitResetTime = 0;
        this.consecutiveErrors = 0;
      }
    }

    // Check cooldown between searches
    const timeSinceLastSearch = now - this.lastSearchTime;
    if (timeSinceLastSearch < this.searchCooldown) {
      const secondsRemaining = Math.ceil((this.searchCooldown - timeSinceLastSearch) / 1000);
      return { canSearch: false, reason: `Cooldown active (${secondsRemaining}s remaining)` };
    }

    return { canSearch: true };
  }

  /**
   * Handle rate limit errors
   */
  handleRateLimitError() {
    const now = Date.now();
    this.rateLimitHit = true;
    this.rateLimitResetTime = now + this.rateLimitResetDuration;
    this.consecutiveErrors++;
    
    console.warn(`⚠️  Google Search API rate limit hit (429). Disabling searches for ${this.rateLimitResetDuration / (60 * 1000)} minutes.`);
    console.warn(`   This is error #${this.consecutiveErrors}. After ${this.maxConsecutiveErrors} errors, searches will be disabled longer.`);
    
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      // Extend the cooldown if we keep hitting errors
      this.rateLimitResetDuration = 2 * 60 * 60 * 1000; // 2 hours
      this.rateLimitResetTime = now + this.rateLimitResetDuration;
      console.warn(`   ⚠️  Multiple rate limit errors detected. Extended cooldown to ${this.rateLimitResetDuration / (60 * 1000)} minutes.`);
    }
  }

  /**
   * Record a successful search
   */
  recordSuccessfulSearch() {
    this.lastSearchTime = Date.now();
    this.consecutiveErrors = 0; // Reset error count on success
  }

  /**
   * Search for places/activities using Google Custom Search API
   * Enhanced to get more specific, actionable results
   */
  async searchPlaces(query, location = null) {
    if (!this.enabled) {
      throw new Error('Google Custom Search API not configured. Set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_ENGINE_ID in .env');
    }

    // Check rate limiting
    const rateLimitCheck = this.canMakeSearch();
    if (!rateLimitCheck.canSearch) {
      console.log(`⏸️  Skipping Google Search: ${rateLimitCheck.reason}`);
      throw new Error(`Rate limited: ${rateLimitCheck.reason}`);
    }

    try {
      // Enhance query to get more specific results
      let searchQuery = query;
      
      // Add location if specified
      if (location) {
        searchQuery += ` near ${location}`;
      }
      
      // Add terms to get more specific, actionable results
      // This helps find specific pages, booking links, official sites, etc.
      const specificTerms = ['official', 'website', 'book', 'reserve', 'tickets', 'info'];
      // Don't add if query already contains these terms
      const hasSpecificTerm = specificTerms.some(term => query.toLowerCase().includes(term));
      if (!hasSpecificTerm) {
        // Add "official" or "website" to get more direct results
        searchQuery = `${query} official website`;
      }

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

      // Format results with better information extraction
      const results = response.data.items.slice(0, 5).map(item => {
        // Try to extract more specific information from the result
        const snippet = item.snippet || '';
        const title = item.title || '';
        
        // Check if this is a specific actionable page (booking, tickets, etc.)
        const isActionable = /(book|reserve|buy|ticket|schedule|menu|order|contact)/i.test(title + ' ' + snippet + ' ' + item.link);
        
        return {
          title: title,
          snippet: snippet,
          link: item.link,
          displayLink: item.displayLink,
          isActionable: isActionable
        };
      });

      // Sort results to prioritize actionable ones
      results.sort((a, b) => {
        if (a.isActionable && !b.isActionable) return -1;
        if (!a.isActionable && b.isActionable) return 1;
        return 0;
      });

      console.log(`✅ Found ${results.length} results`);
      this.recordSuccessfulSearch();
      return results;
    } catch (error) {
      // Check if it's a rate limit error (429)
      if (error.response && error.response.status === 429) {
        this.handleRateLimitError();
        console.error('❌ Google Search API rate limit error (429). Searches disabled temporarily.');
      } else {
        this.consecutiveErrors++;
        console.error('Error searching places:', error.response?.data || error.message);
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          console.warn(`⚠️  Too many consecutive errors (${this.consecutiveErrors}). Temporarily disabling searches.`);
          this.rateLimitHit = true;
          this.rateLimitResetTime = Date.now() + (30 * 60 * 1000); // 30 minute cooldown
        }
      }
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
      
      // Indicate if this is an official site or booking page
      if (restaurant.isOfficial) {
        message += ` ✅ Official`;
      }
      message += `\n`;
      
      if (restaurant.address && restaurant.address !== 'Address not available' && !restaurant.address.startsWith('http')) {
        message += `   📍 ${restaurant.address}\n`;
      }
      
      if (restaurant.snippet) {
        // Show first 120 chars of snippet if available
        const snippet = restaurant.snippet.length > 120 
          ? restaurant.snippet.substring(0, 120) + '...'
          : restaurant.snippet;
        message += `   ${snippet}\n`;
      }
      
      // Add direct link to the restaurant - make it prominent
      if (restaurant.link) {
        try {
          const url = new URL(restaurant.link);
          const domain = url.hostname.replace(/^www\./, '');
          const path = url.pathname;
          
          // Create a more readable link format
          let displayLink = domain;
          if (path && path !== '/' && path.length < 60) {
            // Show path if it's short and meaningful (like /menu, /reservations, etc.)
            displayLink += path;
          }
          
          // Highlight if it's a booking/reservation page
          const isBookingPage = /(reserve|book|order|menu)/i.test(path + ' ' + restaurant.link);
          if (isBookingPage) {
            message += `   🎯 ${displayLink} (${isBookingPage ? 'Book/Order here' : 'Visit site'})\n`;
          } else {
            message += `   🔗 ${displayLink}\n`;
          }
          message += `   📱 Full link: ${restaurant.link}\n`;
        } catch (e) {
          // If URL parsing fails, just show the link
          const cleanLink = restaurant.link.replace(/^https?:\/\//, '').replace(/\/$/, '');
          message += `   🔗 ${cleanLink}\n`;
        }
      }
      
      message += `\n`;
    });

    message += `Hope you find something great! 🎉`;
    return message;
  }

  /**
   * Search for sports bars/venues to watch matches
   * Enhanced to get more specific, actionable results
   */
  async searchSportsBars(query, location = null) {
    if (!this.enabled) {
      throw new Error('Google Custom Search API not configured. Set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_ENGINE_ID in .env');
    }

    // Check rate limiting
    const rateLimitCheck = this.canMakeSearch();
    if (!rateLimitCheck.canSearch) {
      console.log(`⏸️  Skipping Google Search: ${rateLimitCheck.reason}`);
      throw new Error(`Rate limited: ${rateLimitCheck.reason}`);
    }

    try {
      // Build search query for sports bars - prioritize official sites
      let searchQuery = query;
      if (!searchQuery.toLowerCase().includes('sports bar')) {
        searchQuery = `sports bar ${query}`;
      }
      if (location) {
        searchQuery += ` near ${location}`;
      }
      
      // Add terms to get more actionable results
      if (!query.toLowerCase().includes('official') && !query.toLowerCase().includes('website')) {
        searchQuery = `${searchQuery} official website`;
      }

      const url = this.customSearchBaseURL;
      const params = {
        key: this.customSearchApiKey,
        cx: this.customSearchEngineId,
        q: searchQuery,
        num: 10
      };

      console.log(`🔍 Searching Google for sports bars: "${searchQuery}"`);
      const response = await axios.get(url, { params });
      
      if (!response.data.items || response.data.items.length === 0) {
        console.log('No sports bar results found');
        return [];
      }

      // Format results - filter and map to venue format
      // Prioritize official sites and actionable pages
      const venues = response.data.items
        .map((item, index) => {
          // Try to extract address from snippet or title
          const address = this.extractAddress(item.snippet || item.title || '');
          
          // Check if this is an official site or actionable page
          const isOfficial = /(official|website|menu|reservation|book|contact)/i.test(item.title + ' ' + item.link);
          const isReviewSite = /(yelp|tripadvisor|zomato|opentable|google maps)/i.test(item.title + ' ' + item.displayLink);
          
          return {
            name: item.title.replace(/\s*-\s*(Sports Bar|Bar|Restaurant|Menu|Yelp|TripAdvisor|Google|OpenTable).*$/i, '').trim(),
            address: address || item.displayLink || 'Address not available',
            rating: this.extractRating(item.snippet || ''),
            snippet: item.snippet,
            link: item.link,
            isOfficial: isOfficial,
            isReviewSite: isReviewSite,
            displayLink: item.displayLink
          };
        })
        // Sort to prioritize official sites
        .sort((a, b) => {
          if (a.isOfficial && !b.isOfficial) return -1;
          if (!a.isOfficial && b.isOfficial) return 1;
          if (!a.isReviewSite && b.isReviewSite) return -1;
          if (a.isReviewSite && !b.isReviewSite) return 1;
          return 0;
        })
        .slice(0, 5);

      console.log(`✅ Found ${venues.length} sports bars/venues`);
      this.recordSuccessfulSearch();
      return venues;
    } catch (error) {
      // Check if it's a rate limit error (429)
      if (error.response && error.response.status === 429) {
        this.handleRateLimitError();
        console.error('❌ Google Search API rate limit error (429). Searches disabled temporarily.');
      } else {
        this.consecutiveErrors++;
        console.error('Error searching sports bars:', error.response?.data || error.message);
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          console.warn(`⚠️  Too many consecutive errors (${this.consecutiveErrors}). Temporarily disabling searches.`);
          this.rateLimitHit = true;
          this.rateLimitResetTime = Date.now() + (30 * 60 * 1000); // 30 minute cooldown
        }
      }
      throw error;
    }
  }

  /**
   * Format sports bar/venue recommendations as a message
   */
  formatSportsBarRecommendations(venues, query = null, preferences = {}) {
    if (!venues || venues.length === 0) {
      return `I couldn't find any sports bars/venues matching "${query || 'your request'}". Try adjusting your search!`;
    }

    let message = `🏟️ Here are some places where you can watch`;
    if (query) {
      message += ` "${query}"`;
    }
    
    // Add personalization based on preferences
    if (preferences.location) {
      message += ` in ${preferences.location}`;
    }
    
    message += `:\n\n`;

    venues.forEach((venue, index) => {
      message += `${index + 1}. **${venue.name}**`;
      if (venue.rating) {
        const stars = '⭐'.repeat(Math.round(venue.rating));
        message += ` ${stars} (${venue.rating}/5)`;
      }
      
      // Indicate if this is an official site or booking page
      if (venue.isOfficial) {
        message += ` ✅ Official`;
      }
      message += `\n`;
      
      if (venue.address && venue.address !== 'Address not available' && !venue.address.startsWith('http')) {
        message += `   📍 ${venue.address}\n`;
      }
      
      if (venue.snippet) {
        // Show first 120 chars of snippet if available
        const snippet = venue.snippet.length > 120 
          ? venue.snippet.substring(0, 120) + '...'
          : venue.snippet;
        message += `   ${snippet}\n`;
      }
      
      // Add direct link to the venue - make it prominent
      if (venue.link) {
        try {
          const url = new URL(venue.link);
          const domain = url.hostname.replace(/^www\./, '');
          const path = url.pathname;
          
          // Create a more readable link format
          let displayLink = domain;
          if (path && path !== '/' && path.length < 60) {
            // Show path if it's short and meaningful (like /menu, /reservations, etc.)
            displayLink += path;
          }
          
          // Highlight if it's a booking/reservation page
          const isBookingPage = /(reserve|book|order|menu|contact)/i.test(path + ' ' + venue.link);
          if (isBookingPage) {
            message += `   🎯 ${displayLink} (Book/Contact here)\n`;
          } else {
            message += `   🔗 ${displayLink}\n`;
          }
          message += `   📱 Full link: ${venue.link}\n`;
        } catch (e) {
          // If URL parsing fails, just show the link
          const cleanLink = venue.link.replace(/^https?:\/\//, '').replace(/\/$/, '');
          message += `   🔗 ${cleanLink}\n`;
        }
      }
      
      message += `\n`;
    });

    message += `Click the links above to find more details! 🎯`;
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
      message += `${index + 1}. **${result.title}**`;
      
      // Indicate if this is an actionable page
      if (result.isActionable) {
        message += ` ✅ Actionable`;
      }
      message += `\n`;
      
      // Show snippet with useful information
      if (result.snippet) {
        // Clean up snippet - remove excessive whitespace and make it more readable
        let snippet = result.snippet.trim();
        // Limit snippet length but try to end at a sentence
        if (snippet.length > 150) {
          const truncated = snippet.substring(0, 150);
          const lastPeriod = truncated.lastIndexOf('.');
          const lastSpace = truncated.lastIndexOf(' ');
          const cutPoint = lastPeriod > 100 ? lastPeriod + 1 : (lastSpace > 100 ? lastSpace : 150);
          snippet = truncated.substring(0, cutPoint) + '...';
        }
        message += `   ${snippet}\n`;
      }
      
      // Add direct link - make it more specific and actionable
      if (result.link) {
        // Extract domain and path for better readability
        try {
          const url = new URL(result.link);
          const domain = url.hostname.replace(/^www\./, '');
          const path = url.pathname;
          
          // Create a more readable link format
          let displayLink = domain;
          if (path && path !== '/' && path.length < 50) {
            // Show path if it's short and meaningful
            displayLink += path;
          }
          
          // Highlight if it's a booking/ticket/actionable page
          const isActionablePage = /(book|reserve|buy|ticket|schedule|order|contact|register)/i.test(path + ' ' + result.link);
          if (isActionablePage || result.isActionable) {
            message += `   🎯 ${displayLink} (${isActionablePage ? 'Book/Buy here' : 'Visit site'})\n`;
          } else {
            message += `   🔗 ${displayLink}\n`;
          }
          message += `   📱 Full link: ${result.link}\n`;
        } catch (e) {
          // If URL parsing fails, just show the link
          const cleanLink = result.link.replace(/^https?:\/\//, '').replace(/\/$/, '');
          message += `   🔗 ${cleanLink}\n`;
        }
      } else if (result.displayLink) {
        message += `   🔗 ${result.displayLink}\n`;
      }
      
      message += `\n`;
    });

    message += `Click the links above to find more details! 🎯`;
    return message;
  }
}

module.exports = GoogleSearchService;
