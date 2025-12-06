# Google Custom Search API Setup Guide

This guide will help you set up Google Custom Search API for the smart recommendations feature.

## Overview

The smart recommendations feature uses **Google Custom Search API** to find restaurants and places when users are planning activities. This API provides comprehensive web search results that include restaurant information, reviews, and location details.

## Setup Steps

### Step 1: Create a Custom Search Engine

1. Go to [Programmable Search Engine](https://programmablesearchengine.google.com/)
2. Click "Add" to create a new search engine
3. Enter:
   - **Sites to search**: `*` (asterisk to search the entire web)
   - **Name**: "Series Recommendations" (or any name you prefer)
4. Click "Create"
5. Click "Control Panel" for your search engine
6. Under "Basics", find "Search the entire web" and toggle it **ON**
7. Click "Update" to save
8. Copy your **Search engine ID** (you'll see it under "Details" → "Search engine ID")

### Step 2: Get API Key from Google Cloud

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one:
   - Click "Select a project" → "New Project"
   - Enter project name (e.g., "Series Recommendations")
   - Click "Create"
3. Enable Custom Search API:
   - Go to "APIs & Services" → "Library"
   - Search for "Custom Search API"
   - Click on "Custom Search API"
   - Click "Enable"
4. Create API Key:
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "API Key"
   - Copy your API key
   - (Optional) Click "Restrict Key" to limit usage:
     - Under "API restrictions", select "Restrict key"
     - Choose "Custom Search API"
     - Save

### Step 3: Add to Environment Variables

Add to your `.env` file:

```env
GOOGLE_CUSTOM_SEARCH_API_KEY=your-api-key-here
GOOGLE_CUSTOM_SEARCH_ENGINE_ID=your-search-engine-id-here
```

**Alternative variable names** (also supported):
```env
GOOGLE_SEARCH_API_KEY=your-api-key-here
GOOGLE_SEARCH_ENGINE_ID=your-search-engine-id-here
```

## Pricing

### Google Custom Search API

- **Free Tier**: 100 searches per day
- **Paid**: $5 per 1,000 queries after free tier

For most use cases, the free tier of 100 searches per day is sufficient. If you need more, the paid tier is very affordable at $5 per 1,000 queries.

## Testing

After adding your API keys, restart the service:

```bash
node index.js
```

You should see in the logs:
```
AI Response Service started for +16463458837
   Trigger detection: Enabled
   Google Search: Enabled
```

To test recommendations, try sending messages like:
- "Want to go out for dinner?"
- "Where should we eat?"
- "Looking for Italian restaurants"
- "Best sushi places in NYC"

## How It Works

When a trigger is detected (e.g., users planning to go out to eat):

1. **Search Query Formation**: The system builds a search query like "sushi restaurant near NYC"
2. **Google Custom Search**: Searches the web using your custom search engine
3. **Result Processing**: Extracts restaurant names, addresses, ratings from search results
4. **Message Formatting**: Formats results into a friendly message
5. **Delivery**: Sends recommendations through the 646... number

## Troubleshooting

### "Google Search: Disabled" in logs

- Check that both `GOOGLE_CUSTOM_SEARCH_API_KEY` and `GOOGLE_CUSTOM_SEARCH_ENGINE_ID` are set in `.env`
- Verify the keys are correct (no extra spaces, quotes, etc.)
- Restart the service after adding keys

### "Error searching restaurants"

- Verify Custom Search API is enabled in Google Cloud Console
- Check API key restrictions (should allow Custom Search API)
- Verify your search engine ID is correct
- Ensure "Search the entire web" is enabled in your Custom Search Engine settings
- Check API quota/limits in Google Cloud Console (100 free searches/day)

### "No results found"

- This is normal if the search query doesn't match any results
- Try more specific queries (e.g., "Italian restaurant NYC" instead of just "restaurant")
- Check that your Custom Search Engine is configured to search the entire web

### No recommendations being sent

- Check trigger detection logs: `🔍 Checking for triggers`
- Verify conversation includes planning keywords (e.g., "going out to eat", "restaurant", "dinner")
- Check cooldown period (5 minutes between recommendations in the same chat)
- Verify Series API credentials are set correctly (`SERIES_API_BASE_URL` and `SERIES_API_KEY`)

### API Quota Exceeded

- Free tier: 100 searches per day
- Check usage in Google Cloud Console → APIs & Services → Dashboard
- If you need more, enable billing (paid tier is $5 per 1,000 queries)

## Security Notes

1. **Restrict API Keys**: In Google Cloud Console, restrict your API key to only "Custom Search API"
2. **Set Usage Limits**: Configure quota limits to prevent unexpected charges
3. **Monitor Usage**: Regularly check API usage in Google Cloud Console → APIs & Services → Dashboard
4. **Never Commit Keys**: Always keep `.env` file in `.gitignore` (already configured)
5. **Use Environment Variables**: Never hardcode API keys in your code

## Quick Reference

**Required Environment Variables:**
```env
GOOGLE_CUSTOM_SEARCH_API_KEY=your-api-key
GOOGLE_CUSTOM_SEARCH_ENGINE_ID=your-engine-id
```

**Where to get them:**
- API Key: [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
- Engine ID: [Programmable Search Engine](https://programmablesearchengine.google.com/) → Your search engine → Control Panel → Details

**Test Command:**
```bash
node index.js
```

Look for: `Google Search: Enabled` in the startup logs.

