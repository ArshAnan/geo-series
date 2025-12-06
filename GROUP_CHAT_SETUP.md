# Group Chat Monitoring Setup

## Configuration

The system is now configured to monitor group chats using the hackathon sender phone number.

### Sender Phone Number (Hackathon Kafka)
- **+16463458837** - This is the phone number provided by hackathon organizers for Kafka

### Target Phone Numbers
The system monitors conversations (individual or group chats) that include ANY of these numbers:
1. **+16463458837** (Sender - Hackathon Kafka)
2. **+19294265300**
3. **+12014927092**

## How Group Chat Monitoring Works

1. **Message Filtering**: The system processes messages from Kafka if ANY of the target phone numbers are participants in the chat (individual or group).

2. **Group Chat Detection**: When a group chat is detected (more than 2 participants), the system logs:
   - Number of participants
   - All participant phone numbers
   - Which target numbers matched

3. **Key Moment Extraction**: The system analyzes conversations in batches (every 15 seconds) and extracts:
   - First contact moments
   - Shared interests
   - Important dates
   - Relationship milestones
   - Personal preferences

## Usage

### Start Monitoring
```bash
node index.js
```

### View Analysis
```bash
node view-analysis.js
```

### Debug Messages
```bash
node debug-consumer.js
```

## Output Files

- `logs/conversations.json` - All messages from monitored chats
- `logs/key-moments.json` - Extracted key moments and analysis
- `logs/processed-ids.json` - Tracks processed messages to avoid duplicates

## Notes

- The system starts monitoring from the latest messages (won't capture historical messages before startup)
- To capture historical messages, change `fromBeginning: false` to `fromBeginning: true` in `kafka-event-consumer.js`
- Group chats are automatically detected and monitored if they contain any target phone number
