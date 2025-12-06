# Task Management System - Summary & Testing Guide

## Summary of Changes

### New Features Added

1. **Task Analyzer Service** (`task-analyzer-service.js`)
   - Analyzes conversations to extract tasks, goals, and scheduled events
   - Categorizes into: Sports, Goals, Common Interests, Events
   - Uses GPT-4o with context from key moments
   - Stores tasks in `logs/tasks.json`

2. **Task Scheduler Service** (`task-scheduler-service.js`)
   - Manages scheduled reminders for extracted tasks
   - Checks tasks every minute (configurable)
   - Sends personalized reminder messages
   - **Smart matchday detection**: Uses Google Search to find actual match schedules
   - **Daily optimization**: Matchday tasks checked once per day to reduce API calls

3. **Integration**
   - Integrated into main system (`index.js`)
   - Automatically analyzes conversations alongside key moments
   - Tasks are created when detected in conversations
   - Reminders sent based on schedule

### Files Created/Modified

**New Files:**
- `task-analyzer-service.js` - Extracts tasks from conversations
- `task-scheduler-service.js` - Manages and sends reminders
- `TASK_SYSTEM.md` - Documentation
- `TASK_SYSTEM_SUMMARY.md` - This file

**Modified Files:**
- `index.js` - Added task analyzer and scheduler services
- `storage-service.js` - Added `loadKeyMoments()` method for task context
- `config.json` - Added task scheduling configuration

**Storage:**
- `logs/tasks.json` - Stores all extracted tasks (auto-created)

## How It Works

### Task Extraction Flow

1. **Message Received** → Kafka Event Consumer
2. **Message Batched** → Message Processor
3. **Analyzed for Key Moments** → OpenAI Analyzer
4. **Analyzed for Tasks** → Task Analyzer (uses key moments for context)
5. **Task Stored** → `logs/tasks.json`
6. **Reminder Scheduled** → Task Scheduler

### Reminder Flow

1. **Task Scheduler** checks tasks every minute
2. **Matchday Tasks**: Checked once per day (uses Google Search)
3. **Other Tasks**: Checked every minute for precise timing
4. **Reminder Sent** if conditions are met
5. **Task Updated** with reminder history

## Task Categories & Examples

### 1. Sports Tasks
**Trigger**: "We're both FC Barcelona fans!"
**Task Created**: Matchday reminder
**Schedule**: Checks Google Search daily for actual matches
**Reminder**: 
```
⚽ FC Barcelona has a match today!
🆚 vs Real Madrid
⏰ 3:00 PM
📍 Camp Nou

Want to watch together? 🎉
```

### 2. Goal Tasks
**Trigger**: "We both want to lose weight"
**Task Created**: Daily weight loss check-in
**Schedule**: Daily at 9:00 AM
**Reminder**: "💪 Daily check-in! How's your progress today? Remember your goal: lose weight together"

### 3. Common Interest Tasks
**Trigger**: "Let's watch that movie together"
**Task Created**: Movie reminder
**Schedule**: Event-based (1 day before release)
**Reminder**: "🎯 Reminder: Movie Watch Reminder\nLet's watch the new movie together"

### 4. Event Tasks
**Trigger**: "We have a concert next month"
**Task Created**: Concert reminder
**Schedule**: Event-based (3 days before)
**Reminder**: "📅 Reminder: Concert is coming up!"

## Testing Guide

### Prerequisites

1. **Environment Variables** (in `.env`):
   ```env
   OPENAI_API_KEY=your-key
   SERIES_API_BASE_URL=your-api-url
   SERIES_API_KEY=your-api-key
   GOOGLE_SEARCH_API_KEY=your-google-key (optional but recommended for matchday)
   GOOGLE_SEARCH_ENGINE_ID=your-engine-id (optional but recommended)
   ```

2. **Configuration** (in `config.json`):
   ```json
   {
     "taskSchedulerCheckIntervalSeconds": 60,
     "taskReminderTimeWindowMinutes": 5
   }
   ```

### Test 1: Task Extraction

**Steps:**
1. Start the system: `node index.js`
2. Send a message in the monitored chat: "We're both FC Barcelona fans!"
3. Wait for batch processing (default: 0.25 minutes)
4. Check `logs/tasks.json` for extracted task

**Expected Result:**
```json
[
  {
    "category": "sports",
    "title": "FC Barcelona Matchday Reminder",
    "schedule": {
      "type": "matchday",
      "matchdayPattern": "before_match"
    },
    "metadata": {
      "teamName": "FC Barcelona",
      "sportType": "soccer"
    },
    "status": "active"
  }
]
```

**Verification:**
- Check console logs for: `✅ Extracted X task(s) for chat [chatId]`
- Verify task appears in `logs/tasks.json`

### Test 2: Goal Task Extraction

**Steps:**
1. Send message: "We both want to lose weight together"
2. Wait for processing
3. Check `logs/tasks.json`

**Expected Result:**
Task with:
- `category`: "goal"
- `title`: Contains "weight" or "fitness"
- `schedule.type`: "daily"
- `schedule.time`: Set (e.g., "09:00")

### Test 3: Matchday Reminder (with Google Search)

