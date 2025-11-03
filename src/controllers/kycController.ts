import { Request, Response } from 'express';
import { ResponseHandler } from '../utils/responseHandler';
import { normalizeImagePayload, NormalizedImage } from '../utils/image';
import {
  InnovatricsService,
  DocumentVerificationResult,
  InnovatricsImagePayload,
} from '../services/innovatricsClient';
import { uploadImageFromBuffer } from '../services/cloudinaryService';
import type { KycUploadRequestFiles } from '../middleware/kycUpload';
import sharp from 'sharp';
import {
  initializeOnboardingRecord,
  markFinished,
  recordDocumentResult,
  recordError,
  recordFaceComparison,
  recordFaceDetection,
  recordLivenessResult,
  recordRetry,
  recordSelfieResult,
} from '../services/onboardingPersistence';

const innovatricsClient = new InnovatricsService();

export interface KYCProfile {
  createdAt: number;
  phoneNumber: string;
  email: string;
  name: string;
  surname: string;
  dateOfBirth: string;
  cityOfBirth: string;
  firstNationality: string;
  secondNationality: string;
  countryOfBirth: string;
  address: string;
  residencePermit: string;
  proofOfAddress: string;
  plannedInvestmentPerYear: string;
  sourceOfFunds: string[];
  totalWealth: string;
  sourceOfWealth: string[];
  descriptionOfSourceOfFundsAndWealth: string;
  taxIDNumber: string;
  cryptoWallet: string;
  financialDocuments: string[];
  occupation: string;
  professionalStatus: string;
  worksFor: string;
  industry: string;
  cvOrResume: string;
  beneficialOwnership: string;
  pepStatus: string;
  identificationDocumentImage?: string[] | string;
  image?: string;
  selfieImages?: string[] | string;
  consentMessage: string;
  displayName?: string;
  about?: string;
  website?: string;
  userId?: string; // Application user ID for better tracking
  documentType?: 'passport' | 'id_card' | 'driver_license' | 'residence_permit' | 'visa' | 'other'; // All Innovatrics supported types
  challengeType?: 'passive' | 'motion' | 'expression'; // Optional liveness analysis type
}

