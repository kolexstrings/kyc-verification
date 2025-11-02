import { Request, Response } from 'express';
import { ResponseHandler } from '../utils/responseHandler';
import { InnovatricsService, DocumentVerificationResult } from '../services/innovatricsClient';

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

      // Step 2: Store customer in Trust Platform with external ID
      await innovatricsClient.storeCustomer(customer.id, {
        externalId,
        onboardingStatus: 'IN_PROGRESS'
      });

      const customerId = customer.id;
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
          });

          results.documentVerification = documentResult;
        }

        // Step 3: Upload main selfie
        const selfieResult = await innovatricsClient.uploadSelfie(customerId, kycData.image);
        results.selfieUpload = selfieResult;

        // Step 4: Face detection with mask check
        const faceResult = await innovatricsClient.detectFace(kycData.image);
        const maskResult = await innovatricsClient.checkFaceMask(faceResult.id);

        results.faceDetection = {
          id: faceResult.id,
          detection: faceResult.detection,
          maskResult
        };

        // Step 5: Liveness check with deepfake detection (using first selfie image)
        if (kycData.selfieImages.length > 0) {
          // First, upload the selfie
          await innovatricsClient.uploadSelfie(customerId, kycData.selfieImages[0]);
          
          // Then evaluate liveness with deepfake detection
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
        }

        // Step 6: Face comparison between document face and selfie
        if (results.faceDetection && results.selfieUpload) {
          const faceTemplate = await innovatricsClient.getFaceTemplate(faceResult.id);

          const comparisonResult = await innovatricsClient.compareFaces(faceResult.id, {
            referenceFaceTemplate: faceTemplate.data
          });

          results.faceComparison = comparisonResult;
        }

        // Update overall status
        results.overallStatus = 'completed';
        results.updatedAt = new Date();

        return ResponseHandler.success(res, results, 'KYC verification completed successfully');

      } catch (verificationError: any) {
        // If verification fails, still return partial results
        results.overallStatus = 'failed';
        results.updatedAt = new Date();

        console.error('KYC verification error:', verificationError);
        return ResponseHandler.error(res, 'KYC verification failed', 500, verificationError.message);
      }

    } catch (error: any) {
      console.error('KYC processing error:', error);
      return ResponseHandler.error(res, 'Failed to process KYC profile', 500, error.message);
    }
  }
}
