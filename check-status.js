// Status Checker - Verify monitoring and key moment extraction
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class StatusChecker {
  constructor() {
    this.conversationsFile = path.join(__dirname, 'logs', 'conversations.json');
    this.keyMomentsFile = path.join(__dirname, 'logs', 'key-moments.json');
    this.processedIdsFile = path.join(__dirname, 'logs', 'processed-ids.json');
    this.configFile = path.join(__dirname, 'config.json');
  }

  /**
   * Check if the monitoring process is running
   */
  async checkProcessRunning() {
    try {
      const { stdout } = await execPromise('ps aux | grep "node index.js" | grep -v grep');
      return stdout.trim().length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get process info
   */
  async getProcessInfo() {
    try {
      const { stdout } = await execPromise('ps aux | grep "node index.js" | grep -v grep');
      if (stdout.trim()) {
        const parts = stdout.trim().split(/\s+/);
        return {
          pid: parts[1],
          cpu: parts[2],
          memory: parts[3],
          running: true
        };
      }
      return { running: false };
    } catch (error) {
      return { running: false };
    }
  }

  /**
   * Load conversations
   */
  async loadConversations() {
    try {
      if (!(await fs.pathExists(this.conversationsFile))) {
        return [];
      }
      return await fs.readJson(this.conversationsFile);
    } catch (error) {
      return [];
    }
  }

  /**
   * Load key moments
   */
  async loadKeyMoments() {
    try {
      if (!(await fs.pathExists(this.keyMomentsFile))) {
        return [];
      }
      return await fs.readJson(this.keyMomentsFile);
    } catch (error) {
      return [];
    }
  }

  /**
   * Load processed IDs
   */
  async loadProcessedIds() {
    try {
      if (!(await fs.pathExists(this.processedIdsFile))) {
        return { eventIds: [], messageIds: [] };
      }
      return await fs.readJson(this.processedIdsFile);
    } catch (error) {
      return { eventIds: [], messageIds: [] };
    }
  }

  /**
   * Load config
   */
  async loadConfig() {
    try {
      return await fs.readJson(this.configFile);
    } catch (error) {
      return null;
    }
  }

  /**
   * Format date
   */
  formatDate(dateString) {
    if (!dateString) return 'Unknown';
    try {
      const date = new Date(dateString);
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (error) {
      return dateString;
    }
  }

  /**
   * Get time ago string
   */
  getTimeAgo(dateString) {
    if (!dateString) return 'Unknown';
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now - date;
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffSecs < 60) return `${diffSecs} second${diffSecs !== 1 ? 's' : ''} ago`;
      if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
      if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } catch (error) {
      return 'Unknown';
    }
  }

  /**
   * Display status
   */
  async displayStatus() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 CONVERSATION MONITORING STATUS');
    console.log('='.repeat(80) + '\n');

    // Check if process is running
    const processInfo = await this.getProcessInfo();
    if (processInfo.running) {
      console.log('✅ MONITORING SYSTEM: RUNNING');
      console.log(`   PID: ${processInfo.pid}`);
      console.log(`   CPU: ${processInfo.cpu}%`);
      console.log(`   Memory: ${processInfo.memory}%`);
    } else {
      console.log('❌ MONITORING SYSTEM: NOT RUNNING');
      console.log('   Start it with: node index.js');
    }

    console.log('');

    // Load data
    const config = await this.loadConfig();
    const conversations = await this.loadConversations();
    const keyMoments = await this.loadKeyMoments();
    const processedIds = await this.loadProcessedIds();

    // Configuration
    if (config) {
      console.log('⚙️  CONFIGURATION:');
      console.log(`   Target Phone Numbers: ${config.targetPhoneNumbers.join(', ')}`);
      if (config.senderPhoneNumber) {
        console.log(`   Sender Phone: ${config.senderPhoneNumber} (Hackathon Kafka)`);
      }
      console.log(`   Batching Window: ${config.batchingWindowMinutes} minutes`);
      console.log(`   Min Messages for Analysis: ${config.minMessagesForAnalysis}`);
      console.log(`   OpenAI Model: ${config.openaiModel}`);
      console.log('');
    }

    // Monitoring Statistics
    console.log('📈 MONITORING STATISTICS:');
    const uniqueChats = new Set(conversations.map(c => c.chatId)).size;
    const totalMessages = conversations.length;
    const totalMoments = keyMoments.length;
    const processedEvents = processedIds.eventIds?.length || 0;
    const processedMessages = processedIds.messageIds?.length || 0;

    console.log(`   Total Chats Monitored: ${uniqueChats}`);
    console.log(`   Total Messages Captured: ${totalMessages}`);
    console.log(`   Total Key Moments Extracted: ${totalMoments}`);
    console.log(`   Processed Event IDs: ${processedEvents}`);
    console.log(`   Processed Message IDs: ${processedMessages}`);
    console.log('');

    // Recent Activity
    if (conversations.length > 0) {
      const recentMessages = conversations.slice(-5).reverse();
      console.log('📨 RECENT MESSAGES (Last 5):');
      recentMessages.forEach((msg, idx) => {
        const timeAgo = this.getTimeAgo(msg.sentAt);
        const preview = (msg.text || '(no text)').substring(0, 50);
        console.log(`   ${idx + 1}. [${timeAgo}] ${msg.fromPhone}: ${preview}${msg.text && msg.text.length > 50 ? '...' : ''}`);
      });
      console.log('');

      const oldestMessage = conversations[0];
      const newestMessage = conversations[conversations.length - 1];
      console.log('⏰ TIME RANGE:');
      console.log(`   First Message: ${this.formatDate(oldestMessage.sentAt)}`);
      console.log(`   Last Message: ${this.formatDate(newestMessage.sentAt)}`);
      console.log(`   Last Activity: ${this.getTimeAgo(newestMessage.sentAt)}`);
      console.log('');
    } else {
      console.log('⚠️  NO MESSAGES CAPTURED YET');
      console.log('   The system may be:');
      console.log('   - Waiting for messages from Kafka');
      console.log('   - Filtering out messages (check phone number matching)');
      console.log('   - Not receiving message.received events');
      console.log('');
    }

    // Key Moments Status
    if (keyMoments.length > 0) {
      console.log('✨ KEY MOMENTS STATUS:');
      
      // Group by type
      const momentsByType = {};
      keyMoments.forEach(m => {
        const type = m.type || 'unknown';
        momentsByType[type] = (momentsByType[type] || 0) + 1;
      });

      const typeLabels = {
        first_contact: '👋 First Contact',
        shared_interest: '🎯 Shared Interests',
        important_date: '📅 Important Dates',
        milestone: '🎉 Milestones',
        preference: '💭 Preferences'
      };

      Object.keys(momentsByType).forEach(type => {
        const count = momentsByType[type];
        const label = typeLabels[type] || type;
        console.log(`   ${label}: ${count}`);
      });

      console.log('');
      console.log('📝 RECENT KEY MOMENTS (Last 3):');
      const recentMoments = keyMoments.slice(-3).reverse();
      recentMoments.forEach((moment, idx) => {
        const timeAgo = this.getTimeAgo(moment.extractedAt || moment.date);
        console.log(`   ${idx + 1}. [${timeAgo}] ${moment.description}`);
        if (moment.context) {
          console.log(`      Context: "${moment.context.substring(0, 60)}${moment.context.length > 60 ? '...' : ''}"`);
        }
      });
      console.log('');
    } else {
      console.log('⚠️  NO KEY MOMENTS EXTRACTED YET');
      console.log('   Key moments are extracted when:');
      console.log(`   - At least ${config?.minMessagesForAnalysis || 3} messages are collected`);
      console.log(`   - The batching window (${config?.batchingWindowMinutes || 0.25} minutes) expires`);
      console.log('   - OpenAI successfully analyzes the conversation');
      console.log('');
    }

    // Health Check
    console.log('🏥 HEALTH CHECK:');
    const issues = [];
    
    if (!processInfo.running) {
      issues.push('❌ Monitoring process is not running');
    }
    
    if (conversations.length === 0 && processInfo.running) {
      issues.push('⚠️  Process is running but no messages captured (check Kafka connection)');
    }
    
    if (conversations.length > 0 && keyMoments.length === 0) {
      const recentMessages = conversations.slice(-config?.minMessagesForAnalysis || 3);
      if (recentMessages.length >= (config?.minMessagesForAnalysis || 3)) {
        issues.push('⚠️  Messages captured but no key moments extracted (check OpenAI API)');
      }
    }

    if (issues.length === 0) {
      console.log('   ✅ All systems operational!');
    } else {
      issues.forEach(issue => console.log(`   ${issue}`));
    }

    console.log('\n' + '='.repeat(80) + '\n');
  }

  /**
   * Watch mode - continuously check status
   */
  async watch(intervalSeconds = 5) {
    console.log(`\n👀 Watching status (updates every ${intervalSeconds} seconds)...\n`);
    console.log('Press Ctrl+C to stop\n');

    const display = async () => {
      // Clear screen (works on most terminals)
      process.stdout.write('\x1B[2J\x1B[0f');
      await this.displayStatus();
    };

    // Initial display
    await display();

    // Update periodically
    setInterval(async () => {
      await display();
    }, intervalSeconds * 1000);
  }
}

// CLI interface
async function main() {
  const checker = new StatusChecker();
  const args = process.argv.slice(2);

  if (args.includes('--watch') || args.includes('-w')) {
    const interval = parseInt(args[args.indexOf('--watch') + 1] || args[args.indexOf('-w') + 1] || '5');
    await checker.watch(interval);
  } else {
    await checker.displayStatus();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

module.exports = StatusChecker;

