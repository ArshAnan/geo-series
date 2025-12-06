// Topic Setup - Creates internal Kafka topics if they don't exist
require('dotenv').config();
const { Kafka } = require('kafkajs');

const INTERNAL_TOPICS = [
  'imessage-raw',
  'imessage-processed',
  'key-moments'
];

async function ensureTopicsExist() {
  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'imessage-logger-admin',
    brokers: process.env.KAFKA_BROKERS.split(','),
    ssl: true,
    sasl: {
      mechanism: 'plain',
      username: process.env.KAFKA_SASL_USERNAME,
      password: process.env.KAFKA_SASL_PASSWORD
    }
  });

  const admin = kafka.admin();
  
  try {
    await admin.connect();
    console.log('Connected to Kafka admin client');

    // List existing topics
    const existingTopics = await admin.listTopics();
    console.log('Existing topics:', existingTopics);

    // Create topics that don't exist
    const topicsToCreate = INTERNAL_TOPICS.filter(topic => !existingTopics.includes(topic));
    
    if (topicsToCreate.length === 0) {
      console.log('All internal topics already exist');
      return;
    }

    console.log(`Creating topics: ${topicsToCreate.join(', ')}`);
    
    const createResult = await admin.createTopics({
      topics: topicsToCreate.map(topic => ({
        topic: topic,
        numPartitions: 1
        // Don't specify replicationFactor - let the cluster decide (required for Confluent Cloud)
      })),
      waitForLeaders: true,
      timeout: 30000
    });

    console.log('✓ Topics created successfully');
    return true;
  } catch (error) {
    // If topic creation fails (e.g., no permissions), log warning
    if (error.type === 'UNKNOWN_TOPIC_OR_PARTITION' || error.message.includes('TopicExistsException')) {
      console.warn('Topic creation failed (topics may already exist or auto-creation enabled):', error.message);
      return false;
    } else if (error.message && error.message.includes('authorization')) {
      console.warn('⚠ Topic creation requires admin permissions. Topics may need to be created manually.');
      console.warn('Required topics:', INTERNAL_TOPICS.join(', '));
      return false;
    } else {
      console.warn('Could not create topics:', error.message);
      console.warn('Topics may need manual creation or auto-creation enabled.');
      console.warn('Required topics:', INTERNAL_TOPICS.join(', '));
      return false;
    }
  } finally {
    await admin.disconnect();
  }
}

module.exports = { ensureTopicsExist, INTERNAL_TOPICS };