export interface KYCVerificationResult {
  customerId: string;
  documentVerification?: DocumentVerificationResult;
  selfieUpload?: {
    id: string;
  };
  faceDetection?: {
    id: string;
    detection: {
      score: number;
      boundingBox: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    };
    maskResult: {
      score: number;
    };
  };
  livenessCheck?: {
    confidence: number;
    status: string;
    isDeepfake?: boolean;
    deepfakeConfidence?: number;
  };
  faceComparison?: {
    score: number;
  };
  overallStatus: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

export class KYCVerificationController {
  static async processKYCProfile(req: Request, res: Response) {
    let customerId: string | null = null;

    try {
      const files = (req.files as KycUploadRequestFiles | undefined) ?? {};
      const kycData: KYCProfile = req.body;
      const documentImagesFromBody = toStringArray(kycData.identificationDocumentImage);
      const selfieImagesFromBody = toStringArray(kycData.selfieImages);

      const hasDocumentFront = Boolean(files.documentFront?.length || documentImagesFromBody[0]);
      const hasPrimarySelfie = Boolean(files.selfiePrimary?.length || kycData.image);

      if (!hasDocumentFront || !hasPrimarySelfie) {
        return ResponseHandler.validationError(res, [
          !hasDocumentFront ? 'Document front image must be provided as a file or base64 string' : undefined,
          !hasPrimarySelfie ? 'Primary selfie image must be provided as a file or base64 string' : undefined,
        ].filter((msg): msg is string => Boolean(msg)));
      }

      // Step 1: Create customer (Innovatrics generates UUID)
      const customer = await innovatricsClient.createCustomer();

      const externalId = kycData.userId || `${kycData.name}_${kycData.surname}_${Date.now()}`;
      const userIdForTracking = kycData.userId || externalId;

      // Step 2: Store customer in Trust Platform with external ID
      await innovatricsClient.storeCustomer(customer.id, {
        externalId,
        onboardingStatus: 'IN_PROGRESS'
      });

      await initializeOnboardingRecord({
        userId: userIdForTracking,
        externalId,
        innovatricsCustomerId: customer.id,
      });

      customerId = customer.id;
      const results: KYCVerificationResult = {
        customerId,
        overallStatus: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      try {
        // Step 2: Document verification (handle multiple documents)
        const documentFront = await resolveImageSource({
          file: files.documentFront?.[0],
          base64: documentImagesFromBody[0],
          defaultFileName: `${userIdForTracking}_document_front`,
          tags: ['kyc', 'document', 'front'],
        });

        if (!documentFront) {
          throw new Error('Document front image could not be processed');
        }

        const documentBack = await resolveImageSource({
          file: files.documentBack?.[0],
          base64: documentImagesFromBody[1],
          defaultFileName: `${userIdForTracking}_document_back`,
          tags: ['kyc', 'document', 'back'],
        });

        const documentResult = await innovatricsClient.verifyDocument({
          customerId,
          frontImage: documentFront.innovatrics,
          ...(documentBack ? { backImage: documentBack.innovatrics } : {}),
          ...(kycData.documentType ? { documentType: kycData.documentType } : {}),
          ...(kycData.firstNationality ? { issuingCountry: kycData.firstNationality } : {}),
          onRetry: ({ stage, attempt, delayMs, error }) => {
            void recordRetry(customerId!, {
              reason: `document_${stage}`,
              context: {
                attempt,
                delayMs,
                message: error?.message,
                status: error?.response?.status,
              },
            }).catch(() => undefined);
          },
        });

        results.documentVerification = documentResult;
        await recordDocumentResult(customerId, {
          documentResult,
          images: documentBack
            ? { front: documentFront.normalized, back: documentBack.normalized }
            : { front: documentFront.normalized },
        });

        // Step 3: Upload main selfie
        const primarySelfieSource = await resolveImageSource({
          file: files.selfiePrimary?.[0],
          base64: kycData.image,
          defaultFileName: `${userIdForTracking}_selfie_primary`,
          tags: ['kyc', 'selfie', 'primary'],
        });

        if (!primarySelfieSource) {
          throw new Error('Primary selfie image could not be processed');
        }

        const selfieResult = await innovatricsClient.uploadSelfie(
          customerId,
          primarySelfieSource.innovatrics
        );
        results.selfieUpload = selfieResult;
        await recordSelfieResult(customerId, {
          selfieResult,
          image: primarySelfieSource.normalized,
        });

        // Step 4: Face detection with mask check
        const faceResult = await innovatricsClient.detectFace(primarySelfieSource.innovatrics);
        const maskResult = await innovatricsClient.checkFaceMask(faceResult.id);

        results.faceDetection = {
          id: faceResult.id,
          detection: faceResult.detection,
          maskResult
        };
        await recordFaceDetection(customerId, {
          faceResult,
          maskResult,
          image: primarySelfieSource.normalized,
        });

        // Step 5: Liveness check with deepfake detection (using first selfie image)
        const supplementalSelfieSource = await resolveImageSource({
          file: files.selfieImages?.[0],
          base64: selfieImagesFromBody[0],
          defaultFileName: `${userIdForTracking}_selfie_liveness_1`,
          tags: ['kyc', 'selfie', 'liveness'],
        });

        if (supplementalSelfieSource) {
          // First, upload the selfie
          // TODO: persist additional selfie uploads once schema supports multi-frame storage
          await innovatricsClient.uploadSelfie(customerId, supplementalSelfieSource.innovatrics);

          // Then evaluate liveness with deepfake detection
          // TODO: surface liveness challenge metadata (challengeId/instructions) for persistence
          const livenessResult = await innovatricsClient.evaluateLiveness(customerId, {
            challengeType: kycData.challengeType || 'passive',
            deepfakeCheck: true // Enable deepfake detection
          });

          // Store the liveness results
          results.livenessCheck = {
            confidence: livenessResult.confidence,
            status: livenessResult.status,
            ...(livenessResult.isDeepfake !== undefined && { 
              isDeepfake: livenessResult.isDeepfake,
              deepfakeConfidence: livenessResult.deepfakeConfidence 
            })
          };

          await recordLivenessResult(customerId, {
            livenessResult,
            image: supplementalSelfieSource.normalized,
          });
        }

        // Step 6: Face comparison between document face and selfie
        if (results.faceDetection && results.selfieUpload) {
          const faceTemplate = await innovatricsClient.getFaceTemplate(faceResult.id);

          const comparisonResult = await innovatricsClient.compareFaces(faceResult.id, {
            referenceFaceTemplate: faceTemplate.data
          });

          results.faceComparison = comparisonResult;
          await recordFaceComparison(customerId, {
            comparisonResult,
            image: primarySelfieSource.normalized,
          });
        }

        // Update overall status
        results.overallStatus = 'completed';
        results.updatedAt = new Date();

        await markFinished(customerId);
        await innovatricsClient.storeCustomer(customerId, {
          externalId,
          onboardingStatus: 'FINISHED',
        });

        return ResponseHandler.success(res, results, 'KYC verification completed successfully');

      } catch (verificationError: any) {
        // If verification fails, still return partial results
        results.overallStatus = 'failed';
        results.updatedAt = new Date();

        console.error('KYC verification error:', verificationError);
        const errorPayload: Parameters<typeof recordError>[1] = {
          message: verificationError?.message ?? 'Verification failed',
          markFailed: true,
          context:
            verificationError?.response?.data ?? {
              message: verificationError?.message,
            },
        };

        if (verificationError?.response?.status) {
          errorPayload.code = String(verificationError.response.status);
        }

        await recordError(customerId, errorPayload).catch(() => undefined);
        return ResponseHandler.error(res, 'KYC verification failed', 500, verificationError.message);
      }

    } catch (error: any) {
      console.error('KYC processing error:', error);
      if (customerId) {
        const errorPayload: Parameters<typeof recordError>[1] = {
          message: error?.message ?? 'Processing failed',
          markFailed: true,
          context:
            error?.response?.data ?? {
              message: error?.message,
            },
        };

        if (error?.response?.status) {
          errorPayload.code = String(error.response.status);
        }

        await recordError(customerId, errorPayload).catch(() => undefined);
      }
      return ResponseHandler.error(res, 'Failed to process KYC profile', 500, error.message);
    }
  }
}

interface ResolveImageOptions {
  file?: Express.Multer.File | undefined;
  base64?: string | undefined;
  defaultFileName: string;
  tags?: string[] | undefined;
}

interface ResolvedImageSource {
  normalized: NormalizedImage;
  innovatrics: InnovatricsImagePayload;
}

async function resolveImageSource(options: ResolveImageOptions): Promise<ResolvedImageSource | null> {
  const { file, base64, defaultFileName, tags } = options;

  let buffer: Buffer | null = null;
  let mimeType: string | undefined;

  if (file && file.buffer) {
    buffer = file.buffer;
    mimeType = file.mimetype;
  } else if (base64) {
    const normalized = normalizeImagePayload(base64);
    if (!normalized.base64) {
      return null;
    }
    buffer = Buffer.from(normalized.base64, 'base64');
    mimeType = normalized.mimeType;
  }

  if (!buffer) {
    return null;
  }

  // Get image metadata first
  const metadata = await sharp(buffer).metadata();
  console.log(`Original image: ${metadata.width}x${metadata.height}, format: ${metadata.format}, size: ${buffer.length} bytes`);
  
  // Resize image to max 1500x1500 first (conservative test)
  // Will increase if this works
  const resizedBuffer = await sharp(buffer)
    .resize(1500, 1500, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ 
      quality: 85,
      mozjpeg: true, // Use mozjpeg for better compression
    })
    .toBuffer();
  
