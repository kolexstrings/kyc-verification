import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ResponseHandler } from '../utils/responseHandler';
import { InnovatricsService, DocumentVerificationResult } from '../services/innovatricsClient';
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

function toJsonValue(value: unknown): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
  if (value === undefined || value === null) {
    return Prisma.JsonNull;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  try {
    const normalized = JSON.parse(JSON.stringify(value));
    if (normalized === null) {
      return Prisma.JsonNull;
    }

    return normalized as Prisma.InputJsonValue;
  } catch (serializationError) {
    console.warn('Failed to serialize value for onboarding persistence', serializationError);
    return Prisma.JsonNull;
  }
}

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
  identificationDocumentImage: string[];
  image: string;
  selfieImages: string[];
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
      const kycData: KYCProfile = req.body;

      if (!kycData.identificationDocumentImage?.length || !kycData.image) {
        return ResponseHandler.validationError(res, [
          'identificationDocumentImage and image are required'
        ]);
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
        if (kycData.identificationDocumentImage.length >= 1) {
          const frontImage = kycData.identificationDocumentImage[0];
          const backImage = kycData.identificationDocumentImage[1]; // Optional back image

          const documentResult = await innovatricsClient.verifyDocument({
            customerId,
            frontImage,
            ...(backImage ? { backImage } : {}),
            ...(kycData.documentType ? { documentType: kycData.documentType } : {}),
            ...(kycData.firstNationality ? { issuingCountry: kycData.firstNationality } : {}),
            onRetry: ({ stage, attempt, delayMs, error }) => {
              void recordRetry(customerId!, {
                reason: `document_${stage}`,
                context: toJsonValue({
                  attempt,
                  delayMs,
                  message: error?.message,
                  status: error?.response?.status,
                }),
              }).catch(() => undefined);
            },
          });

          results.documentVerification = documentResult;
          await recordDocumentResult(customerId, documentResult);
        }

        // Step 3: Upload main selfie
        const selfieResult = await innovatricsClient.uploadSelfie(customerId, kycData.image);
        results.selfieUpload = selfieResult;
        await recordSelfieResult(customerId, toJsonValue(selfieResult));

        // Step 4: Face detection with mask check
        const faceResult = await innovatricsClient.detectFace(kycData.image);
        const maskResult = await innovatricsClient.checkFaceMask(faceResult.id);

        results.faceDetection = {
          id: faceResult.id,
          detection: faceResult.detection,
          maskResult
        };
        await recordFaceDetection(customerId, toJsonValue(faceResult), toJsonValue(maskResult));

        // Step 5: Liveness check with deepfake detection (using first selfie image)
        if (kycData.selfieImages.length > 0) {
          // First, upload the selfie
          // TODO: persist additional selfie uploads once schema supports multi-frame storage
          await innovatricsClient.uploadSelfie(customerId, kycData.selfieImages[0]);
          
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

          await recordLivenessResult(customerId, toJsonValue(livenessResult));
        }

        // Step 6: Face comparison between document face and selfie
        if (results.faceDetection && results.selfieUpload) {
          const faceTemplate = await innovatricsClient.getFaceTemplate(faceResult.id);

          const comparisonResult = await innovatricsClient.compareFaces(faceResult.id, {
            referenceFaceTemplate: faceTemplate.data
          });

          results.faceComparison = comparisonResult;
          await recordFaceComparison(customerId, toJsonValue(comparisonResult));
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
          context: toJsonValue(
            verificationError?.response?.data ?? {
              message: verificationError?.message,
            }
          ),
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
          context: toJsonValue(
            error?.response?.data ?? {
              message: error?.message,
            }
          ),
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
