# iMessage Conversation Logger

A system that monitors iMessage and SMS conversations between two people, logs them via Kafka, analyzes them with OpenAI to extract key relationship moments, and stores everything in JSON files for nostalgia purposes.

**Note**: The system processes all messages (iMessage and SMS) that come through the Series API Kafka events. If one participant doesn't have iMessage, SMS messages will be captured as long as they're included in the Kafka events.

## Features

- **Real-time Monitoring**: Consumes Kafka events from Series iMessage Service
- **Key Moment Extraction**: Uses OpenAI API to identify relationship milestones, shared interests, and memorable moments
- **Automatic Notifications**: Sends key moments summaries to users after conversations end
- **Smart Recommendations**: Automatically detects when users are planning activities (e.g., going out to eat) and provides restaurant/place recommendations via Google Search API
- **AI-Powered Chat Responses**: Intelligent agent that responds to messages with personality and context awareness
- **Proactive Conversation Initiation**: Automatically starts conversations based on shared interests when chats are inactive
- **Non-invasive**: Only listens to events, doesn't modify or intercept messages
- **JSON Storage**: Stores conversations and key moments in easy-to-parse JSON files

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file with the following variables:

```env
# Kafka Configuration (from existing setup)
KAFKA_CLIENT_ID=your-client-id
KAFKA_BROKERS=broker1:9092,broker2:9092
KAFKA_SASL_USERNAME=your-username
KAFKA_SASL_PASSWORD=your-password
KAFKA_CONSUMER_GROUP=imessage-logger-group
KAFKA_TOPIC=your-team-topic

# Series API Configuration (OPTIONAL - only needed if you want to find/verify chats via API)
# If not provided, the system will filter messages directly from Kafka events by phone numbers
SERIES_API_BASE_URL=https://api.example.com
SERIES_API_KEY=your-api-key

# OpenAI Configuration
OPENAI_API_KEY=your-openai-api-key

# Google Custom Search API Configuration (for restaurant/place recommendations)
# Get your API key from: https://console.cloud.google.com/
# Get your Engine ID from: https://programmablesearchengine.google.com/
# See GOOGLE_API_SETUP.md for detailed setup instructions
# You can use either naming convention:
GOOGLE_CUSTOM_SEARCH_API_KEY=your-google-custom-search-api-key
GOOGLE_CUSTOM_SEARCH_ENGINE_ID=your-search-engine-id
# OR
GOOGLE_SEARCH_API_KEY=your-google-custom-search-api-key
GOOGLE_SEARCH_ENGINE_ID=your-search-engine-id
```

### 3. Configure Target Conversation

Edit `config.json`:

```json
{
  "targetPhoneNumbers": ["+13175269229", "+13343284472"],
  "chatId": null,
  "batchingWindowMinutes": 5,
  "openaiModel": "gpt-4o",
  "minMessagesForAnalysis": 3,
  "senderPhoneNumber": "+16463458837",
  "conversationInactivityMinutes": 30,
  "notificationPhoneNumber": null
}
```

- `targetPhoneNumbers`: Array of phone numbers (E.164 format) to monitor
- `chatId`: Optional - if set, only monitors this specific chat
- `batchingWindowMinutes`: How long to wait before analyzing a batch of messages
- `openaiModel`: OpenAI model to use (default: `gpt-4o`)
- `minMessagesForAnalysis`: Minimum messages needed before analyzing
- `senderPhoneNumber`: Phone number used to send messages (required for notifications)
- `conversationInactivityMinutes`: Minutes of inactivity before sending key moments summary (default: 30)
- `notificationPhoneNumber`: Optional - if set, key moments are sent to this number instead of the conversation chat
- `conversationInitiatorIntervalMinutes`: How often to check for conversation initiation opportunities (default: 60 minutes)
- `conversationInitiatorMinInactivityMinutes`: Minimum minutes of inactivity before initiating a conversation (default: 120 minutes)
- `conversationInitiatorMaxFrequency`: Maximum number of conversation initiations per day per chat (default: 1)

## Usage

### Start Monitoring

Start the conversation logger:

```bash
node index.js
```

