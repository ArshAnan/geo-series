# MongoDB Setup - Quick Guide

## Environment Variables

Add to your `.env` file:

```env
# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB_NAME=imessage_logger
```

**For MongoDB Atlas (cloud):**
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/imessage_logger
MONGODB_DB_NAME=imessage_logger
```

## Local MongoDB Setup

### Option 1: Install MongoDB Locally
1. Download from https://www.mongodb.com/try/download/community
2. Install and start MongoDB service
3. Default connection: `mongodb://localhost:27017`

### Option 2: Use Docker
```bash
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

### Option 3: Use MongoDB Atlas (Free Cloud)
1. Go to https://www.mongodb.com/cloud/atlas
2. Create free cluster
3. Get connection string
4. Add to `.env` as `MONGODB_URI`

## What Changed

All new data is now stored in MongoDB instead of JSON files:

- ✅ **Conversations** → `conversations` collection
- ✅ **Key Moments** → `keyMoments` collection  
- ✅ **Tasks** → `tasks` collection
- ✅ **Processed IDs** → `processedIds` collection
- ✅ **Sent Moments** → `sentMoments` collection
- ✅ **Conversation Initiations** → `conversationInitiations` collection

**Old JSON files are kept for reference but are no longer written to.**

## Testing

1. Start MongoDB (if local)
2. Set `MONGODB_URI` in `.env`
3. Run: `node index.js`
4. Check MongoDB to see new data being stored

## Viewing Data

You can use MongoDB Compass (GUI) or mongosh (CLI) to view data:

```bash
# Using mongosh
mongosh
use imessage_logger
db.conversations.find().limit(5)
db.tasks.find()
db.keyMoments.find()
```

