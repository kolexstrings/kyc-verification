/**
 * Test script for Innovatrics Passive Liveness (backend-only)
 * 
 * This script tests the passive liveness flow without interactive challenges:
 * 1. Creates a customer
 * 2. Uploads a selfie
 * 3. Initializes liveness record
 * 4. Evaluates passive liveness
 * 5. (Optional) Runs deepfake detection
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BASE_URL = process.env.INNOVATRICS_BASE_URL || 'https://dot.innovatrics.com/identity/api/v1';
const BEARER_TOKEN = process.env.INNOVATRICS_BEARER_TOKEN;
const HOST = process.env.INNOVATRICS_HOST || 'dot.innovatrics.com';

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${BEARER_TOKEN}`,
    'Content-Type': 'application/json',
    'Host': HOST
  },
  timeout: 60000,
  maxBodyLength: 50 * 1024 * 1024,
});

// Helper to create a minimal base64 test image (1x1 pixel)
function createTestSelfieBase64() {
  // Tiny 1x1 JPEG image
  return '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AAf/Z';
}

async function testPassiveLiveness() {
  let customerId;
  
  try {
    console.log('\n' + '='.repeat(70));
    console.log('TEST: Passive Liveness Flow (Backend-Only)');
    console.log('='.repeat(70));
    
    // Step 1: Create customer
    console.log('\n[1/5] Creating customer...');
    const customerResponse = await client.post('/customers');
    customerId = customerResponse.data.id;
    console.log('✓ Customer created:', customerId);
    
    // Step 2: Upload primary selfie
    console.log('\n[2/5] Uploading primary selfie...');
    const selfieBase64 = createTestSelfieBase64();
    await client.put(`/customers/${customerId}/selfie`, {
      image: {
        data: selfieBase64
      }
    });
    console.log('✓ Primary selfie uploaded');
    
    // Step 3: Initialize liveness record
    console.log('\n[3/5] Initializing liveness record...');
    await client.put(`/customers/${customerId}/liveness`);
    console.log('✓ Liveness record initialized');
    
    // Step 4: Evaluate passive liveness
    console.log('\n[4/5] Evaluating passive liveness...');
    const livenessPayload = {
      type: 'PASSIVE_LIVENESS'
    };
    console.log('Payload:', JSON.stringify(livenessPayload, null, 2));
    
    const livenessResponse = await client.post(
      `/customers/${customerId}/liveness/evaluation`,
      livenessPayload
    );
    
    console.log('✓ Passive liveness evaluation completed');
    console.log('\nLiveness Result:');
    console.log('  Status:', livenessResponse.data.status);
    console.log('  Confidence:', livenessResponse.data.confidence);
    console.log('  Full Response:', JSON.stringify(livenessResponse.data, null, 2));
    
    // Step 5: Test deepfake detection (extended evaluation)
    console.log('\n[5/5] Testing deepfake detection...');
    const deepfakePayload = {
      type: 'DEEPFAKE',
      livenessResources: ['PASSIVE']
    };
    console.log('Payload:', JSON.stringify(deepfakePayload, null, 2));
    
    const deepfakeResponse = await client.post(
      `/customers/${customerId}/liveness/evaluation/extended`,
      deepfakePayload
    );
    
    console.log('✓ Deepfake detection completed');
    console.log('\nDeepfake Result:');
    console.log('  Is Deepfake:', deepfakeResponse.data.isDeepfake);
    console.log('  Confidence:', deepfakeResponse.data.confidence);
    console.log('  Full Response:', JSON.stringify(deepfakeResponse.data, null, 2));
    
    // Success summary
    console.log('\n' + '='.repeat(70));
    console.log('✅ ALL TESTS PASSED!');
    console.log('='.repeat(70));
    console.log('\nSummary:');
    console.log('  Customer ID:', customerId);
    console.log('  Liveness Status:', livenessResponse.data.status);
    console.log('  Liveness Confidence:', livenessResponse.data.confidence);
    console.log('  Deepfake Detected:', deepfakeResponse.data.isDeepfake);
    console.log('  Deepfake Confidence:', deepfakeResponse.data.confidence);
    console.log('='.repeat(70) + '\n');
    
  } catch (error) {
    console.error('\n' + '='.repeat(70));
    console.error('❌ TEST FAILED');
    console.error('='.repeat(70));
    
    if (error.response) {
      console.error('\nAPI Error Details:');
      console.error('  Status:', error.response.status);
      console.error('  Status Text:', error.response.statusText);
      console.error('  Error Data:', JSON.stringify(error.response.data, null, 2));
      console.error('  Request URL:', error.config.url);
      console.error('  Request Method:', error.config.method);
    } else {
      console.error('\nError:', error.message);
    }
    
    console.error('='.repeat(70) + '\n');
    process.exit(1);
  }
}

// Run the test
console.log('\nStarting Passive Liveness Test...');
console.log('Base URL:', BASE_URL);
console.log('Host:', HOST);
console.log('Token configured:', !!BEARER_TOKEN);

testPassiveLiveness();
