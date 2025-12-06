// Test script to verify AI response service
require('dotenv').config();
const AIResponseService = require('./ai-response-service');
const config = require('./config.json');

async function testAIResponse() {
  try {
    console.log('🧪 Testing AI Response Service...\n');
    
    const service = new AIResponseService();
    await service.start();
    
    // Create a test message from the 929 number
    const testMessage = {
      chatId: 'test-chat-123',
      messageId: `test-msg-${Date.now()}`,
      fromPhone: '+19294265300', // 929 number
      text: 'Hey! How are you?',
      sentAt: new Date().toISOString(),
      chatHandles: [
        { identifier: '+16463458837' }, // 646 number (sender)
        { identifier: '+19294265300' }  // 929 number
      ],
      attachments: [],
      isRead: false,
      service: 'iMessage'
    };
    
    console.log('\n📨 Test message:');
    console.log(JSON.stringify(testMessage, null, 2));
    console.log('\n');
    
    // Process the message
    await service.processMessage(testMessage);
    
    console.log('\n✅ Test completed!');
    
    await service.stop();
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testAIResponse();