The system will:
1. (Optional) Connect to the Series API to find/verify the target chat (if API credentials are provided)
2. Start consuming Kafka events for `message.received` events
3. Filter messages by target phone numbers or chat ID
4. Process and batch messages
5. Analyze conversations with OpenAI
6. Store conversations and key moments in JSON files
7. **Send key moments summaries to users** after conversations become inactive
8. **Detect planning activities** and automatically provide restaurant/place recommendations via Google Search API
9. **Generate AI responses** with personality and context awareness
10. **Proactively initiate conversations** based on shared interests when chats are inactive

**Note**: If you don't have Series API credentials, the system will work purely from Kafka events by filtering messages that match your target phone numbers. However, notifications will only be logged to console (not sent via API) if API credentials are not configured.

### Check Monitoring Status

Check if the system is monitoring chats and extracting key moments:

```bash
# One-time status check
node check-status.js

# Watch mode (updates every 5 seconds)
node check-status.js --watch

# Watch mode with custom interval (e.g., 10 seconds)
node check-status.js --watch 10
```

The status checker shows:
- **Process Status**: Whether the monitoring system is running
- **Configuration**: Current phone numbers and settings
- **Statistics**: Total chats, messages, and key moments
- **Recent Activity**: Latest messages and key moments
- **Health Check**: Identifies any issues

### View Analysis

View your conversations and extracted key moments:

```bash
# View everything (summary, key moments, and conversations)
node view-analysis.js

# View only key moments
node view-analysis.js --moments

# View only conversations
node view-analysis.js --conversations
```

The viewer displays:
- **Summary**: Total chats, messages, and key moments statistics
- **Key Moments**: Extracted relationship moments grouped by type (first contact, shared interests, milestones, etc.)
- **Conversations**: Recent messages grouped by chat with timestamps

## Output Files

### `logs/conversations.json`

Stores all conversation messages:

```json
[
  {
    "chatId": "1698665",
    "messageId": "53077912",
    "fromPhone": "+19176256109",
    "text": "Message text",
    "sentAt": "2025-12-05 14:42:05 -0600",
    "storedAt": "2025-12-05T20:42:06.000Z"
  }
]
```

### `logs/key-moments.json`

Stores extracted key moments:

```json
[
  {
    "type": "shared_interest",
    "description": "You and the other person shared your liking for Attack on Titan on December 5, 2025",
    "date": "2025-12-05",
    "participants": ["+13175269229", "+13343284472"],
    "context": "Both mentioned watching Attack on Titan",
    "confidence": 0.9,
    "chatId": "1698665",
    "extractedAt": "2025-12-05T20:45:00.000Z"
  }
]
```

## Key Moments Notifications

The system automatically sends key moments summaries to users after conversations end. Here's how it works:

### How It Works

1. **Background Analysis**: As you chat, an AI agent analyzes your conversations in real-time
2. **Key Moment Detection**: The agent identifies important moments like:
   - 👋 First connection
   - 🎯 Shared interests (hobbies, shows, topics)
   - 📅 Important dates (birthdays, anniversaries)
   - ⭐ Relationship milestones
   - 💭 Personal preferences

3. **Automatic Delivery**: After a conversation becomes inactive (default: 30 minutes), a summary is automatically sent containing all detected key moments

### Configuration

- **Send to conversation chat**: Leave `notificationPhoneNumber` as `null` - summaries will be sent to the conversation itself
- **Send to separate number**: Set `notificationPhoneNumber` to your personal phone number - summaries will be sent to a dedicated notification chat
- **Inactivity timeout**: Adjust `conversationInactivityMinutes` to change when summaries are sent (default: 30 minutes)

### Example Summary

```
📝 Key Moments from Your Conversation

👋 First Connection:
  • You and the other person first met on December 5, 2025
    "Hey! I am Series AI"
    📅 2025-12-05

🎯 Shared Interest:
  • You both shared your liking for Attack on Titan on December 5, 2025
    "Both mentioned watching Attack on Titan"
    📅 2025-12-05

💡 These moments were automatically detected from your conversation.
```

## Smart Recommendations

The system includes intelligent trigger detection that automatically provides recommendations when users are planning activities.

### How It Works

1. **Conversation Analysis**: The AI agent continuously analyzes conversation history to detect planning activities
2. **Trigger Detection**: When keywords or context suggest users need recommendations (e.g., "where should we eat?", "going out for dinner", "things to do"), the system automatically triggers
3. **Google Search Integration**: Uses Google Places API or Google Custom Search API to find relevant recommendations
4. **Automatic Delivery**: Recommendations are sent through the configured sender phone number (646... number)

