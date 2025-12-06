# MongoDB Migration Plan

## Current JSON Storage Analysis

### Files and Data Structures

#### 1. `logs/conversations.json`
**Purpose**: Store all conversation messages
**Structure**: Array of message objects
**Size**: Grows continuously (currently ~500+ messages)
**Fields**:
```javascript
{
  chatId: String,
  messageId: String (unique),
  fromPhone: String,
  text: String,
  sentAt: ISO Date String,
  chatHandles: Array[{display_name, identifier, is_me}],
  attachments: Array,
  isRead: Boolean,
  service: String (iMessage/RCS),
  eventId: String,
  eventType: String,
  createdAt: ISO Date String,
  storedAt: ISO Date String
}
```
**Operations**: Append-only, read for analysis, query by chatId
**Indexes Needed**: chatId, messageId, sentAt

#### 2. `logs/key-moments.json`
**Purpose**: Store extracted relationship moments
**Structure**: Array of moment objects
**Size**: Moderate growth
**Fields**:
```javascript
{
  type: String (first_contact|shared_interest|important_date|milestone|preference),
  description: String,
  date: String (ISO date),
  participants: Array[String] (phone numbers),
  context: String,
  confidence: Number (0.0-1.0),
  chatId: String,
  extractedAt: ISO Date String
}
```
**Operations**: Append, query by chatId, filter by type
**Indexes Needed**: chatId, type, date, extractedAt

#### 3. `logs/tasks.json`
**Purpose**: Store extracted tasks and reminders
**Structure**: Array of task objects
**Size**: Slow growth
**Fields**:
```javascript
{
  id: String (unique),
  category: String (sports|goal|common_interest|event),
  title: String,
  description: String,
  participants: Array[String],
  schedule: {
    type: String (daily|weekly|matchday|event_based|custom),
    frequency: Number,
    time: String,
    daysOfWeek: Array[String],
    matchdayPattern: String,
    eventDate: ISO Date String,
    reminderDaysBefore: Number
  },
  metadata: Object (varies by category),
  context: String,
  confidence: Number,
  chatId: String,
  extractedAt: ISO Date String,
  status: String (active|completed),
  createdAt: ISO Date String,
  lastReminderSent: ISO Date String (nullable),
  reminderCount: Number
}
```
**Operations**: Append, update (status, lastReminderSent, reminderCount), query by chatId, filter by status
**Indexes Needed**: chatId, status, category, schedule.type, lastReminderSent

#### 4. `logs/processed-ids.json`
**Purpose**: Track processed Kafka events/messages to avoid duplicates
**Structure**: Object with arrays
**Size**: Grows continuously
**Fields**:
```javascript
{
  eventIds: Array[String],
  messageIds: Array[String]
}
```
**Operations**: Append IDs, check existence, periodic cleanup
**Indexes Needed**: eventIds (unique), messageIds (unique)

#### 5. `logs/sent-moments.json`
**Purpose**: Track which key moments have been sent to users
**Structure**: Object with array
**Size**: Moderate growth
**Fields**:
```javascript
{
  sentMomentIds: Array[String]
}
```
**Operations**: Append IDs, check existence
**Indexes Needed**: sentMomentIds (unique)

#### 6. `logs/initiated-conversations.json`
**Purpose**: Track conversation initiations to prevent spam
**Structure**: Array of initiation records
**Size**: Slow growth
**Fields**:
```javascript
{
  chatId: String,
  date: String (YYYY-MM-DD),
  interestDescription: String,
  messageText: String,
  initiatedAt: ISO Date String
}
```
**Operations**: Append, query by chatId and date
**Indexes Needed**: chatId, date, initiatedAt

---

## MongoDB Schema Design

### Database: `imessage_logger`

