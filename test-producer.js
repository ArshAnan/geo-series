// Test Kafka Producer - Sends a dummy message to test consumer
require('dotenv').config();
const { Kafka } = require('kafkajs');
const config = require('./config.json');

// Kafka Configuration (same as consumer)
const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'test-producer',
  brokers: process.env.KAFKA_BROKERS.split(','),
  ssl: true,
  sasl: {
    mechanism: 'plain',
    username: process.env.KAFKA_SASL_USERNAME,
    password: process.env.KAFKA_SASL_PASSWORD
  }
});

const producer = kafka.producer();

async function sendTestMessage() {
  try {
    console.log('\n🔌 Connecting to Kafka...');
    console.log(`   Brokers: ${process.env.KAFKA_BROKERS}`);
    console.log(`   Topic: ${process.env.KAFKA_TOPIC}`);
    console.log(`   Client ID: ${process.env.KAFKA_CLIENT_ID || 'test-producer'}\n`);
    
    await producer.connect();
    console.log('✅ Producer connected successfully!\n');

    const topic = process.env.KAFKA_TOPIC;
    if (!topic) {
      throw new Error('KAFKA_TOPIC must be set in .env');
    }

    // Create a test message in the same format as Series API message.received events
    const testMessage = {
      event_type: 'message.received',
      event_id: `test-event-${Date.now()}`,
      created_at: new Date().toISOString(),
      data: {
        id: `test-msg-${Date.now()}`,
        chat_id: config.chatId || '1702657',
        from_phone: config.targetPhoneNumbers[0] || '+19294265300', // Use first target phone
        text: `🧪 TEST MESSAGE: This is a test message sent at ${new Date().toLocaleTimeString()}. If you see this, your consumer is working!`,
        sent_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
        delivery_status: 'delivered',
        is_read: false,
        service: 'iMessage',
        chat_handles: config.targetPhoneNumbers.map(phone => ({
          identifier: phone
        })),
        attachments: [],
        reactions: []
      }
    };

    console.log('📤 Sending test message...');
    console.log(`   Event Type: ${testMessage.event_type}`);
    console.log(`   Event ID: ${testMessage.event_id}`);
    console.log(`   Chat ID: ${testMessage.data.chat_id}`);
    console.log(`   From Phone: ${testMessage.data.from_phone}`);
    console.log(`   Text: "${testMessage.data.text}"`);
    console.log(`   Chat Handles: ${testMessage.data.chat_handles.map(h => h.identifier).join(', ')}\n`);

    const result = await producer.send({
      topic: topic,
      messages: [
        {
          key: testMessage.event_id,
          value: JSON.stringify(testMessage)
        }
      ]
    });

    console.log('✅ Message sent successfully!');
    console.log(`   Topic: ${result[0].topicName}`);
    console.log(`   Partition: ${result[0].partition}`);
    console.log(`   Offset: ${result[0].offset}`);
    console.log(`\n📋 Next steps:`);
    console.log(`   1. Check your consumer logs - you should see:`);
    console.log(`      • "📨 RAW KAFKA MESSAGE RECEIVED"`);
    console.log(`      • "✅✅✅ MESSAGE PASSED FILTER - PROCESSING NOW ✅✅✅"`);
    console.log(`   2. If you see the message, consumer is working!`);
    console.log(`   3. If you don't see it, check:`);
    console.log(`      • Consumer group ID (should be different or same as producer)`);
    console.log(`      • Topic name matches`);
    console.log(`      • Consumer is actually running\n`);

    await producer.disconnect();
    console.log('✅ Producer disconnected');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error sending test message:', error);
    console.error('   Error details:', error.message);
    if (error.stack) {
      console.error('   Stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run the test
sendTestMessage();