  const resizedMetadata = await sharp(resizedBuffer).metadata();
  console.log(`Resized image: ${resizedMetadata.width}x${resizedMetadata.height}, size: ${resizedBuffer.length} bytes`);

  const uploadOptions: Parameters<typeof uploadImageFromBuffer>[2] = {};
  if (tags && tags.length > 0) {
    uploadOptions.tags = tags;
  }

  const uploadResult = await uploadImageFromBuffer(
    resizedBuffer, // Upload resized version to Cloudinary
    generateUploadFileName(file, defaultFileName),
    uploadOptions
  );

  // Convert resized buffer to base64 for Innovatrics (they don't support URLs for documents)
  const base64Data = resizedBuffer.toString('base64');

  const normalized: NormalizedImage = {
    url: uploadResult.secureUrl,
    publicId: uploadResult.publicId,
    format: uploadResult.format,
    bytes: resizedBuffer.length, // Use resized buffer size
    resourceType: 'image',
    base64: base64Data,
    ...(mimeType ? { mimeType: 'image/jpeg' } : { mimeType: 'image/jpeg' }), // Sharp outputs JPEG
    ...(uploadResult.width ? { width: uploadResult.width } : {}),
    ...(uploadResult.height ? { height: uploadResult.height } : {}),
  };

  return {
    normalized,
    innovatrics: base64Data, // Send base64 string directly
  };
}

function generateUploadFileName(file: Express.Multer.File | undefined, fallback: string): string {
  if (file && file.originalname) {
    return file.originalname;
  }
  return fallback;
}

function toStringArray(input?: string[] | string): string[] {
  if (!input) {
    return [];
  }

  return Array.isArray(input) ? input : [input];
}
