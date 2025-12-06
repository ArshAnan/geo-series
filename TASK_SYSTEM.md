# Task Management System

## Overview

The Task Management System automatically analyzes conversations to extract tasks, goals, and scheduled events, then sends intelligent reminders based on the extracted information.

## Features

### 1. **Automatic Task Extraction**
- Analyzes conversations in real-time using GPT-4o
- Extracts tasks from four categories:
  - **Sports**: Team preferences, match schedules, game reminders
  - **Goals**: Shared goals, fitness goals, personal development
  - **Common Interests**: Activities they want to do together
  - **Events**: Upcoming events, deadlines, important dates

### 2. **Smart Scheduling**
- **Daily Tasks**: Reminders at specific times (e.g., "Daily weight loss check-in at 9 AM")
- **Weekly Tasks**: Reminders on specific days (e.g., "Progress check every Monday, Wednesday, Friday")
- **Matchday Tasks**: Sports reminders (e.g., "FC Barcelona matchday reminder")
- **Event-Based Tasks**: Reminders before important dates (e.g., "Remind 3 days before concert")

### 3. **Intelligent Reminders**
- Context-aware reminder messages
- Personalized based on task category
- Tracks reminder history to avoid duplicates

## How It Works

### Task Extraction Flow

1. **Conversation Analysis**: When messages are processed, the system:
   - Analyzes conversation batches with OpenAI
   - Uses existing key moments for context
   - Extracts tasks, goals, and scheduled events

2. **Task Storage**: Extracted tasks are stored in `logs/tasks.json` with:
   - Category and title
   - Schedule configuration
   - Participants
   - Metadata (team names, goal types, etc.)

3. **Reminder Scheduling**: The scheduler service:
   - Checks tasks every minute (configurable)
   - Determines if a reminder should be sent
   - Sends personalized reminder messages

### Example Use Cases

#### Sports Reminders
**Conversation**: "We're both FC Barcelona fans!"
**Extracted Task**:
```json
{
  "category": "sports",
  "title": "FC Barcelona Matchday Reminder",
  "schedule": {
    "type": "matchday",
    "matchdayPattern": "before_match",
    "time": "10:00"
  },
  "metadata": {
    "teamName": "FC Barcelona",
    "sportType": "soccer"
  }
}
```
**Reminder**: "⚽ FC Barcelona might have a match today! Want to watch together? 🎉"

#### Goal Tracking
**Conversation**: "We both want to lose weight"
**Extracted Task**:
```json
{
  "category": "goal",
  "title": "Daily Weight Loss Check-in",
  "schedule": {
    "type": "daily",
    "time": "09:00"
  },
  "metadata": {
    "goalType": "weight_loss"
  }
}
```
**Reminder**: "💪 Daily check-in! How's your progress today? Remember your goal: lose weight together"

#### Common Interest Reminders
**Conversation**: "Let's watch the new movie together when it comes out"
**Extracted Task**:
```json
{
  "category": "common_interest",
  "title": "Movie Watch Reminder",
  "schedule": {
    "type": "event_based",
    "eventDate": "2025-12-20",
    "reminderDaysBefore": 1
  }
}
```

## Configuration

Add to `config.json`:

```json
{
  "taskSchedulerCheckIntervalSeconds": 60,
  "taskReminderTimeWindowMinutes": 5
}
```

- `taskSchedulerCheckIntervalSeconds`: How often to check for reminders (default: 60 seconds)
- `taskReminderTimeWindowMinutes`: Time window for scheduled reminders (default: 5 minutes)

## Task Storage

Tasks are stored in `logs/tasks.json`:

```json
[
  {
    "id": "1702657-sports-fc-barcelona-matchday-1234567890",
    "category": "sports",
    "title": "FC Barcelona Matchday Reminder",
    "description": "Send reminder before FC Barcelona matches",
    "participants": ["+16463458837", "+19294265300"],
    "schedule": {
      "type": "matchday",
      "matchdayPattern": "before_match",
      "time": "10:00"
    },
    "metadata": {
      "teamName": "FC Barcelona",
      "sportType": "soccer"
    },
    "status": "active",
    "chatId": "1702657",
    "lastReminderSent": "2025-12-06T10:00:00.000Z",
    "reminderCount": 5,
    "confidence": 0.8,
    "extractedAt": "2025-12-06T07:00:00.000Z"
  }
]
```

## Architecture

**Services:**
1. **Task Analyzer Service**: Extracts tasks from conversations
2. **Task Scheduler Service**: Manages scheduled reminders and sends them

**Integration:**
- Tasks are extracted when conversation batches are analyzed
- Uses key moments for context
- Reminders are sent via Series API (same as other messages)

## Future Enhancements

- Integration with sports APIs for accurate matchday detection
- More sophisticated goal tracking (progress logging, milestones)
- Task completion tracking
- User preferences for reminder frequency
- Task management UI/commands
