// View Analysis Script - Display conversations and key moments
const fs = require('fs-extra');
const path = require('path');

class AnalysisViewer {
  constructor() {
    this.conversationsFile = path.join(__dirname, 'logs', 'conversations.json');
    this.keyMomentsFile = path.join(__dirname, 'logs', 'key-moments.json');
  }

  /**
   * Load conversations from file
   */
  async loadConversations() {
    try {
      if (!(await fs.pathExists(this.conversationsFile))) {
        return [];
      }
      return await fs.readJson(this.conversationsFile);
    } catch (error) {
      console.error('Error loading conversations:', error);
      return [];
    }
  }

  /**
   * Load key moments from file
   */
  async loadKeyMoments() {
    try {
      if (!(await fs.pathExists(this.keyMomentsFile))) {
        return [];
      }
      return await fs.readJson(this.keyMomentsFile);
    } catch (error) {
      console.error('Error loading key moments:', error);
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
   * Display conversations grouped by chat
   */
  displayConversations(conversations) {
    if (conversations.length === 0) {
      console.log('\n📭 No conversations found.\n');
      console.log('The system may not have processed any messages yet.');
      console.log('Make sure the monitoring system is running (node index.js)');
      return;
    }

    console.log('\n' + '='.repeat(80));
    console.log('💬 CONVERSATIONS');
    console.log('='.repeat(80) + '\n');

    // Group by chatId
    const chats = {};
    conversations.forEach(msg => {
      if (!chats[msg.chatId]) {
        chats[msg.chatId] = [];
      }
      chats[msg.chatId].push(msg);
    });

    Object.keys(chats).forEach((chatId, index) => {
      const messages = chats[chatId];
      const firstMessage = messages[0];
      
      console.log(`\n📱 Chat ${index + 1} (ID: ${chatId})`);
      console.log(`   Service: ${firstMessage.service || 'Unknown'}`);
      console.log(`   Participants: ${firstMessage.fromPhone}${firstMessage.chatHandles?.length > 0 ? ', ' + firstMessage.chatHandles.map(h => h.identifier).join(', ') : ''}`);
      console.log(`   Messages: ${messages.length}`);
      console.log(`   Time Range: ${this.formatDate(messages[0].sentAt)} - ${this.formatDate(messages[messages.length - 1].sentAt)}`);
      console.log('-'.repeat(80));

      // Display recent messages (last 10)
      const recentMessages = messages.slice(-10);
      recentMessages.forEach(msg => {
        const time = this.formatDate(msg.sentAt);
        console.log(`\n[${time}] ${msg.fromPhone}:`);
        console.log(`  ${msg.text || '(no text)'}`);
        if (msg.attachments && msg.attachments.length > 0) {
          console.log(`  📎 ${msg.attachments.length} attachment(s)`);
        }
      });

      if (messages.length > 10) {
        console.log(`\n  ... and ${messages.length - 10} more messages`);
      }
    });

    console.log('\n' + '='.repeat(80) + '\n');
  }

  /**
   * Display key moments
   */
  displayKeyMoments(moments) {
    if (moments.length === 0) {
      console.log('\n✨ No key moments extracted yet.\n');
      console.log('Key moments are extracted when:');
      console.log('  - At least 3 messages are collected');
      console.log('  - The batching window (5 minutes) expires');
      console.log('  - OpenAI analyzes the conversation batch\n');
      return;
    }

    console.log('\n' + '='.repeat(80));
    console.log('✨ KEY MOMENTS & ANALYSIS');
    console.log('='.repeat(80) + '\n');

    // Group by type
    const momentsByType = {
      first_contact: [],
      shared_interest: [],
      important_date: [],
      milestone: [],
      preference: []
    };

    moments.forEach(moment => {
      const type = moment.type || 'unknown';
      if (momentsByType[type]) {
        momentsByType[type].push(moment);
      }
    });

    // Display each type
    const typeLabels = {
      first_contact: '👋 First Contact',
      shared_interest: '🎯 Shared Interests',
      important_date: '📅 Important Dates',
      milestone: '🎉 Relationship Milestones',
      preference: '💭 Personal Preferences'
    };

    Object.keys(momentsByType).forEach(type => {
      const typeMoments = momentsByType[type];
      if (typeMoments.length === 0) return;

      console.log(`\n${typeLabels[type] || type.toUpperCase()}:`);
      console.log('-'.repeat(80));

      typeMoments.forEach((moment, index) => {
        console.log(`\n${index + 1}. ${moment.description}`);
        console.log(`   Date: ${this.formatDate(moment.date || moment.extractedAt)}`);
        if (moment.participants && moment.participants.length > 0) {
          console.log(`   Participants: ${moment.participants.join(', ')}`);
        }
        if (moment.context) {
          console.log(`   Context: "${moment.context}"`);
        }
        if (moment.confidence !== undefined) {
          const confidenceBar = '█'.repeat(Math.round(moment.confidence * 10));
          console.log(`   Confidence: ${(moment.confidence * 100).toFixed(0)}% ${confidenceBar}`);
        }
        if (moment.chatId) {
          console.log(`   Chat ID: ${moment.chatId}`);
        }
      });
    });

    console.log('\n' + '='.repeat(80) + '\n');
  }

  /**
   * Display summary statistics
   */
  displaySummary(conversations, moments) {
    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80) + '\n');

    const chatCount = new Set(conversations.map(c => c.chatId)).size;
    const totalMessages = conversations.length;
    const totalMoments = moments.length;

    // Count moments by type
    const momentsByType = {};
    moments.forEach(m => {
      const type = m.type || 'unknown';
      momentsByType[type] = (momentsByType[type] || 0) + 1;
    });

    console.log(`Total Chats Monitored: ${chatCount}`);
    console.log(`Total Messages: ${totalMessages}`);
    console.log(`Total Key Moments Extracted: ${totalMoments}`);

    if (Object.keys(momentsByType).length > 0) {
      console.log('\nKey Moments Breakdown:');
      Object.keys(momentsByType).forEach(type => {
        const count = momentsByType[type];
        const emoji = {
          first_contact: '👋',
          shared_interest: '🎯',
          important_date: '📅',
          milestone: '🎉',
          preference: '💭'
        }[type] || '•';
        console.log(`  ${emoji} ${type.replace('_', ' ')}: ${count}`);
      });
    }

    if (conversations.length > 0) {
      const oldestMessage = conversations[0];
      const newestMessage = conversations[conversations.length - 1];
      console.log(`\nTime Range: ${this.formatDate(oldestMessage.sentAt)} → ${this.formatDate(newestMessage.sentAt)}`);
    }

    console.log('\n' + '='.repeat(80) + '\n');
  }

  /**
   * Main display function
   */
  async display() {
    console.log('\n🔍 Conversation Analysis Viewer\n');

    const conversations = await this.loadConversations();
    const moments = await this.loadKeyMoments();

    // Display summary first
    this.displaySummary(conversations, moments);

    // Display key moments
    this.displayKeyMoments(moments);

    // Display conversations
    this.displayConversations(conversations);
  }

  /**
   * Display only key moments (for quick viewing)
   */
  async displayMomentsOnly() {
    const moments = await this.loadKeyMoments();
    this.displayKeyMoments(moments);
  }

  /**
   * Display only conversations (for quick viewing)
   */
  async displayConversationsOnly() {
    const conversations = await this.loadConversations();
    this.displayConversations(conversations);
  }
}

// CLI interface
async function main() {
  const viewer = new AnalysisViewer();
  const args = process.argv.slice(2);

  if (args.includes('--moments') || args.includes('-m')) {
    await viewer.displayMomentsOnly();
  } else if (args.includes('--conversations') || args.includes('-c')) {
    await viewer.displayConversationsOnly();
  } else {
    await viewer.display();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

module.exports = AnalysisViewer;
