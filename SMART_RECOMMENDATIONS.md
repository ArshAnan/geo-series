# Smart Recommendations Feature

## Overview

The smart recommendations feature automatically detects when users are planning activities (like going out to eat) and provides helpful recommendations using Google Search API. Recommendations are sent through the 646... number (+16463458837).

## How It Works

1. **Conversation Analysis**: The system continuously analyzes conversation history using OpenAI
2. **Trigger Detection**: When planning activities are detected (e.g., "want to go out for dinner", "where should we eat"), the system triggers
3. **Google Search**: Uses Google Places API or Google Custom Search API to find relevant recommendations
4. **Automatic Delivery**: Recommendations are sent through the configured sender phone number

## Features

- ✅ **Restaurant Recommendations**: Detects when users want to go out to eat and recommends restaurants
- ✅ **Location-Aware**: Extracts location from conversation (e.g., "restaurants in NYC")
- ✅ **Smart Context**: Analyzes full conversation history, not just the last message
- ✅ **Cooldown Protection**: 5-minute cooldown between recommendations to avoid spam
- ✅ **Multiple Trigger Types**: Supports restaurant/food, activities, places, and events

## Files Added

1. **`google-search-service.js`**: Handles Google Places API and Custom Search API integration
2. **`trigger-detector.js`**: Analyzes conversation history to detect planning activities
3. **`GOOGLE_API_SETUP.md`**: Step-by-step guide for setting up Google APIs
4. **`SMART_RECOMMENDATIONS.md`**: This file - feature documentation

## Files Modified

1. **`ai-response-service.js`**: Integrated trigger detection and recommendation sending
2. **`README.md`**: Added documentation for the new feature

## Configuration

### Required Environment Variables

Add to your `.env` file:

```env
# At least one of these is required:
GOOGLE_PLACES_API_KEY=your-google-places-api-key
GOOGLE_CUSTOM_SEARCH_API_KEY=your-google-custom-search-api-key
GOOGLE_CUSTOM_SEARCH_ENGINE_ID=your-search-engine-id
```

See `GOOGLE_API_SETUP.md` for detailed setup instructions.

### Current Configuration

- **Sender Phone Number**: +16463458837 (646... number)
- **Cooldown Period**: 5 minutes between recommendations
- **Trigger Confidence**: Minimum 0.6 (60%) confidence required
- **Search Results**: Top 5 results returned

## Example Usage

### Scenario 1: Restaurant Planning

```
User 1: "Want to go out for dinner?"
User 2: "Sure! Where should we go?"
[System detects restaurant planning trigger]
[System searches: "restaurant"]
Agent: "🍽️ Here are some restaurant recommendations:

1. **Sushi Palace** ⭐⭐⭐⭐⭐ (4.8/5)
   123 Main St, New York, NY

2. **Italian Bistro** ⭐⭐⭐⭐ (4.5/5)
   456 Broadway, New York, NY

3. **Burger House** ⭐⭐⭐⭐ (4.3/5)
   789 Park Ave, New York, NY

Hope you find something great! 🎉"
```

### Scenario 2: Specific Cuisine Request

```
User: "Looking for a good sushi place"
[System detects: triggerType="restaurant", searchQuery="sushi restaurant"]
Agent: "🍽️ Here are some restaurant recommendations for "sushi restaurant":

1. **Sushi Palace** ⭐⭐⭐⭐⭐ (4.8/5)
   ...
```

### Scenario 3: Location-Specific

```
User: "Any Italian restaurants in Brooklyn?"
[System detects: searchQuery="Italian restaurant", location="Brooklyn"]
[System searches: "Italian restaurant near Brooklyn"]
Agent: [Recommendations for Italian restaurants in Brooklyn]
```

## Trigger Detection

The system detects the following patterns:

- **Restaurant/Food**: "going out to eat", "dinner", "lunch", "restaurant", "hungry", "where should we eat", cuisine mentions
- **Activities**: "things to do", "activities", "places to visit", "where to go"
- **Events**: "events", "concerts", "shows", "movies", "theater"

## Technical Details

### Trigger Detection Process

1. Takes last 20 messages for context
2. Uses GPT-4 to analyze conversation
3. Returns JSON with:
   - `shouldTrigger`: boolean
   - `triggerType`: "restaurant" | "food" | "activity" | "place" | "event"
   - `searchQuery`: extracted search query
   - `location`: location if mentioned
   - `confidence`: 0.0-1.0
   - `reasoning`: explanation

### Search Flow

1. **Restaurant/Food triggers** → Google Places API Text Search
2. **Other triggers** → Google Custom Search API (or Places API fallback)
3. Results formatted and sent as message
4. Cooldown timer set for the chat

### Error Handling

- If Google API fails, error is logged but doesn't break the system
- If trigger detection fails, regular AI response still sent
- Graceful degradation if APIs not configured

## Logs

When the feature is working, you'll see logs like:

```
🔍 Checking for triggers in conversation...
✅ Trigger detected: restaurant (confidence: 0.85)
   Search query: "sushi restaurant"
🎯 Sending recommendations for: restaurant
   Query: "sushi restaurant"
🔍 Searching Google Places for: "sushi restaurant restaurant"
✅ Found 5 restaurants
📤 Sending recommendations to chat 12345 from +16463458837...
✅ Successfully sent recommendations!
```

## Troubleshooting

See `README.md` → "Smart Recommendations" section and `GOOGLE_API_SETUP.md` for troubleshooting.

## Future Enhancements

Potential improvements:
- Support for more recommendation types (events, hotels, etc.)
- Integration with reservation systems
- Personalized recommendations based on conversation history
- Multi-language support
- Better location extraction and geocoding
