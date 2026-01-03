import path from 'path';
import dotenv from 'dotenv';

const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

export const config = {
  port: process.env.PORT || 3000,
  innovatrics: {
    baseUrl: process.env.INNOVATRICS_BASE_URL || 'http://localhost:8080/api/v1',
    bearerToken: process.env.INNOVATRICS_BEARER_TOKEN || '',
    host: process.env.INNOVATRICS_HOST || 'localhost:8080',
  },
  features: {
    useInnovatricsWorkflow:
      (process.env.USE_INNOVATRICS_WORKFLOW || '').toLowerCase() === 'true',
  },
};
