# Quick Start Guide

## Prerequisites Check

Before running, make sure you have:

1. ✅ Node.js installed (check with: `node --version`)
2. ✅ Dependencies installed (run: `npm install`)
3. ✅ Environment variables configured in `.env` file
4. ✅ `config.json` configured with your phone numbers

## Step-by-Step Setup

### 1. Install Dependencies

```bash
cd /Users/arsh/Desktop/geo-series
npm install
```

### 2. Set Up Environment Variables

Create or update your `.env` file in the project root:

```bash
# Required
OPENAI_API_MY_KEY=your-openai-api-key-here

# Kafka Configuration (from your existing setup)
KAFKA_BROKERS=your-kafka-brokers
KAFKA_CLIENT_ID=your-client-id
KAFKA_TOPIC=your-topic
KAFKA_CONSUMER_GROUP=your-consumer-group
KAFKA_SASL_USERNAME=your-username
KAFKA_SASL_PASSWORD=your-password

# Series API (Required for sending messages)
SERIES_API_BASE_URL=your-api-base-url
SERIES_API_KEY=your-series-api-key

# Google Custom Search API (Optional - for smart recommendations)
GOOGLE_CUSTOM_SEARCH_API_KEY=your-google-custom-search-api-key
GOOGLE_CUSTOM_SEARCH_ENGINE_ID=your-search-engine-id
```

**Note**: For smart recommendations to work, you need Google Custom Search API keys. See `GOOGLE_API_SETUP.md` for setup instructions.

### 3. Configure Phone Numbers

Edit `config.json`:

```json
{
  "targetPhoneNumbers": ["+16463458837", "+19294265300", "+12014927092"],
  "senderPhoneNumber": "+16463458837",
  "openaiModel": "gpt-4o"
}
```

Make sure `senderPhoneNumber` is the 646... number (+16463458837).

## Running the System

### Start the Main Application

```bash
node index.js
```

This will:
- Start monitoring Kafka events
- Process incoming messages
- Generate AI responses
- Send smart recommendations when triggered
- Extract key moments from conversations

### Check Status

In a new terminal window:

```bash
# One-time check
node check-status.js

# Watch mode (updates every 5 seconds)
node check-status.js --watch
```

### View Analysis

View conversations and key moments:

```bash
node view-analysis.js
```

## What Happens When Running

1. **Kafka Consumer Starts**: Listens for new messages from your configured topic
2. **AI Response Service Starts**: Ready to respond to messages
3. **Trigger Detection Active**: Monitors conversations for planning activities
4. **Smart Recommendations Ready**: Will automatically search and send recommendations

## Testing Smart Recommendations

Once running, try sending messages like:
- "Want to go out for dinner?"
- "Where should we eat?"
- "Looking for Italian restaurants"

The system will detect these and automatically send restaurant recommendations through the 646... number.

## Logs to Watch For

When everything is working, you'll see:

```
AI Response Service started for +16463458837
   Trigger detection: Enabled
   Google Search: Enabled
```

When a trigger is detected:
```
🔍 Checking for triggers in conversation...
✅ Trigger detected: restaurant (confidence: 0.85)
🎯 Sending recommendations for: restaurant
✅ Successfully sent recommendations!
```

## Troubleshooting

### "API client not enabled"
- Check that `SERIES_API_BASE_URL` and `SERIES_API_KEY` are set in `.env`

### "Google Search: Disabled"
- This is OK if you haven't set up Google Custom Search API yet
- Recommendations won't work, but other features will
- See `GOOGLE_API_SETUP.md` to enable

### No messages being processed
- Check Kafka connection credentials
- Verify `targetPhoneNumbers` in `config.json` match your chat participants
- Check that Kafka topic is correct

### Port already in use / Connection errors
- Make sure no other instance is running
- Check Kafka broker addresses are correct

## Stopping the System

Press `Ctrl+C` in the terminal where `node index.js` is running. The system will gracefully shut down and save all data.

## Next Steps

- Read `README.md` for full documentation
- See `GOOGLE_API_SETUP.md` to enable smart recommendations
- Check `SMART_RECOMMENDATIONS.md` for feature details

