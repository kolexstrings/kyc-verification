import type { RequestHandler } from 'express';

/**
 * Base64-only KYC flow: no multipart uploads required. This middleware is a no-op
 * placeholder so route wiring remains compatible with the multipart-based project.
 */
export const uploadKycMedia: RequestHandler = (_req, _res, next) => {
  next();
};

export type KycUploadRequestFiles = Record<string, never>;
