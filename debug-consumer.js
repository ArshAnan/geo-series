// Debug Kafka Consumer - Check what messages are coming through
require('dotenv').config();
const { Kafka } = require('kafkajs');

// Kafka Configuration
const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'debug-consumer',
  brokers: process.env.KAFKA_BROKERS.split(','),
  ssl: true,
  sasl: {
    mechanism: 'plain',
    username: process.env.KAFKA_SASL_USERNAME,
    password: process.env.KAFKA_SASL_PASSWORD
  }
});

const consumer = kafka.consumer({ 
  groupId: `debug-consumer-${Date.now()}` // Unique group ID to see all messages
});

const config = require('./config.json');

async function shouldProcessMessage(eventData) {
  const chatId = String(eventData.chat_id);
  const fromPhone = eventData.from_phone;
  const chatHandles = eventData.chat_handles || [];
  
  // Check phone numbers
  if (config.targetPhoneNumbers && config.targetPhoneNumbers.length > 0) {
    const allPhones = [fromPhone, ...chatHandles.map(h => h.identifier)].map(p => String(p).trim());
    const targetPhones = config.targetPhoneNumbers.map(p => String(p).trim());
    
    const hasTargetPhone = targetPhones.some(target => 
      allPhones.some(phone => {
        const match = phone === target || phone.includes(target) || target.includes(phone);
        return match;
      })
    );
    
    return hasTargetPhone;
  }
  
  return true; // If no filter, accept all
}

async function startDebug() {
  try {
    await consumer.connect();
    
    const topic = process.env.KAFKA_TOPIC;
    if (!topic) {
      throw new Error('KAFKA_TOPIC must be set in .env');
    }

    console.log('\n🔍 Debug Kafka Consumer Started\n');
    console.log('Configuration:');
    console.log(`  Topic: ${topic}`);
    console.log(`  Sender Phone (Hackathon Kafka): ${config.senderPhoneNumber || 'Not set'}`);
    console.log(`  Target Phone Numbers: ${JSON.stringify(config.targetPhoneNumbers)}`);
    console.log(`  Chat ID Filter: ${config.chatId || 'None'}`);
    console.log('\n📡 Listening for messages...\n');
    console.log('='.repeat(80));

    await consumer.subscribe({ 
      topic: topic,
      fromBeginning: false // Start from latest
    });

    let messageCount = 0;
    let processedCount = 0;
    let filteredCount = 0;

    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        try {
          messageCount++;
          const eventData = JSON.parse(message.value.toString());
          
          console.log(`\n📨 Message #${messageCount} received:`);
          console.log(`   Event Type: ${eventData.event_type}`);
          console.log(`   Event ID: ${eventData.event_id}`);
          
          // Only show message.received events
          if (eventData.event_type === 'message.received') {
            const data = eventData.data;
            console.log(`   Chat ID: ${data.chat_id}`);
            console.log(`   Message ID: ${data.id}`);
            console.log(`   From Phone: ${data.from_phone}`);
            console.log(`   Text: ${data.text ? (data.text.substring(0, 100) + (data.text.length > 100 ? '...' : '')) : '(no text)'}`);
            console.log(`   Chat Handles: ${JSON.stringify((data.chat_handles || []).map(h => h.identifier))}`);
            console.log(`   Service: ${data.service || 'Unknown'}`);
            console.log(`   Sent At: ${data.sent_at}`);
            
            // Check if it should be processed
            const shouldProcess = await shouldProcessMessage(data);
            const isGroupChat = (data.chat_handles || []).length > 1;
            console.log(`   Chat Type: ${isGroupChat ? '👥 Group Chat' : '💬 Individual Chat'}`);
            console.log(`   Should Process: ${shouldProcess ? '✅ YES' : '❌ NO'}`);
            
            if (shouldProcess) {
              processedCount++;
              console.log(`   ✅ This message WOULD BE PROCESSED by the main system`);
              if (isGroupChat) {
                console.log(`   👥 Group chat monitoring active - will extract key moments`);
              }
            } else {
              filteredCount++;
              console.log(`   ❌ This message would be FILTERED OUT`);
              console.log(`   Reason: Phone numbers don't match target list`);
              console.log(`   Target phones: ${JSON.stringify(config.targetPhoneNumbers)}`);
              const allPhones = [data.from_phone, ...(data.chat_handles || []).map(h => h.identifier)];
              console.log(`   Message phones: ${JSON.stringify(allPhones)}`);
            }
          } else {
            console.log(`   ⚠️  Event type "${eventData.event_type}" - not a message.received event`);
          }
          
          console.log('-'.repeat(80));
          
          // Show summary every 10 messages
          if (messageCount % 10 === 0) {
            console.log(`\n📊 Summary: ${messageCount} total messages, ${processedCount} would be processed, ${filteredCount} filtered out\n`);
          }
        } catch (error) {
          console.error('Error parsing message:', error);
          console.log('Raw message:', message.value.toString().substring(0, 200));
        }
      }
    });
  } catch (error) {
    console.error('Error in debug consumer:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down debug consumer...');
  await consumer.disconnect();
  process.exit(0);
});

startDebug().catch(console.error);
