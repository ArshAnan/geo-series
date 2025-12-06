// Helper script to test API credentials and find the correct base URL
require('dotenv').config();
const axios = require('axios');

async function testAPICredentials() {
  const baseURL = process.env.SERIES_API_BASE_URL;
  const apiKey = process.env.SERIES_API_KEY;

  console.log('🔍 Testing API Credentials...\n');

  if (!baseURL || !apiKey) {
    console.log('❌ Missing credentials in .env file\n');
    console.log('Please add to your .env file:');
    console.log('SERIES_API_BASE_URL=<base-url-from-docs>');
    console.log('SERIES_API_KEY=<your-api-key>\n');
    console.log('To find these values:');
    console.log('1. Base URL: Check the "Servers" dropdown in the API docs, or look for the service base URL');
    console.log('2. API Key: Check with hackathon organizers or your account dashboard\n');
    return;
  }

  console.log(`Base URL: ${baseURL}`);
  console.log(`API Key: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}\n`);

  // Test a simple endpoint to verify credentials
  const client = axios.create({
    baseURL: baseURL,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('🧪 Testing API connection...\n');

  // Try to list chats as a test
  try {
    console.log('Testing: GET /api/chats');
    const response = await client.get('/api/chats', { params: { page: 1, per_page: 1 } });
    console.log('✅ API connection successful!');
    console.log(`   Status: ${response.status}`);
    console.log(`   Response keys: ${Object.keys(response.data).join(', ')}\n`);
  } catch (error) {
    if (error.response) {
      console.log(`❌ API Error: ${error.response.status} ${error.response.statusText}`);
      console.log(`   Response: ${JSON.stringify(error.response.data, null, 2)}\n`);
      
      if (error.response.status === 401) {
        console.log('💡 This looks like an authentication error. Check your API key.');
      } else if (error.response.status === 404) {
        console.log('💡 Endpoint not found. The base URL might be incorrect.');
      }
    } else {
      console.log(`❌ Network Error: ${error.message}\n`);
      console.log('💡 Check if the base URL is correct and accessible.');
    }
  }
}

testAPICredentials();

