// Interactive Kafka Producer - Takes user input and sends messages to consumer
require('dotenv').config();
const { Kafka } = require('kafkajs');
const readline = require('readline');
const config = require('./config.json');

// Kafka Configuration (same as consumer)
const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'interactive-producer',
  brokers: process.env.KAFKA_BROKERS.split(','),
  ssl: true,
  sasl: {
    mechanism: 'plain',
    username: process.env.KAFKA_SASL_USERNAME,
    password: process.env.KAFKA_SASL_PASSWORD
  }
});

const producer = kafka.producer();

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to prompt user for input
function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function sendMessage(messageText, chatId, fromPhone, chatHandles) {
  try {
    const topic = process.env.KAFKA_TOPIC;
    if (!topic) {
      throw new Error('KAFKA_TOPIC must be set in .env');
    }

    // Create a message in the same format as Series API message.received events
    const message = {
      event_type: 'message.received',
      event_id: `interactive-event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      created_at: new Date().toISOString(),
      data: {
        id: `interactive-msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        chat_id: chatId || config.chatId || '1702657',
        from_phone: fromPhone || config.targetPhoneNumbers[0] || '+19294265300',
        text: messageText,
        sent_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
        delivery_status: 'delivered',
        is_read: false,
        service: 'iMessage',
        chat_handles: chatHandles || config.targetPhoneNumbers.map(phone => ({
          identifier: phone
        })),
        attachments: [],
        reactions: []
      }
    };

    console.log('\n📤 Sending message to Kafka...');
    console.log(`   Event Type: ${message.event_type}`);
    console.log(`   Event ID: ${message.event_id}`);
    console.log(`   Chat ID: ${message.data.chat_id}`);
    console.log(`   From Phone: ${message.data.from_phone}`);
    console.log(`   Text: "${message.data.text}"`);
    console.log(`   Chat Handles: ${message.data.chat_handles.map(h => h.identifier).join(', ')}\n`);

    const result = await producer.send({
      topic: topic,
      messages: [
        {
          key: message.event_id,
          value: JSON.stringify(message)
        }
      ]
    });

    console.log('✅ Message sent successfully!');
    console.log(`   Topic: ${result[0].topicName}`);
    console.log(`   Partition: ${result[0].partition}`);
    console.log(`   Offset: ${result[0].offset}\n`);
    
    return true;
  } catch (error) {
    console.error('❌ Error sending message:', error);
    console.error('   Error details:', error.message);
    if (error.stack) {
      console.error('   Stack:', error.stack);
    }
    return false;
  }
}

async function main() {
  try {
    console.log('\n🔌 Connecting to Kafka...');
    console.log(`   Brokers: ${process.env.KAFKA_BROKERS}`);
    console.log(`   Topic: ${process.env.KAFKA_TOPIC}`);
    console.log(`   Client ID: ${process.env.KAFKA_CLIENT_ID || 'interactive-producer'}\n`);
    
    await producer.connect();
    console.log('✅ Producer connected successfully!\n');

    console.log('📝 Interactive Kafka Producer');
    console.log('   Enter messages to send to the consumer');
    console.log('   Type "exit" or "quit" to stop\n');

    // Ask if user wants to customize chat settings
    const customize = await askQuestion('Use default chat settings from config.json? (y/n): ');
    let chatId = null;
    let fromPhone = null;
    let chatHandles = null;

    if (customize.toLowerCase() === 'n' || customize.toLowerCase() === 'no') {
      chatId = await askQuestion(`Chat ID (default: ${config.chatId || '1702657'}): `);
      if (!chatId.trim()) chatId = config.chatId || '1702657';
      
      fromPhone = await askQuestion(`From Phone (default: ${config.targetPhoneNumbers[0] || '+19294265300'}): `);
      if (!fromPhone.trim()) fromPhone = config.targetPhoneNumbers[0] || '+19294265300';
      
      const handlesInput = await askQuestion(`Chat Handles (comma-separated, default: ${config.targetPhoneNumbers.join(', ')}): `);
      if (handlesInput.trim()) {
        chatHandles = handlesInput.split(',').map(p => p.trim()).map(phone => ({
          identifier: phone
        }));
      } else {
        chatHandles = config.targetPhoneNumbers.map(phone => ({
          identifier: phone
        }));
      }
      
      console.log('\n✅ Settings configured:');
      console.log(`   Chat ID: ${chatId}`);
      console.log(`   From Phone: ${fromPhone}`);
      console.log(`   Chat Handles: ${chatHandles.map(h => h.identifier).join(', ')}\n`);
    } else {
      chatId = config.chatId || '1702657';
      fromPhone = config.targetPhoneNumbers[0] || '+19294265300';
      chatHandles = config.targetPhoneNumbers.map(phone => ({
        identifier: phone
      }));
      console.log('\n✅ Using default settings from config.json\n');
    }

    // Main loop - keep asking for messages
    while (true) {
      const messageText = await askQuestion('Enter message text (or "exit" to quit): ');
      
      if (!messageText.trim()) {
        console.log('⚠️  Message cannot be empty. Please enter a message.\n');
        continue;
      }

      if (messageText.toLowerCase() === 'exit' || messageText.toLowerCase() === 'quit') {
        console.log('\n👋 Exiting...\n');
        break;
      }

      const success = await sendMessage(messageText.trim(), chatId, fromPhone, chatHandles);
      
      if (success) {
        console.log('💡 Tip: Check your consumer logs to see if the message was received!\n');
      }
    }

    await producer.disconnect();
    console.log('✅ Producer disconnected');
    rl.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    console.error('   Error details:', error.message);
    if (error.stack) {
      console.error('   Stack:', error.stack);
    }
    rl.close();
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down...');
  try {
    await producer.disconnect();
    rl.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Run the interactive producer
main();