### Supported Triggers

- **Restaurant/Food Planning**: Detects mentions of going out to eat, dinner, lunch, restaurant searches, cuisine preferences
- **Activity Planning**: Identifies when users are looking for things to do, places to visit, entertainment
- **Event Planning**: Detects mentions of events, concerts, shows, movies, theater

### Configuration

The trigger detection system uses OpenAI to analyze conversations and extract:
- **Trigger Type**: restaurant, food, activity, place, or event
- **Search Query**: Specific query extracted from conversation (e.g., "sushi restaurant", "Italian food near NYC")
- **Location**: Location mentioned in conversation (optional)

### Example Flow

```
User 1: "Want to go out for dinner?"
User 2: "Sure! Where should we go?"
[System detects restaurant planning trigger]
[System searches Google Places for restaurants]
Agent (646...): "🍽️ Here are some restaurant recommendations:

1. **Sushi Palace** ⭐⭐⭐⭐⭐ (4.8/5)
   123 Main St, New York, NY

2. **Italian Bistro** ⭐⭐⭐⭐ (4.5/5)
   456 Broadway, New York, NY

Hope you find something great! 🎉"
```

### Cooldown Period

To avoid spamming recommendations, there's a 5-minute cooldown between recommendations in the same chat.

### Setup

To enable recommendations:

