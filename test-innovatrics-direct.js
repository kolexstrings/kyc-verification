// Quick test script to test Innovatrics API directly with a tiny image
const axios = require('axios');
const https = require('https');

// Tiny 1x1 pixel red PNG in base64 (only 95 bytes!)
const tinyImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function testInnovatrics() {
  const client = axios.create({
    baseURL: 'https://35.156.52.89/identity/api/v1',
    headers: {
      Authorization: 'Bearer RElTX2V2YWxfNjgyOk93RE81b3JONG9WeDFMV3ppbXY2djJ5UUdMWk9VWnJn',
      'Content-Type': 'application/json',
      Host: 'dot.innovatrics.com',
    },
    timeout: 60000,
    maxBodyLength: 50 * 1024 * 1024,
    maxContentLength: 50 * 1024 * 1024,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
    }),
  });

  try {
    console.log('Step 1: Creating customer...');
    const customerResponse = await client.post('/customers');
    const customerId = customerResponse.data.id;
    console.log('✅ Customer created:', customerId);

    console.log('\nStep 2: Creating document...');
    await client.put(`/customers/${customerId}/document`, {
      sources: ['VIZ', 'MRZ', 'DOCUMENT_PORTRAIT'],
    });
    console.log('✅ Document created');

    console.log('\nStep 3: Uploading tiny test image (95 bytes)...');
    const pageResponse = await client.put(`/customers/${customerId}/document/pages`, {
      image: {
        data: tinyImageBase64,
      },
      advice: {
        classification: {
          pageTypes: ['front'],
        },
      },
    });
    console.log('✅ Page uploaded successfully!');
    console.log('Response:', JSON.stringify(pageResponse.data, null, 2));

  } catch (error) {
    console.error('❌ Error:', error.response?.status, error.response?.data);
    console.error('Full error:', error.message);
  }
}

testInnovatrics();
