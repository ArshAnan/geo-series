// Task Analyzer Service - Analyzes conversations to extract tasks, goals, and scheduled events
require('dotenv').config();
const OpenAI = require('openai');
const config = require('./config.json');
const fs = require('fs-extra');
const path = require('path');

class TaskAnalyzerService {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY must be set in .env');
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.model = config.openaiModel || 'gpt-4o';
    this.tasksFile = path.join(__dirname, 'logs', 'tasks.json');
    this.onTaskExtractedCallback = null;
    
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

Conversation:
${messages}

${relevantMoments ? `\nRelevant Context from Previous Analysis:\n${relevantMoments}` : ''}

Please identify and extract the following types of tasks/goals:

1. **Sports Tasks** - Team preferences, match schedules, game reminders
   - Example: "Both are FC Barcelona fans" → Create matchday reminder task
   - Example: "They like watching NBA games" → Create game reminder task
   - Extract: team name, sport type, preference for matchday reminders

2. **Goal Tasks** - Shared goals, fitness goals, personal development
   - Example: "Both want to lose weight" → Create daily/weekly progress tracking reminder
   - Example: "They want to learn Spanish together" → Create study reminder task
   - Extract: goal description, frequency (daily/weekly), tracking method

3. **Common Interest Tasks** - Activities they want to do together
   - Example: "They want to watch a movie together" → Create reminder for movie release
   - Example: "They plan to go hiking" → Create weather/planning reminder
   - Extract: activity, relevant dates, reminder type

4. **Event Tasks** - Upcoming events, deadlines, important dates
   - Example: "They have a project deadline" → Create deadline reminder
   - Example: "Concert next month" → Create reminder before event
   - Extract: event name, date, reminder schedule

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
            content: 'You are an expert at analyzing conversations to extract tasks, goals, and scheduled events. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.5
      };

      // Add JSON mode if supported
      if (this.supportsJsonMode(this.model)) {
        requestParams.response_format = { type: 'json_object' };
      }

      const response = await this.openai.chat.completions.create(requestParams);
      const content = response.choices[0].message.content.trim();
      
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

      // Validate and enrich tasks
      const validatedTasks = tasks
        .filter(t => t && t.category && t.title && (t.confidence === undefined || t.confidence >= 0.2))
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
   */
  async processBatch(conversationBatch, keyMoments = []) {
    try {
      console.log(`🔍 Analyzing conversation batch for tasks (chat ${conversationBatch.chatId})...`);

      const tasks = await this.analyzeConversationForTasks(conversationBatch, keyMoments);

      if (tasks.length === 0) {
        console.log(`   No tasks extracted for chat ${conversationBatch.chatId}`);
        return;
      }

      // Send tasks via callback
      for (const task of tasks) {
        if (this.onTaskExtractedCallback) {
          await this.onTaskExtractedCallback(task);
        }
      }

      console.log(`✅ Extracted ${tasks.length} task(s) for chat ${conversationBatch.chatId}`);
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
