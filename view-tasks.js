// View Tasks Script - Display extracted tasks
const fs = require('fs-extra');
const path = require('path');

class TaskViewer {
  constructor() {
    this.tasksFile = path.join(__dirname, 'logs', 'tasks.json');
  }

  /**
   * Load tasks from file
   */
  async loadTasks() {
    try {
      if (!(await fs.pathExists(this.tasksFile))) {
        return [];
      }
      return await fs.readJson(this.tasksFile);
    } catch (error) {
      console.error('Error loading tasks:', error);
      return [];
    }
  }

  /**
   * Format date for display
   */
  formatDate(dateString) {
    if (!dateString) return 'Unknown date';
    try {
      const date = new Date(dateString);
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (error) {
      return dateString;
    }
  }

  /**
   * Display tasks grouped by category
   */
  displayTasks(tasks) {
    if (tasks.length === 0) {
      console.log('\n📋 No tasks found.\n');
      console.log('Tasks are extracted when conversations contain:');
      console.log('  - Sports preferences (e.g., "We\'re both FC Barcelona fans!")');
      console.log('  - Shared goals (e.g., "We both want to lose weight")');
      console.log('  - Planned activities (e.g., "Let\'s watch that movie together")');
      console.log('  - Upcoming events (e.g., "We have a concert next month")\n');
      return;
    }

    console.log('\n' + '='.repeat(80));
    console.log('📋 TASKS & REMINDERS');
    console.log('='.repeat(80) + '\n');

    // Group by category
    const tasksByCategory = {
      sports: [],
      goal: [],
      common_interest: [],
      event: []
    };

    tasks.forEach(task => {
      const category = task.category || 'unknown';
      if (tasksByCategory[category]) {
        tasksByCategory[category].push(task);
      }
    });

    // Display each category
    const categoryLabels = {
      sports: '⚽ Sports Tasks',
      goal: '💪 Goal Tasks',
      common_interest: '🎯 Common Interest Tasks',
      event: '📅 Event Tasks'
    };

    Object.keys(tasksByCategory).forEach(category => {
      const categoryTasks = tasksByCategory[category];
      if (categoryTasks.length === 0) return;

      console.log(`\n${categoryLabels[category] || category.toUpperCase()}:`);
      console.log('-'.repeat(80));

      categoryTasks.forEach((task, index) => {
        console.log(`\n${index + 1}. ${task.title}`);
        console.log(`   Status: ${task.status || 'active'}`);
        console.log(`   Description: ${task.description || 'N/A'}`);
        
        if (task.schedule) {
          console.log(`   Schedule: ${JSON.stringify(task.schedule, null, 2).replace(/\n/g, '\n      ')}`);
        }
        
        if (task.metadata) {
          const metadataStr = Object.entries(task.metadata)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          console.log(`   Metadata: ${metadataStr}`);
        }
        
        if (task.context) {
          console.log(`   Context: "${task.context}"`);
        }
        
        if (task.confidence !== undefined) {
          const confidenceBar = '█'.repeat(Math.round(task.confidence * 10));
          console.log(`   Confidence: ${(task.confidence * 100).toFixed(0)}% ${confidenceBar}`);
        }
        
        if (task.extractedAt) {
          console.log(`   Extracted: ${this.formatDate(task.extractedAt)}`);
        }
        
        if (task.lastReminderSent) {
          console.log(`   Last Reminder: ${this.formatDate(task.lastReminderSent)}`);
        }
        
        if (task.reminderCount !== undefined) {
          console.log(`   Reminders Sent: ${task.reminderCount}`);
        }
        
        if (task.chatId) {
          console.log(`   Chat ID: ${task.chatId}`);
        }
      });
    });

    console.log('\n' + '='.repeat(80) + '\n');
  }

  /**
   * Display summary statistics
   */
  displaySummary(tasks) {
    console.log('\n' + '='.repeat(80));
    console.log('📊 TASK SUMMARY');
    console.log('='.repeat(80) + '\n');

    const totalTasks = tasks.length;
    const activeTasks = tasks.filter(t => t.status === 'active').length;
    const completedTasks = tasks.filter(t => t.status === 'completed').length;

    // Count by category
    const tasksByCategory = {};
    tasks.forEach(t => {
      const cat = t.category || 'unknown';
      tasksByCategory[cat] = (tasksByCategory[cat] || 0) + 1;
    });

    console.log(`Total Tasks: ${totalTasks}`);
    console.log(`Active: ${activeTasks}`);
    console.log(`Completed: ${completedTasks}`);

    if (Object.keys(tasksByCategory).length > 0) {
      console.log('\nTasks by Category:');
      Object.keys(tasksByCategory).forEach(cat => {
        const count = tasksByCategory[cat];
        const emoji = {
          sports: '⚽',
          goal: '💪',
          common_interest: '🎯',
          event: '📅'
        }[cat] || '•';
        console.log(`  ${emoji} ${cat}: ${count}`);
      });
    }

    // Count reminders sent
    const totalReminders = tasks.reduce((sum, t) => sum + (t.reminderCount || 0), 0);
    if (totalReminders > 0) {
      console.log(`\nTotal Reminders Sent: ${totalReminders}`);
    }

    console.log('\n' + '='.repeat(80) + '\n');
  }

  /**
   * Main display function
   */
  async display() {
    console.log('\n🔍 Task Viewer\n');

    const tasks = await this.loadTasks();

    // Display summary first
    this.displaySummary(tasks);

    // Display tasks
    this.displayTasks(tasks);
  }
}

// CLI interface
async function main() {
  const viewer = new TaskViewer();
  await viewer.display();
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

module.exports = TaskViewer;