1. **Get Google Places API Key** (recommended for restaurant searches):
   - Go to [Google Cloud Console](https://console.cloud.google.com/google/maps-apis)
   - Create a project or select an existing one
   - Enable "Places API"
   - Create credentials (API Key)
   - Add to `.env` as `GOOGLE_PLACES_API_KEY`

2. **Get Google Custom Search API Key** (optional, for general searches):
   - Go to [Programmable Search Engine](https://programmablesearchengine.google.com/)
   - Create a custom search engine
   - Get your API key and Engine ID
   - Add to `.env` as `GOOGLE_CUSTOM_SEARCH_API_KEY` and `GOOGLE_CUSTOM_SEARCH_ENGINE_ID`
   - (Alternative: You can also use `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID`)

**Note**: At least one Google API key is recommended. If only Google Places API is configured, it will be used for all searches. If only Custom Search is configured, it will be used. If both are configured, Places API is preferred for restaurant/food searches.

## Proactive Conversation Initiation

The system includes an intelligent feature that proactively initiates conversations based on shared interests when chats have been inactive.

### How It Works

1. **Shared Interest Analysis**: The system continuously analyzes conversations to identify shared interests (anime, shows, hobbies, topics both users like)
2. **Inactivity Detection**: Monitors chat activity and identifies when conversations have been inactive for a configured period
3. **Natural Conversation Starters**: Uses OpenAI to generate natural, friendly conversation starters based on shared interests
4. **Automatic Delivery**: Sends these messages proactively to re-engage users in conversations

### Configuration

The conversation initiator can be configured in `config.json`:

- **`conversationInitiatorIntervalMinutes`**: How often the system checks for initiation opportunities (default: 60 minutes)
- **`conversationInitiatorMinInactivityMinutes`**: Minimum minutes of inactivity before initiating (default: 120 minutes / 2 hours)
- **`conversationInitiatorMaxFrequency`**: Maximum number of initiations per day per chat (default: 1)

### Example Flow

**For Sports Interests:**
```
[System detects shared interest: "Both users like basketball"]
[Chat has been inactive for 2+ hours]
[System searches for current NBA games/events]
[System generates conversation starter with current context]
Agent: "Hey! Did you catch the Lakers vs Warriors game last night? That ending was wild! 🏀"
```

**For Other Interests:**
```
[System detects shared interest: "Both users like Attack on Titan"]
[Chat has been inactive for 2+ hours]
[System generates conversation starter with current date context]
Agent: "Hey! I was just thinking about Attack on Titan. Have you seen the latest episode? What did you think?"
```

### Features

- **Smart Timing**: Only initiates when chats are truly inactive (configurable threshold)
- **Interest-Based**: Uses actual shared interests extracted from previous conversations
- **Current Events Integration**: References live games, current events, and recent news relevant to shared interests (e.g., "Did you catch the Lakers game last night?" for basketball fans)
- **Natural Messages**: AI-generated conversation starters that feel authentic and engaging
- **Frequency Limits**: Prevents spam by limiting initiations per day
- **Duplicate Prevention**: Won't initiate about the same interest multiple times in one day

### Requirements

- Requires `OPENAI_API_KEY` to generate conversation starters
- Requires `SERIES_API_BASE_URL` and `SERIES_API_KEY` to send messages
- Requires existing key moments with shared interests (extracted from previous conversations)
- **Optional**: `GOOGLE_CUSTOM_SEARCH_API_KEY` and `GOOGLE_CUSTOM_SEARCH_ENGINE_ID` (or `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID`) for current events integration (sports games, live events, etc.). If not configured, the system will still generate starters with current date context but won't fetch live game scores/events.

## Architecture

The system consists of several microservices communicating via Kafka:

1. **Kafka Event Consumer**: Listens for `message.received` events from Series API
2. **Message Processor**: Batches messages by conversation window
3. **OpenAI Analyzer**: Analyzes conversation batches to extract key moments
4. **Storage Service**: Persists conversations and moments to JSON files
5. **Notification Service**: Tracks conversation activity and sends key moments summaries to users
6. **AI Response Service**: Generates intelligent responses with personality and context
7. **Trigger Detector**: Analyzes conversations to detect when users need recommendations
8. **Google Search Service**: Provides restaurant and place recommendations using Google APIs
9. **Conversation Initiator Service**: Proactively initiates conversations based on shared interests when chats are inactive

## Key Moment Types

- `first_contact`: When they first started talking
- `shared_interest`: Common hobbies, anime, shows, topics
- `important_date`: Birthdays, anniversaries, special events
- `milestone`: Relationship milestones, first times, inside jokes
- `preference`: Food preferences, favorite things

## Stopping

Press `Ctrl+C` to gracefully stop all services. The system will:
- Save processed message IDs to avoid re-processing
- Process any pending message batches
- Disconnect from Kafka cleanly

## Troubleshooting

### Check if monitoring is working

Run the status checker to diagnose issues:
```bash
node check-status.js
```

### No messages being processed

- Check that `KAFKA_TOPIC` matches your team's topic
- Verify phone numbers in `config.json` match the conversation participants
- Check Kafka connection credentials
- Run `node debug-consumer.js` to see all incoming Kafka messages
- Verify the monitoring process is running: `ps aux | grep "node index.js"`

### No key moments extracted

- Verify `OPENAI_API_KEY` is set correctly
- Check that `minMessagesForAnalysis` threshold is met (default: 3 messages)
- Review OpenAI API usage/quota
- Check that the batching window has elapsed (default: 15 seconds)
- Look for errors in the console output

### Duplicate messages/moments

- The system tracks processed IDs to avoid duplicates
- Check `logs/processed-ids.json` if needed

### Group chat not being monitored

- Verify all participant phone numbers are in `config.json` targetPhoneNumbers
- The system monitors if ANY target number is a participant
- Check logs for "Group chat detected" messages

### Recommendations not being sent

- Verify `GOOGLE_PLACES_API_KEY`, `GOOGLE_CUSTOM_SEARCH_API_KEY`, or `GOOGLE_SEARCH_API_KEY` is set in `.env`
- Check that the trigger detection is working (look for "🔍 Checking for triggers" in logs)
- Ensure conversation context includes planning keywords (e.g., "going out to eat", "restaurant", "dinner")
- Check cooldown period - recommendations won't be sent if one was sent in the last 5 minutes
- Verify API client is enabled (check `SERIES_API_BASE_URL` and `SERIES_API_KEY`)

### Conversation initiations not happening

- Verify `OPENAI_API_KEY` is set correctly
- Check that shared interests have been extracted (look in `logs/key-moments.json` for `type: "shared_interest"`)
- Ensure chats have been inactive for the configured minimum period (`conversationInitiatorMinInactivityMinutes`)
- Check that the maximum frequency hasn't been reached (default: 1 per day per chat)
- Verify API client is enabled (check `SERIES_API_BASE_URL` and `SERIES_API_KEY`)
- Look for "🔔 Conversation Initiator" messages in logs to see what the system is checking