#### Collection 1: `conversations`
```javascript
{
  _id: ObjectId,
  chatId: String (indexed),
  messageId: String (unique, indexed),
  fromPhone: String (indexed),
  text: String,
  sentAt: Date (indexed),
  chatHandles: Array,
  attachments: Array,
  isRead: Boolean,
  service: String,
  eventId: String,
  eventType: String,
  createdAt: Date,
  storedAt: Date (indexed)
}
```
**Indexes**:
- `{ chatId: 1, sentAt: 1 }` - For querying messages by chat
- `{ messageId: 1 }` - Unique index for duplicate prevention
- `{ storedAt: -1 }` - For recent messages
- `{ fromPhone: 1 }` - For filtering by sender

#### Collection 2: `keyMoments`
```javascript
{
  _id: ObjectId,
  type: String (indexed), // first_contact|shared_interest|important_date|milestone|preference
  description: String,
  date: Date (indexed),
  participants: Array[String],
  context: String,
  confidence: Number,
  chatId: String (indexed),
  extractedAt: Date (indexed)
}
```
**Indexes**:
- `{ chatId: 1, extractedAt: -1 }` - For querying by chat
- `{ type: 1, date: -1 }` - For filtering by type
- `{ chatId: 1, type: 1 }` - For chat-specific type queries

#### Collection 3: `tasks`
```javascript
{
  _id: ObjectId,
  id: String (unique, indexed), // Keep existing ID format
  category: String (indexed), // sports|goal|common_interest|event
  title: String,
  description: String,
  participants: Array[String],
  schedule: {
    type: String (indexed),
    frequency: Number,
    time: String,
    daysOfWeek: Array[String],
    matchdayPattern: String,
    eventDate: Date,
    reminderDaysBefore: Number
  },
  metadata: Object,
  context: String,
  confidence: Number,
  chatId: String (indexed),
  extractedAt: Date,
  status: String (indexed), // active|completed
  createdAt: Date,
  lastReminderSent: Date (indexed, nullable),
  reminderCount: Number
}
```
**Indexes**:
- `{ chatId: 1, status: 1 }` - For active tasks by chat
- `{ status: 1, "schedule.type": 1 }` - For scheduler queries
- `{ lastReminderSent: 1 }` - For reminder tracking
- `{ id: 1 }` - Unique index
- `{ "schedule.eventDate": 1 }` - For event-based tasks

#### Collection 4: `processedIds`
```javascript
{
  _id: ObjectId,
  eventId: String (unique, indexed),
  messageId: String (unique, indexed),
  processedAt: Date (indexed)
}
```
**Indexes**:
- `{ eventId: 1 }` - Unique index
- `{ messageId: 1 }` - Unique index
- `{ processedAt: -1 }` - For cleanup queries

**Note**: Can use separate collections or single collection with type field

#### Collection 5: `sentMoments`
```javascript
{
  _id: ObjectId,
  momentId: String (unique, indexed), // Composite: chatId-type-date-description
  chatId: String (indexed),
  sentAt: Date (indexed)
}
```
**Indexes**:
- `{ momentId: 1 }` - Unique index
- `{ chatId: 1, sentAt: -1 }` - For chat queries

#### Collection 6: `conversationInitiations`
```javascript
{
  _id: ObjectId,
  chatId: String (indexed),
  date: String (indexed), // YYYY-MM-DD format
  interestDescription: String,
  messageText: String,
  initiatedAt: Date (indexed)
}
```
**Indexes**:
- `{ chatId: 1, date: 1 }` - For checking daily frequency
- `{ initiatedAt: -1 }` - For recent initiations

---

## Migration Strategy

### Phase 1: Setup MongoDB Infrastructure
1. Install MongoDB driver: `npm install mongodb`
2. Create database connection service
3. Create schema/collection initialization script
4. Add MongoDB connection string to `.env`

### Phase 2: Create Database Service Layer
1. Create `database-service.js` to replace `storage-service.js`
2. Implement CRUD operations for each collection
3. Maintain backward compatibility during transition
4. Add connection pooling and error handling

### Phase 3: Migrate Existing Data
1. Create migration script to read JSON files
2. Import all existing data to MongoDB
3. Verify data integrity
4. Keep JSON files as backup

