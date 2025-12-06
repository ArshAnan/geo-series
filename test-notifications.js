// Utility script to test notifications and view pending key moments
require('dotenv').config();
const NotificationService = require('./notification-service');
const StorageService = require('./storage-service');
const fs = require('fs-extra');
const path = require('path');

async function testNotifications() {
  const notificationService = new NotificationService();
  const storageService = new StorageService();
  
  const command = process.argv[2];
  const chatId = process.argv[3];

  try {
    switch (command) {
      case 'list':
        // List all chats with pending moments
        console.log('\n📋 Chats with pending key moments:\n');
        await notificationService.loadSentMoments(); // Reload to get latest
        const keyMomentsFile = path.join(__dirname, 'logs', 'key-moments.json');
        if (await fs.pathExists(keyMomentsFile)) {
          const allMoments = await fs.readJson(keyMomentsFile);
          const chats = [...new Set(allMoments.map(m => m.chatId))];
          
          if (chats.length === 0) {
            console.log('No key moments found.');
            return;
          }

          for (const cId of chats) {
            const moments = allMoments.filter(m => m.chatId === cId);
            const pending = await notificationService.getPendingMomentsFromStorage(cId);
            console.log(`Chat: ${cId}`);
            console.log(`  Total moments: ${moments.length}`);
            console.log(`  Pending (not sent): ${pending.length}`);
            console.log('');
          }
        } else {
          console.log('No key moments file found.');
        }
        break;

      case 'send':
        // Send summary for a specific chat
        if (!chatId) {
          console.error('Error: Please provide a chat ID');
          console.log('Usage: node test-notifications.js send <chatId>');
          process.exit(1);
        }

        await notificationService.loadSentMoments(); // Reload to get latest
        
        // Load moments from storage and add them to activity
        const momentsToSend = await notificationService.getPendingMomentsFromStorage(chatId);
        if (momentsToSend.length === 0) {
          console.log(`\nNo pending moments for chat ${chatId}`);
          return;
        }

        // Add moments to activity so sendSummaryNow can use them
        momentsToSend.forEach(moment => {
          notificationService.addKeyMoment(moment);
        });

        console.log(`\n📤 Sending summary for chat ${chatId}...\n`);
        await notificationService.sendSummaryNow(chatId);
        console.log('\n✅ Summary sent!');
        break;

      case 'view':
        // View pending moments for a chat
        if (!chatId) {
          console.error('Error: Please provide a chat ID');
          console.log('Usage: node test-notifications.js view <chatId>');
          process.exit(1);
        }

        await notificationService.loadSentMoments(); // Reload to get latest
        const pending = await notificationService.getPendingMomentsFromStorage(chatId);
        if (pending.length === 0) {
          console.log(`\nNo pending moments for chat ${chatId}`);
          return;
        }

        console.log(`\n📝 Pending key moments for chat ${chatId}:\n`);
        pending.forEach((moment, idx) => {
          console.log(`${idx + 1}. ${moment.type}: ${moment.description}`);
          if (moment.context) {
            console.log(`   Context: "${moment.context}"`);
          }
          if (moment.date) {
            console.log(`   Date: ${moment.date}`);
          }
          console.log('');
        });
        break;

      case 'preview':
        // Preview what the summary would look like
        if (!chatId) {
          console.error('Error: Please provide a chat ID');
          console.log('Usage: node test-notifications.js preview <chatId>');
          process.exit(1);
        }

        await notificationService.loadSentMoments(); // Reload to get latest
        const pendingMoments = await notificationService.getPendingMomentsFromStorage(chatId);
        if (pendingMoments.length === 0) {
          console.log(`\nNo pending moments for chat ${chatId}`);
          return;
        }

        const summary = notificationService.formatSummary(pendingMoments, chatId);
        console.log('\n📄 Preview of summary that would be sent:\n');
        console.log(summary);
        break;

      default:
        console.log('\n📬 Key Moments Notification Tester\n');
        console.log('Usage:');
        console.log('  node test-notifications.js list                    - List all chats with pending moments');
        console.log('  node test-notifications.js view <chatId>           - View pending moments for a chat');
        console.log('  node test-notifications.js preview <chatId>       - Preview summary for a chat');
        console.log('  node test-notifications.js send <chatId>           - Send summary for a chat\n');
        console.log('Examples:');
        console.log('  node test-notifications.js list');
        console.log('  node test-notifications.js view chat-123');
        console.log('  node test-notifications.js send chat-123\n');
    }
  } catch (error) {
    console.error('Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  testNotifications();
}

module.exports = testNotifications;
