// Task Scheduler Service - Manages scheduled tasks and sends reminders
require('dotenv').config();
const SeriesAPIClient = require('./api-client');
const config = require('./config.json');
const GoogleSearchService = require('./google-search-service');
const DatabaseService = require('./database-service');

class TaskSchedulerService {
  constructor() {
    this.apiClient = new SeriesAPIClient();
    this.senderPhoneNumber = config.senderPhoneNumber || '+16463458837';
    this.db = new DatabaseService();
    this.googleSearchService = new GoogleSearchService();
    
    // Task check interval (check every minute)
    this.checkInterval = (config.taskSchedulerCheckIntervalSeconds || 60) * 1000;
    this.reminderTimeWindow = (config.taskReminderTimeWindowMinutes || 5) * 60 * 1000;
    this.checkIntervalId = null;
    this.hasLoggedNoTasks = false; // Track if we've logged the "no tasks" message
    this.lastMatchdayCheckDate = null; // Track when we last checked matchday tasks
    this.lastMatchdayTaskCount = 0; // Track how many matchday tasks we had last check
  }

  /**
   * Load all tasks from MongoDB
   */
  async loadTasks() {
    try {
      return await this.db.getAllActiveTasks();
    } catch (error) {
      console.error('Error loading tasks:', error);
      return [];
    }
  }

  /**
   * Store a new task
   */
  async storeTask(task) {
    try {
      await this.db.storeTask(task);
      console.log(`✅ Stored task: ${task.title} (${task.category})`);
    } catch (error) {
      console.error('Error storing task:', error);
    }
  }

  /**
   * Update task (e.g., after sending reminder)
   */
  async updateTask(taskId, updates) {
    try {
      await this.db.updateTask(taskId, updates);
    } catch (error) {
      console.error('Error updating task:', error);
    }
  }

  /**
   * Check if a task should trigger a reminder now
   */
  async shouldTriggerReminder(task) {
    const now = new Date();
    const schedule = task.schedule;

    switch (schedule.type) {
      case 'daily':
        return this.shouldTriggerDaily(task, now);
      
      case 'weekly':
        return this.shouldTriggerWeekly(task, now);
      
      case 'matchday':
        return await this.shouldTriggerMatchday(task, now);
      
      case 'event_based':
        return this.shouldTriggerEventBased(task, now);
      
      default:
        return false;
    }
  }

  /**
   * Check if daily task should trigger
   */
  shouldTriggerDaily(task, now) {
    const schedule = task.schedule;
    const lastReminder = task.lastReminderSent ? new Date(task.lastReminderSent) : null;
    
    // Check if we've already sent today
    if (lastReminder) {
      const lastReminderDate = new Date(lastReminder.getFullYear(), lastReminder.getMonth(), lastReminder.getDate());
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (lastReminderDate.getTime() === today.getTime()) {
        return false; // Already sent today
      }
    }

    // Check time of day
    if (schedule.time) {
      const [hours, minutes] = schedule.time.split(':').map(Number);
      const targetTime = new Date(now);
      targetTime.setHours(hours, minutes, 0, 0);
      
      // Trigger if current time is within configured window of target time
      const diff = Math.abs(now - targetTime);
      return diff < this.reminderTimeWindow;
    }

    // No specific time, trigger once per day (check every hour)
    if (lastReminder) {
      const hoursSinceLastReminder = (now - lastReminder) / (1000 * 60 * 60);
      return hoursSinceLastReminder >= 24;
    }

    return true; // First time, trigger now
  }

  /**
   * Check if weekly task should trigger
   */
  shouldTriggerWeekly(task, now) {
    const schedule = task.schedule;
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDay = dayNames[now.getDay()];
    
    if (!schedule.daysOfWeek || !schedule.daysOfWeek.includes(currentDay)) {
      return false;
    }

    const lastReminder = task.lastReminderSent ? new Date(task.lastReminderSent) : null;
    if (lastReminder) {
      const lastReminderDate = new Date(lastReminder.getFullYear(), lastReminder.getMonth(), lastReminder.getDate());
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (lastReminderDate.getTime() === today.getTime()) {
        return false; // Already sent today
      }
    }

    // Check time if specified
    if (schedule.time) {
      const [hours, minutes] = schedule.time.split(':').map(Number);
      const targetTime = new Date(now);
      targetTime.setHours(hours, minutes, 0, 0);
      const diff = Math.abs(now - targetTime);
      return diff < 5 * 60 * 1000; // 5 minutes window
    }

    return true;
  }