**Steps:**
1. Ensure a matchday task exists in `logs/tasks.json`
2. Wait for the daily check (runs once per day, or restart system)
3. If Google Search is enabled, it will search for matches
4. If match found, reminder will be sent

**Expected Console Output:**
```
⏰ Task Scheduler: Checking X active task(s)...
   Matchday tasks: 1, Other tasks: 0
   🔍 Checking matchday tasks (daily check)...
   🔍 Searching for matches: "FC Barcelona match today [date] schedule"
   ✅ Match found for FC Barcelona today!
   📤 Sending reminder for task: FC Barcelona Matchday Reminder
   ✅ Reminder sent successfully!
```

**Verification:**
- Check console for Google search query
- Verify reminder message sent to chat
- Check task in `logs/tasks.json` - `lastReminderSent` should be updated

### Test 4: Daily Goal Reminder

**Steps:**
1. Create a goal task (or extract from conversation)
2. Set `schedule.time` to current time + 1 minute (for testing)
3. Wait for scheduler check (runs every minute)
4. Reminder should be sent

**Expected Result:**
- Reminder sent at scheduled time
- Task updated with `lastReminderSent` timestamp
- `reminderCount` incremented

### Test 5: Weekly Reminder

**Steps:**
1. Extract or manually create a weekly task
2. Set `schedule.daysOfWeek` to include today
3. Wait for scheduler check
4. Reminder should be sent

**Expected Result:**
- Reminder sent on specified day
- Only sent once per day

### Test 6: Event-Based Reminder

**Steps:**
1. Create task with `schedule.type`: "event_based"
2. Set `schedule.eventDate` to tomorrow
3. Set `schedule.reminderDaysBefore`: 1
4. Wait for scheduler check tomorrow
5. Reminder should be sent

**Expected Result:**
- Reminder sent 1 day before event
- Only sent once

## Manual Testing (Quick Tests)

### Quick Test 1: Check Task Extraction
```bash
# Send a test message in the chat, then check:
cat logs/tasks.json
```

### Quick Test 2: View All Tasks
```bash
# Check what tasks are stored:
node -e "const tasks = require('./logs/tasks.json'); console.log(JSON.stringify(tasks, null, 2));"
```

### Quick Test 3: Force Task Check
You can manually trigger a task check by modifying the scheduler to run immediately, or wait for the next check cycle.

### Quick Test 4: Test Matchday Search
```bash
# Check if Google Search is working:
node -e "
const GoogleSearchService = require('./google-search-service');
const service = new GoogleSearchService();
service.searchPlaces('FC Barcelona match today schedule').then(r => console.log(r));
"
```

## Troubleshooting

### No Tasks Extracted

**Check:**
1. Are conversations being processed? Check `logs/conversations.json`
2. Are key moments being extracted? Check `logs/key-moments.json`
3. Check console for errors in task analyzer
4. Verify OpenAI API key is set

### Reminders Not Sending

**Check:**
1. Is API client enabled? Check `SERIES_API_BASE_URL` and `SERIES_API_KEY`
2. Check task status in `logs/tasks.json` - should be "active"
3. Check `lastReminderSent` - won't send duplicate on same day
4. Verify schedule configuration is correct

### Matchday Reminders Not Working

**Check:**
1. Is Google Search enabled? Check `GOOGLE_SEARCH_API_KEY`
2. Check console for search queries
3. Verify team name in task metadata is correct
4. Check if fallback weekend detection is working

### Tasks Created But Wrong Schedule

**Check:**
1. Review the task extraction prompt in `task-analyzer-service.js`
2. Check extracted task in `logs/tasks.json`
3. May need to adjust confidence threshold or prompt

## Configuration Options

### In `config.json`:

```json
{
  "taskSchedulerCheckIntervalSeconds": 60,  // How often to check (seconds)
  "taskReminderTimeWindowMinutes": 5        // Time window for scheduled reminders
}
```

### Environment Variables:

- `OPENAI_API_KEY` - Required for task extraction
- `SERIES_API_BASE_URL` - Required for sending reminders
- `SERIES_API_KEY` - Required for sending reminders
- `GOOGLE_SEARCH_API_KEY` - Optional, recommended for matchday detection
- `GOOGLE_SEARCH_ENGINE_ID` - Optional, recommended for matchday detection

## Expected Behavior

### Task Extraction
- Happens automatically when conversations are analyzed
- Uses GPT-4o for intelligent extraction
- Low confidence threshold (0.2+) for hackathon demo
- Tasks stored immediately after extraction

### Reminder Sending
- **Matchday tasks**: Checked once per day (first check of the day)
- **Daily tasks**: Checked every minute, sent at scheduled time
- **Weekly tasks**: Checked every minute, sent on specified days
- **Event tasks**: Checked every minute, sent on reminder date
- No duplicate reminders on same day

### Google Search Integration
- Only used for matchday tasks
- Searches once per day per task
- Falls back to weekend detection if search fails
- Extracts match details (opponent, time, venue) when available

## Next Steps for Production

1. **Sports API Integration**: Replace Google Search with dedicated sports API (more accurate)
2. **Progress Tracking**: Add ability to log progress for goal tasks
3. **Task Management**: Add commands to view/complete/delete tasks
4. **User Preferences**: Allow users to customize reminder frequency
5. **Better Match Detection**: Use sports calendar APIs for accurate schedules
