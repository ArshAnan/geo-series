// Script to create a group chat and send a message
require('dotenv').config();
const SeriesAPIClient = require('./api-client');
const config = require('./config.json');

async function createGroupChatAndSendMessage() {
  try {
    const apiClient = new SeriesAPIClient();
    
    if (!apiClient.enabled) {
      console.error('❌ API client is not enabled. Please set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
      process.exit(1);
    }

    // Get phone numbers from config
    const senderPhoneNumber = config.senderPhoneNumber || '+16463458837';
    const recipientNumber = '+19294265300'; // The 929... number
    const messageText = process.argv[2] || 'Hey! I am Series AI';

    // phone_numbers should be RECIPIENTS only (not including the sender)
    // The sender is specified separately in send_from
    const recipientNumbers = [recipientNumber];

    console.log('📱 Creating chat between:');
    console.log(`   Sender: ${senderPhoneNumber} (will send the message)`);
    console.log(`   Recipient: ${recipientNumber}`);

    console.log(`\n📤 Creating group chat and sending message...`);
    console.log(`   Message: "${messageText}"`);
    console.log(`   From: ${senderPhoneNumber}`);

    // Create chat and send message in one API call
    // The POST /api/chats endpoint creates the chat AND sends the initial message
    // phone_numbers should be RECIPIENTS only (sender is specified in send_from)
    const result = await apiClient.createGroupChat(
      recipientNumbers,
      messageText,
      senderPhoneNumber
    );
    
    // Extract chat and message from response
    const chat = result.data || result;
    
    if (!chat || !chat.id) {
      throw new Error('Failed to create group chat - no chat ID returned');
    }

    console.log(`\n✅ Group chat created successfully!`);
    console.log(`   Chat ID: ${chat.id}`);
    
    if (chat.chat_handles) {
      console.log(`   Participants: ${chat.chat_handles.length}`);
      chat.chat_handles.forEach((handle, idx) => {
        console.log(`      ${idx + 1}. ${handle.phone_number} (${handle.service})`);
      });
    }

    if (chat.chat_messages) {
      console.log(`\n✅ Initial message sent successfully!`);
      console.log(`   Message ID: ${chat.chat_messages.id}`);
      console.log(`   Text: "${chat.chat_messages.text}"`);
      console.log(`   Status: ${chat.chat_messages.delivery_status}`);
    }

    console.log('\n✨ Done! Group chat created and message sent.');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
      
      if (error.response.status === 403) {
        console.error('\n💡 This is a permissions issue. The API is blocking the request because:');
        console.error('   - One or more phone numbers are not registered/allowed for your team');
        console.error('   - You can only create chats with phone numbers that are registered as team participants');
        console.error('\n   Solutions:');
        console.error('   1. Contact hackathon organizers to register the phone numbers you want to use');
        console.error('   2. Use only phone numbers that are confirmed to be registered for your team');
        console.error('   3. Check which phone numbers are registered via the team participants endpoint');
      }
    }
    process.exit(1);
  }
}

createGroupChatAndSendMessage();

