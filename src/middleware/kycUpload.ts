import multer from 'multer';
import type { RequestHandler } from 'express';

const memoryStorage = multer.memoryStorage();

export const kycUploadFields = [
  { name: 'documentFront', maxCount: 1 },
  { name: 'documentBack', maxCount: 1 },
  { name: 'selfiePrimary', maxCount: 1 },
  { name: 'selfieImages', maxCount: 5 },
] as const;

const rawUploadHandler = multer({
  storage: memoryStorage,
  limits: {
    files: 8,
    fileSize: 20 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    cb(null, true);
  },
}).fields(kycUploadFields as unknown as multer.Field[]);

export const uploadKycMedia = rawUploadHandler as unknown as RequestHandler;

export type KycUploadRequestFiles = {
  documentFront?: Express.Multer.File[];
  documentBack?: Express.Multer.File[];
  selfiePrimary?: Express.Multer.File[];
  selfieImages?: Express.Multer.File[];
};
