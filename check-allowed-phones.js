// Script to check which phone numbers are allowed for this team
require('dotenv').config();
const SeriesAPIClient = require('./api-client');

async function checkAllowedPhones() {
  try {
    const apiClient = new SeriesAPIClient();
    
    if (!apiClient.enabled) {
      console.error('❌ API client is not enabled. Please set SERIES_API_BASE_URL and SERIES_API_KEY in .env');
      process.exit(1);
    }

    console.log('🔍 Checking allowed phone numbers for your team...\n');

    // Try to list chats to see what phone numbers are associated with this team
    try {
      console.log('Fetching chats to see associated phone numbers...\n');
      const chats = await apiClient.listChats(null, 1, 100);
      
      if (chats && chats.data && chats.data.length > 0) {
        const allPhones = new Set();
        chats.data.forEach(chat => {
          if (chat.chat_handles) {
            chat.chat_handles.forEach(handle => {
              if (handle.phone_number) {
                allPhones.add(handle.phone_number);
              }
            });
          }
        });
        
        console.log(`✅ Found ${allPhones.size} unique phone numbers in your chats:`);
        Array.from(allPhones).sort().forEach((phone, idx) => {
          console.log(`   ${idx + 1}. ${phone}`);
        });
      } else {
        console.log('⚠️  No chats found. This might mean:');
        console.log('   - No phone numbers have been used yet');
        console.log('   - You need to check with hackathon organizers for allowed numbers');
      }
    } catch (error) {
      console.error('Error fetching chats:', error.message);
    }

    // Test individual phone numbers
    const testPhones = ['+16463458837', '+19294265300', '+12014927092'];
    console.log('\n🧪 Testing individual phone numbers...\n');
    
    for (const phone of testPhones) {
      try {
        // Try to check iMessage availability as a way to test if number is accessible
        await apiClient.checkiMessageAvailability(phone);
        console.log(`✅ ${phone} - Accessible`);
      } catch (error) {
        if (error.response?.status === 403 || error.response?.status === 401) {
          console.log(`❌ ${phone} - Not allowed for this team (${error.response.status})`);
        } else {
          console.log(`⚠️  ${phone} - Error: ${error.message}`);
        }
      }
    }

    console.log('\n💡 Tip: Only use phone numbers that are registered/allowed for your team.');
    console.log('   Contact hackathon organizers if you need to add phone numbers.\n');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

checkAllowedPhones();