  /**
   * Check if matchday task should trigger
   */
  async shouldTriggerMatchday(task, now) {
    const schedule = task.schedule;
    const metadata = task.metadata;
    
    if (!this.googleSearchService.enabled) {
      console.warn(`⚠️  Google Search not enabled. Using fallback matchday detection for task: ${task.title}`);
      // Fallback to weekend detection if Google Search is not available
      return this.shouldTriggerMatchdayFallback(task, now);
    }

    if (schedule.matchdayPattern === 'before_match' || schedule.matchdayPattern === 'matchday_morning') {
      const teamName = metadata.teamName;
      const sportType = metadata.sportType || 'soccer';
      
      if (!teamName) {
        return false;
      }

      // Check if we've already sent a reminder today
      const lastReminder = task.lastReminderSent ? new Date(task.lastReminderSent) : null;
      if (lastReminder) {
        const lastReminderDate = new Date(lastReminder.getFullYear(), lastReminder.getMonth(), lastReminder.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (lastReminderDate.getTime() === today.getTime()) {
          return false; // Already sent today
        }
      }

      // Search for upcoming matches
      try {
        const hasMatchToday = await this.checkForMatchToday(teamName, sportType, now);
        return hasMatchToday;
      } catch (error) {
        console.error(`Error checking for matches for ${teamName}:`, error);
        // Fallback to weekend detection on error
        return this.shouldTriggerMatchdayFallback(task, now);
      }
    }

    return false;
  }

  /**
   * Fallback matchday detection (weekend-based)
   */
  shouldTriggerMatchdayFallback(task, now) {
    const metadata = task.metadata;
    const dayOfWeek = now.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday
    
    if (metadata.sportType === 'soccer' && isWeekend) {
      const lastReminder = task.lastReminderSent ? new Date(task.lastReminderSent) : null;
      if (lastReminder) {
        const lastReminderDate = new Date(lastReminder.getFullYear(), lastReminder.getMonth(), lastReminder.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return lastReminderDate.getTime() !== today.getTime();
      }
      return true;
    }
    return false;
  }

  /**
   * Check if there's a match today using Google Search
   */
  async checkForMatchToday(teamName, sportType, now) {
    try {
      const today = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      
      // Build search query
      let searchQuery = '';
      if (sportType === 'soccer' || sportType === 'football') {
        searchQuery = `${teamName} match today ${today} schedule`;
      } else if (sportType === 'basketball') {
        searchQuery = `${teamName} game today ${today} schedule`;
      } else {
        searchQuery = `${teamName} ${sportType} match today ${today}`;
      }

      console.log(`   🔍 Searching for matches: "${searchQuery}"`);
      const results = await this.googleSearchService.searchPlaces(searchQuery);
      
      if (!results || results.length === 0) {
        return false;
      }

      // Check if any result indicates a match today
      const todayKeywords = [
        'today',
        now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
        now.toLocaleDateString('en-US', { weekday: 'long' })
      ];
      
      const hasMatch = results.some(result => {
        const text = (result.title + ' ' + result.snippet).toLowerCase();
        const teamLower = teamName.toLowerCase();
        return text.includes(teamLower) && 
               (todayKeywords.some(keyword => text.includes(keyword.toLowerCase())) ||
                text.includes('vs') || 
                text.includes('match') ||
                text.includes('game'));
      });

      if (hasMatch) {
        console.log(`   ✅ Match found for ${teamName} today!`);
        // Store match info in task metadata for use in reminder
        return true;
      }

      return false;
    } catch (error) {
      console.error(`Error checking for match:`, error);
      return false;
    }
  }

  /**
   * Get match details for reminder message
   */
  async getMatchDetails(teamName, sportType, now) {
    try {
      if (!this.googleSearchService.enabled) {
        return null;
      }

      const today = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const searchQuery = `${teamName} match today ${today} schedule`;
      
      const results = await this.googleSearchService.searchPlaces(searchQuery);
      
      if (results && results.length > 0) {
        // Extract match details from first result
        const firstResult = results[0];
        return {
          opponent: this.extractOpponent(firstResult.snippet, teamName),
          time: this.extractMatchTime(firstResult.snippet),
          venue: this.extractVenue(firstResult.snippet),
          details: firstResult.snippet
        };
      }
      
      return null;
    } catch (error) {
      console.error('Error getting match details:', error);
      return null;
    }
  }

  /**
   * Extract opponent from search result
   */
  extractOpponent(text, teamName) {
    // Look for "vs" or "v" patterns
    const vsPattern = new RegExp(`${teamName}\\s+(?:vs|v\\.?|versus)\\s+([A-Z][a-zA-Z\\s]+)`, 'i');
    const match = text.match(vsPattern);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  }

  /**
   * Extract match time from search result
   */
  extractMatchTime(text) {
    // Look for time patterns like "3:00 PM", "15:00", etc.
    const timePattern = /\b(\d{1,2}):(\d{2})\s*(AM|PM)?/i;
    const match = text.match(timePattern);
    if (match) {
      return match[0];
    }
    return null;
  }

  /**
   * Extract venue from search result
   */
  extractVenue(text) {
    // Look for venue indicators
    const venuePattern = /(?:at|@|stadium|arena|field)\s+([A-Z][a-zA-Z\s]+(?:Stadium|Arena|Field|Park)?)/i;
    const match = text.match(venuePattern);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  }

  /**
   * Check if event-based task should trigger
   */
  shouldTriggerEventBased(task, now) {
    const schedule = task.schedule;
    if (!schedule.eventDate) return false;

    const eventDate = new Date(schedule.eventDate);
    const reminderDays = schedule.reminderDaysBefore || 1;
    const reminderDate = new Date(eventDate);
    reminderDate.setDate(reminderDate.getDate() - reminderDays);

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const reminderDay = new Date(reminderDate.getFullYear(), reminderDate.getMonth(), reminderDate.getDate());

    return today.getTime() === reminderDay.getTime();
  }

  /**
   * Generate reminder message for a task
   */
  async generateReminderMessage(task) {
    const category = task.category;
    const metadata = task.metadata;

    switch (category) {
      case 'sports':
        if (metadata.teamName) {
          // Try to get match details for more specific reminder
          const matchDetails = await this.getMatchDetails(metadata.teamName, metadata.sportType, new Date());
          
          if (matchDetails && matchDetails.opponent) {
            let message = `⚽ ${metadata.teamName} has a match today!`;
            if (matchDetails.opponent) {
              message += `\n🆚 vs ${matchDetails.opponent}`;
            }
            if (matchDetails.time) {
              message += `\n⏰ ${matchDetails.time}`;
            }
            if (matchDetails.venue) {
              message += `\n📍 ${matchDetails.venue}`;
            }
            message += `\n\nWant to watch together? 🎉`;
            return message;
          }
          
          // Fallback to confident message
          const now = new Date();
          const hour = now.getHours();
          const timeOfDay = hour >= 17 ? 'tonight' : hour >= 12 ? 'this afternoon' : 'today';
          return `⚽ ${metadata.teamName} is having a match ${timeOfDay}! Want to watch together? 🎉`;
        }
        return `🏀 Want to catch the game today?`;
      
      case 'goal':
        if (metadata.goalType === 'weight_loss' || task.title.toLowerCase().includes('weight')) {
          return `💪 Daily check-in! How's your progress today? Remember your goal: ${task.description}`;
        }
        return `📊 Progress check! How are you doing with: ${task.title}?`;
      
      case 'common_interest':
        return `🎯 ${task.title}\n${task.description}`;
      
      case 'event':
        return `📅 ${task.metadata.eventName || task.title} is coming up!`;
      
      default:
        return `📌 ${task.title}`;
    }
  }

  /**
   * Send reminder for a task
   */
  async sendReminder(task) {
    try {
      const message = await this.generateReminderMessage(task);
      
      if (!this.apiClient.enabled) {
        console.warn(`⚠️  Would send reminder for task "${task.title}" to chat ${task.chatId}:`);
        console.warn(`   ${message}`);
        return false;
      }

      console.log(`📤 Sending reminder for task: ${task.title}`);
      console.log(`   Chat ID: ${task.chatId}`);
      console.log(`   Message: "${message}"`);

      await this.apiClient.sendMessage(
        task.chatId,
        message,
        [],
        this.senderPhoneNumber
      );

      // Update task
      await this.updateTask(task.id, {
        lastReminderSent: new Date().toISOString(),
        reminderCount: (task.reminderCount || 0) + 1
      });

      console.log(`✅ Reminder sent successfully!`);
      return true;
    } catch (error) {
      console.error(`❌ Error sending reminder for task ${task.id}:`, error);
      return false;
    }
  }

  /**
   * Check all tasks and send reminders
   */
  async checkAndSendReminders() {
    try {
      const tasks = await this.loadTasks();
      
      if (tasks.length === 0) {
        // Only log this once per startup to avoid spam
        if (!this.hasLoggedNoTasks) {
          console.log('   No active tasks found. Waiting for tasks to be created from conversations...');
          console.log('   💡 Tasks are automatically created when conversations contain task-worthy content.');
          this.hasLoggedNoTasks = true;
        }
        return;
      }

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const lastCheckDate = this.lastMatchdayCheckDate ? 
        new Date(new Date(this.lastMatchdayCheckDate).getFullYear(), 
                 new Date(this.lastMatchdayCheckDate).getMonth(), 
                 new Date(this.lastMatchdayCheckDate).getDate()) : null;
      
      const isNewDay = !lastCheckDate || today.getTime() !== lastCheckDate.getTime();
      
      // Separate tasks by type
      const matchdayTasks = tasks.filter(t => t.category === 'sports' && t.schedule?.type === 'matchday');
      const otherTasks = tasks.filter(t => !(t.category === 'sports' && t.schedule?.type === 'matchday'));

      console.log(`\n⏰ Task Scheduler: Checking ${tasks.length} active task(s)...`);
      console.log(`   Matchday tasks: ${matchdayTasks.length}, Other tasks: ${otherTasks.length}`);

      // Reset check date if matchday tasks were deleted (count changed from >0 to 0)
      // or if new matchday tasks were added (count increased)
      const matchdayTaskCountChanged = this.lastMatchdayTaskCount !== matchdayTasks.length;
      if (matchdayTaskCountChanged) {
        if (matchdayTasks.length === 0) {
          // All matchday tasks deleted - reset check date
          this.lastMatchdayCheckDate = null;
          this.lastMatchdayTaskCount = 0;
          console.log(`   🔄 Matchday tasks deleted - resetting check date`);
        } else if (this.lastMatchdayTaskCount === 0 && matchdayTasks.length > 0) {
          // New matchday tasks added - allow check
          this.lastMatchdayTaskCount = matchdayTasks.length;
          console.log(`   🔄 New matchday tasks detected (${matchdayTasks.length}) - will check`);
        } else {
          // Count changed but not zero - update count
          this.lastMatchdayTaskCount = matchdayTasks.length;
        }
      }

      // Check matchday tasks once per day (to avoid excessive Google searches)
      // Only skip if: there are matchday tasks AND we already checked today AND count hasn't changed
      if (matchdayTasks.length > 0 && (isNewDay || matchdayTaskCountChanged)) {
        console.log(`   🔍 Checking matchday tasks (daily check)...`);
        this.lastMatchdayCheckDate = now.toISOString();
        this.lastMatchdayTaskCount = matchdayTasks.length;
        
        for (const task of matchdayTasks) {
          try {
            const shouldTrigger = await this.shouldTriggerReminder(task);
            if (shouldTrigger) {
              await this.sendReminder(task);
            }
          } catch (error) {
            console.error(`Error checking matchday task ${task.id}:`, error);
          }
        }
      } else if (matchdayTasks.length > 0 && !isNewDay && !matchdayTaskCountChanged) {
        console.log(`   ⏭️  Skipping matchday tasks (already checked today)`);
      } else if (matchdayTasks.length === 0) {
        // No matchday tasks - don't show skip message
        this.lastMatchdayTaskCount = 0;
      }

      // Check other tasks every minute (daily, weekly, event-based, etc.)
      for (const task of otherTasks) {
        try {
          const shouldTrigger = await this.shouldTriggerReminder(task);
          if (shouldTrigger) {
            await this.sendReminder(task);
          }
        } catch (error) {
          console.error(`Error checking task ${task.id}:`, error);
        }
      }
    } catch (error) {
      console.error('Error in task scheduler check:', error);
    }
  }

  async start() {
    await this.db.connect();
    console.log('Task Scheduler Service started');
    console.log(`   Check interval: ${this.checkInterval / 1000} seconds`);
    
    if (!this.apiClient.enabled) {
      console.warn('⚠️  API client not enabled. Reminders will be logged but not sent.');
    }

    // Run initial check
    this.checkAndSendReminders().catch(error => {
      console.error('Error in initial task check:', error);
    });

    // Set up periodic checks
    this.checkIntervalId = setInterval(() => {
      this.checkAndSendReminders().catch(error => {
        console.error('Error in periodic task check:', error);
      });
    }, this.checkInterval);
  }

  async stop() {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
    await this.db.disconnect();
    console.log('Task Scheduler Service stopped');
  }
}

module.exports = TaskSchedulerService;
