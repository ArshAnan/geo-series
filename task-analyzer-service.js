// Task Analyzer Service - Analyzes conversations to extract tasks, goals, and scheduled events
require('dotenv').config();
const OpenAI = require('openai');
const SeriesAPIClient = require('./api-client');
const config = require('./config.json');
const fs = require('fs-extra');
const path = require('path');

class TaskAnalyzerService {
  constructor(targetChatId = null) {
    if (!process.env.OPENAI_API_MY_KEY) {
      throw new Error('OPENAI_API_MY_KEY must be set in .env');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_MY_KEY
    });

    this.model = config.openaiModel || 'gpt-4o';
    this.apiClient = new SeriesAPIClient();
    this.targetChatId = targetChatId || config.chatId; // Only analyze target chat ID
    this.tasksFile = path.join(__dirname, 'logs', 'tasks.json');
    this.onTaskExtractedCallback = null;
    this.aiResponseService = null; // Will be set from index.js to send notifications
    
    // Initialize tasks file
    this.initializeFiles();
  }

  async initializeFiles() {
    try {
      await fs.ensureDir(path.dirname(this.tasksFile));
      if (!(await fs.pathExists(this.tasksFile))) {
        await fs.writeJson(this.tasksFile, [], { spaces: 2 });
      }
    } catch (error) {
      console.error('Error initializing task files:', error);
    }
  }

  setCallback(onTaskExtracted) {
    this.onTaskExtractedCallback = onTaskExtracted;
  }

  /**
   * Create prompt for OpenAI to extract tasks and goals
   */
  createTaskAnalysisPrompt(conversationBatch, keyMoments = []) {
    const messages = conversationBatch.messages.map(msg => {
      const timestamp = new Date(msg.sentAt).toLocaleString();
      return `[${timestamp}] ${msg.fromPhone}: ${msg.text}`;
    }).join('\n');

    // Include relevant key moments for context
    const relevantMoments = keyMoments
      .filter(m => m.chatId === conversationBatch.chatId && 
                   (m.type === 'shared_interest' || m.type === 'milestone' || m.type === 'important_date'))
      .map(m => `- ${m.type}: ${m.description}`)
      .join('\n');

    return `Analyze the following conversation and identify tasks, goals, and scheduled events that should be tracked with reminders.

IMPORTANT: Be PROACTIVE and LENIENT - create tasks even from single mentions, questions, or casual discussions. It's better to create a task than miss one.

Conversation:
${messages}

${relevantMoments ? `\nRelevant Context from Previous Analysis:\n${relevantMoments}` : ''}

Please identify and extract the following types of tasks/goals (be generous - even a single mention counts):

1. **Sports Tasks** - ANY mention of teams, sports, matches, games
   - Examples: 
     * "Are you interested in FC Barcelona match?" → Create matchday reminder task
     * "Both are FC Barcelona fans" → Create matchday reminder task
     * "They like watching NBA games" → Create game reminder task
     * "I'm a Lakers fan" → Create matchday reminder task
   - Extract: team name, sport type, preference for matchday reminders
   - Even if it's just a question or single mention, create a task!

2. **Goal Tasks** - ANY mention of shared goals, fitness, personal development
   - Examples:
     * "Both want to lose weight" → Create daily/weekly progress tracking reminder
     * "We should exercise more" → Create fitness reminder task
     * "They want to learn Spanish together" → Create study reminder task
   - Extract: goal description, frequency (daily/weekly), tracking method

3. **Common Interest Tasks** - ANY mention of activities they want to do together
   - Examples:
     * "They want to watch a movie together" → Create reminder for movie release
     * "We should go hiking" → Create weather/planning reminder
     * "Let's watch that show" → Create reminder task
   - Extract: activity, relevant dates, reminder type

4. **Event Tasks** - ANY mention of upcoming events, deadlines, important dates
   - Examples:
     * "They have a project deadline" → Create deadline reminder
     * "Concert next month" → Create reminder before event
     * "We have a meeting tomorrow" → Create reminder task
   - Extract: event name, date, reminder schedule

CRITICAL: If you see ANY mention of sports teams, goals, activities, or events - CREATE A TASK. Even if it's just a question or casual mention. Be generous with confidence scores (0.3+ is acceptable).

Return your analysis as a JSON array of task objects. Each task should have:
- category: one of "sports", "goal", "common_interest", "event"
- title: Short, clear task title (e.g., "FC Barcelona Matchday Reminder", "Daily Weight Loss Check-in")
- description: Detailed description of the task/goal
- participants: Array of phone numbers involved
- schedule: Object with:
  - type: "daily", "weekly", "matchday", "event_based", "custom"
  - frequency: For daily/weekly, specify the frequency
  - time: Optional time of day (e.g., "09:00" for morning reminders)
  - daysOfWeek: For weekly, array of days (e.g., ["monday", "wednesday", "friday"])
  - matchdayPattern: For sports, pattern like "before_match", "matchday_morning", "matchday_evening"
  - eventDate: For event-based, the event date
  - reminderDaysBefore: For events, how many days before to remind
- metadata: Object with additional context:
  - teamName: For sports tasks
  - sportType: For sports tasks
  - goalType: For goal tasks
  - activityType: For common interest tasks
  - eventName: For event tasks
- context: Relevant conversation context or quote
- confidence: Your confidence level (0.0 to 1.0) - can be as low as 0.3
- chatId: The chat ID where this was discussed

Return ONLY valid JSON, no other text. Format:
[
  {
    "category": "sports",
    "title": "FC Barcelona Matchday Reminder",
    "description": "Send reminder before FC Barcelona matches",
    "participants": ["+1234567890", "+0987654321"],
    "schedule": {
      "type": "matchday",
      "matchdayPattern": "before_match",
      "time": "10:00"
    },
    "metadata": {
      "teamName": "FC Barcelona",
      "sportType": "soccer"
    },
    "context": "Both mentioned being FC Barcelona fans",
    "confidence": 0.8,
    "chatId": "12345"
  }
]`;
  }

  /**
   * Analyze conversation batch to extract tasks
   */
  async analyzeConversationForTasks(conversationBatch, keyMoments = []) {
    try {
      const prompt = this.createTaskAnalysisPrompt(conversationBatch, keyMoments);
      
      const requestParams = {
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert at analyzing conversations to extract tasks, goals, and scheduled events. Be PROACTIVE and LENIENT - create tasks from any mention of sports teams, goals, activities, or events, even if it\'s just a question or casual mention. Always respond with a valid JSON array of task objects, even if empty. If no tasks are found, return an empty array [].'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.5
      };

      // Note: We need an array, not json_object, so we'll parse manually
      // Don't use json_object mode as it expects an object, not an array

      const response = await this.openai.chat.completions.create(requestParams);
      const content = response.choices[0].message.content.trim();
      
      console.log(`   📝 Raw AI response (first 500 chars): ${content.substring(0, 500)}`);
      
      // Parse JSON response
      let tasks;
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          tasks = parsed;
        } else if (parsed.tasks && Array.isArray(parsed.tasks)) {
          tasks = parsed.tasks;
        } else if (parsed.data && Array.isArray(parsed.data)) {
          tasks = parsed.data;
        } else if (typeof parsed === 'object') {
          // If using json_object mode, look for tasks array in the object
          tasks = Object.values(parsed).find(v => Array.isArray(v)) || [];
        } else {
          tasks = [];
        }
      } catch (parseError) {
        // Try to extract JSON array from text
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            tasks = JSON.parse(jsonMatch[0]);
          } catch (e) {
            console.warn('Could not parse extracted JSON:', e);
            tasks = [];
          }
        } else {
          console.warn('Could not parse task analysis response as JSON:', content);
          return [];
        }
      }

      console.log(`   📊 Parsed ${tasks.length} task(s) from AI response`);
      
      // Validate and enrich tasks (lower confidence threshold to 0.2)
      const validatedTasks = tasks
        .filter(t => {
          if (!t || !t.category || !t.title) {
            console.log(`   ⚠️  Skipping invalid task: missing category or title`, t);
            return false;
          }
          if (t.confidence !== undefined && t.confidence < 0.2) {
            console.log(`   ⚠️  Skipping task "${t.title}" - confidence too low: ${t.confidence}`);
            return false;
          }
          console.log(`   ✅ Valid task: ${t.title} (${t.category}, confidence: ${t.confidence || 'N/A'})`);
          return true;
        })
        .map(task => ({
          ...task,
          id: this.generateTaskId(task),
          chatId: conversationBatch.chatId,
          extractedAt: new Date().toISOString(),
          status: 'active',
          createdAt: new Date().toISOString(),
          lastReminderSent: null,
          reminderCount: 0,
          confidence: task.confidence !== undefined ? task.confidence : 0.3
        }));

      return validatedTasks;
    } catch (error) {
      console.error('Error analyzing conversation for tasks:', error);
      return [];
    }
  }

  /**
   * Generate unique task ID
   */
  generateTaskId(task) {
    const base = `${task.chatId}-${task.category}-${task.title}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const timestamp = Date.now();
    return `${base}-${timestamp}`;
  }

  /**
   * Check if model supports JSON response format
   */
  supportsJsonMode(model) {
    const jsonModeModels = [
      'gpt-4-turbo',
      'gpt-4-turbo-preview',
      'gpt-4-0125-preview',
      'gpt-4-1106-preview',
      'gpt-3.5-turbo-1106',
      'gpt-4o',
      'gpt-4o-mini'
    ];
    
    const modelLower = model.toLowerCase();
    return jsonModeModels.some(supported => {
      const supportedLower = supported.toLowerCase();
      return modelLower === supportedLower || modelLower.includes(supportedLower);
    });
  }

  /**
   * Process a conversation batch to extract tasks
   * Fetches all unprocessed messages from API for better context
   */
  async processBatch(conversationBatch, keyMoments = []) {
    try {
      console.log(`🔍 Analyzing conversation batch for tasks (chat ${conversationBatch.chatId})...`);
      console.log(`   Messages in batch: ${conversationBatch.messages.length}`);
      console.log(`   Key moments available: ${keyMoments.length}`);

      // Only use messages from the current batch (no past history)
      // Task analysis should only happen on current conversations, not historical data
      console.log(`   📋 Using only current batch messages for task analysis (${conversationBatch.messages.length} messages)`);
      
      const tasks = await this.analyzeConversationForTasks(conversationBatch, keyMoments);

      if (tasks.length === 0) {
        console.log(`   ⚠️  No tasks extracted for chat ${conversationBatch.chatId}`);
        console.log(`   This might mean:`);
        console.log(`   - The conversation doesn't contain task-worthy content`);
        console.log(`   - The AI model didn't recognize task opportunities`);
        console.log(`   - Check the conversation content to see if tasks should have been created`);
        return;
      }

      // Send tasks via callback
      const createdTasks = [];
      for (const task of tasks) {
        if (this.onTaskExtractedCallback) {
          await this.onTaskExtractedCallback(task);
          createdTasks.push(task);
        }
      }

      console.log(`✅ Extracted ${tasks.length} task(s) for chat ${conversationBatch.chatId}`);

      // Send notification to user about the tasks that were created
      if (createdTasks.length > 0 && this.aiResponseService) {
        try {
          // Get the most recent message from the batch to use for notification context
          const latestMessage = conversationBatch.messages.length > 0 
            ? conversationBatch.messages[conversationBatch.messages.length - 1]
            : null;
          
          if (latestMessage) {
            // Ensure message has required fields for notification
            const notificationMessage = {
              chatId: latestMessage.chatId || conversationBatch.chatId,
              messageId: latestMessage.messageId || `task-notification-${Date.now()}`,
              fromPhone: latestMessage.fromPhone,
              text: latestMessage.text || '',
              sentAt: latestMessage.sentAt || new Date().toISOString(),
              chatHandles: latestMessage.chatHandles || [],
              attachments: latestMessage.attachments || [],
              isRead: latestMessage.isRead || false,
              service: latestMessage.service || 'iMessage'
            };
            
            console.log(`📤 Sending task notification for ${createdTasks.length} task(s)...`);
            console.log(`   Chat ID: ${notificationMessage.chatId}`);
            await this.aiResponseService.sendTaskNotification(notificationMessage, createdTasks);
          } else {
            console.warn(`⚠️  No message found in batch to use for task notification`);
          }
        } catch (error) {
          console.error('❌ Error sending task notification:', error);
          console.error('   Error details:', error.message);
          console.error('   Tasks were still created and stored, but notification failed');
        }
      } else if (createdTasks.length > 0 && !this.aiResponseService) {
        console.warn(`⚠️  AI response service not set - cannot send task notification`);
        console.warn(`   Tasks were created but user won't be notified`);
      }
    } catch (error) {
      console.error('Error processing batch for tasks:', error);
    }
  }

  async start() {
    console.log(`Task Analyzer Service started. Using model: ${this.model}`);
  }

  async stop() {
    console.log('Task Analyzer Service stopped');
  }
}

module.exports = TaskAnalyzerService;