### Phase 4: Update Services
1. Update `StorageService` to use MongoDB
2. Update `TaskSchedulerService` to use MongoDB
3. Update `NotificationService` to use MongoDB
4. Update `ConversationInitiatorService` to use MongoDB
5. Update `KafkaEventConsumer` to use MongoDB

### Phase 5: Testing & Validation
1. Test all CRUD operations
2. Verify no data loss
3. Performance testing
4. Rollback plan if needed

### Phase 6: Cleanup
1. Remove JSON file dependencies
2. Archive old JSON files
3. Update documentation

---

## Implementation Details

### Environment Variables
```env
# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/imessage_logger
# OR for MongoDB Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/imessage_logger
MONGODB_DB_NAME=imessage_logger
```

### Database Service Structure
```javascript
// database-service.js
class DatabaseService {
  // Conversations
  async storeConversation(message)
  async getConversationsByChat(chatId, limit, offset)
  async getRecentConversations(limit)
  
  // Key Moments
  async storeKeyMoment(moment)
  async getKeyMomentsByChat(chatId)
  async getKeyMomentsByType(type)
  
  // Tasks
  async storeTask(task)
  async updateTask(taskId, updates)
  async getTasksByChat(chatId, status)
  async getActiveTasks()
  async getTasksForScheduler()
  
  // Processed IDs
  async isEventProcessed(eventId)
  async isMessageProcessed(messageId)
  async markEventProcessed(eventId)
  async markMessageProcessed(messageId)
  async cleanupOldProcessedIds(daysOld)
  
  // Sent Moments
  async isMomentSent(momentId)
  async markMomentSent(momentId, chatId)
  
  // Conversation Initiations
  async getInitiationsByChatAndDate(chatId, date)
  async recordInitiation(initiation)
}
```

### Benefits of MongoDB Migration

1. **Scalability**: Handle millions of messages without file size issues
2. **Performance**: Indexed queries are much faster than JSON file parsing
3. **Concurrency**: Multiple processes can read/write safely
4. **Querying**: Complex queries (filtering, sorting, aggregation)
5. **Data Integrity**: Transactions, validation, constraints
6. **Backup**: Built-in replication and backup tools
7. **Analytics**: Aggregation pipeline for insights
8. **Production Ready**: Better suited for production deployments

### Migration Script Example
```javascript
// migrate-to-mongodb.js
const fs = require('fs-extra');
const { MongoClient } = require('mongodb');
const path = require('path');

async function migrate() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  
  // Migrate conversations
  const conversations = await fs.readJson('logs/conversations.json');
  await db.collection('conversations').insertMany(conversations);
  
  // Migrate key moments
  const keyMoments = await fs.readJson('logs/key-moments.json');
  await db.collection('keyMoments').insertMany(keyMoments);
  
  // Migrate tasks
  const tasks = await fs.readJson('logs/tasks.json');
  await db.collection('tasks').insertMany(tasks);
  
  // ... migrate other collections
  
  await client.close();
}
```

---

## Estimated Timeline

- **Phase 1**: 2-3 hours (Setup & Infrastructure)
- **Phase 2**: 4-6 hours (Database Service Layer)
- **Phase 3**: 1-2 hours (Data Migration)
- **Phase 4**: 6-8 hours (Update All Services)
- **Phase 5**: 2-3 hours (Testing)
- **Phase 6**: 1 hour (Cleanup)

**Total**: ~16-23 hours of development time

---

## Rollback Plan

1. Keep JSON file operations as fallback
2. Dual-write mode during transition (write to both JSON and MongoDB)
3. Feature flag to switch between JSON and MongoDB
4. Keep JSON files as backup for 30 days after migration

---

## Next Steps

1. Review and approve this plan
2. Set up MongoDB instance (local or Atlas)
3. Start with Phase 1 (Infrastructure setup)
4. Implement incrementally, testing each phase
5. Deploy with feature flag for gradual rollout

