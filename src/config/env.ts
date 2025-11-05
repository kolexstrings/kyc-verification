import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  innovatrics: {
    baseUrl:
      process.env.INNOVATRICS_BASE_URL ||
      'https://dot.innovatrics.com/identity/api/v1',
    bearerToken: process.env.INNOVATRICS_BEARER_TOKEN || '',
    host: process.env.INNOVATRICS_HOST || 'dot.innovatrics.com',
  },
};
