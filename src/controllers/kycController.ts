import { Request, Response } from 'express';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { ResponseHandler } from '../utils/responseHandler';
import { normalizeImagePayload, NormalizedImage } from '../utils/image';
import {
  InnovatricsService,
  DocumentVerificationResult,
  InnovatricsImagePayload,
} from '../services/innovatricsClient';
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

const FACE_MATCH_SUCCESS_THRESHOLD = 0.64;
const LIVENESS_SUCCESS_STATUS = 'live';

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
  documentType?:
    | 'passport'
    | 'id_card'
    | 'driver_license'
    | 'residence_permit'
    | 'visa'
    | 'other'; // All Innovatrics supported types
  challengeType?: 'passive' | 'motion' | 'expression'; // Optional liveness analysis type
}

export interface KYCVerificationResult {
  customerId: string;
  externalId: string;
  userId?: string;
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

interface NostrEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

function buildAcceptedUserEvent(pubkey: string, content: string): NostrEvent {
  const createdAt = Math.floor(Date.now() / 1000);
  return {
    kind: 3,
    created_at: createdAt,
    tags: [['p', pubkey, 'wss://clientnode.com/', 'user']],
    content,
  };
}

function buildDeclinedUserEvent(
  pubkey: string,
  userId: string | undefined,
  reason: string,
  content: string
): NostrEvent {
  const createdAt = Math.floor(Date.now() / 1000);
  const eventId = userId ?? pubkey;
  return {
    kind: 1984,
    created_at: createdAt,
    tags: [
      ['e', eventId, reason || 'insufficient Information'],
      ['p', pubkey],
    ],
    content,
  };
}

export class KYCVerificationController {
  static async processKYCProfile(req: Request, res: Response) {
    let customerId: string | null = null;
    let userPubKey =
      typeof (req.body as any)?.userId === 'string'
        ? (req.body as any).userId.trim()
        : '';

    try {
      const kycData: KYCProfile = req.body;
      const documentImagesFromBody = toStringArray(
        kycData.identificationDocumentImage
      );
      const selfieImagesFromBody = toStringArray(kycData.selfieImages);

      const hasDocumentFront = Boolean(documentImagesFromBody[0]);
      const hasPrimarySelfie = Boolean(kycData.image);

      if (!hasDocumentFront || !hasPrimarySelfie) {
        return ResponseHandler.validationError(
          res,
          [
            !hasDocumentFront
              ? 'Document front image must be provided as a base64 string'
              : undefined,
            !hasPrimarySelfie
              ? 'Primary selfie image must be provided as a base64 string'
              : undefined,
          ].filter((msg): msg is string => Boolean(msg))
        );
      }

      // Step 1: Create customer (Innovatrics generates UUID)
      console.log('\n' + '='.repeat(70));
      console.log('STEP 1: Creating customer in Innovatrics');
      console.log('='.repeat(70));
      const customer = await innovatricsClient.createCustomer();
      customerId = customer.id;
      console.log('\nSUCCESS: Customer created with ID:', customerId);
      console.log('='.repeat(70) + '\n');

      const providedUserId =
        typeof kycData.userId === 'string' ? kycData.userId.trim() : '';
      const externalId =
        providedUserId || `${kycData.name}_${kycData.surname}_${Date.now()}`;
      const userIdForTracking = externalId;
      userPubKey = userIdForTracking;

      // Step 2: Store customer in Trust Platform with external ID
      console.log('Linking Innovatrics customer to external platform ID', {
        innovatricsCustomerId: customer.id,
        externalId,
        onboardingStatus: 'IN_PROGRESS',
      });
      await innovatricsClient.storeCustomer(customer.id, {
        externalId,
        onboardingStatus: 'IN_PROGRESS',
      });
      console.log('Innovatrics acknowledged customer linkage');

      await initializeOnboardingRecord({
        userId: userIdForTracking,
        externalId,
        innovatricsCustomerId: customer.id,
      });

      const results: KYCVerificationResult = {
        customerId,
        externalId,
        ...(providedUserId ? { userId: providedUserId } : {}),
        overallStatus: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      try {
        // Step 2: Document verification (handle multiple documents)
        console.log('\n' + '='.repeat(70));
        console.log('STEP 2: Uploading and verifying document pages');
        console.log('='.repeat(70));
        const documentFront = await resolveImageSource({
          base64: documentImagesFromBody[0],
          defaultFileName: `${userIdForTracking}_document_front`,
          tags: ['kyc', 'document', 'front'],
          kind: 'document',
        });

        if (!documentFront) {
          throw new Error('Document front image could not be processed');
        }

        const documentBack = await resolveImageSource({
          base64: documentImagesFromBody[1],
          defaultFileName: `${userIdForTracking}_document_back`,
          tags: ['kyc', 'document', 'back'],
          kind: 'document',
        });
        const documentFrontBase64 = extractBase64Payload(documentFront.innovatrics);
        let documentFrontBuffer: Buffer | null = null;
        try {
          documentFrontBuffer = Buffer.from(documentFrontBase64, 'base64');
        } catch (error: any) {
          console.warn('Failed to decode document front payload before diagnostics', {
            message: error?.message,
          });
        }

        if (documentFrontBuffer) {
          console.log('Document front payload diagnostics', {
            bytes: documentFrontBuffer.length,
            sha256: createHash('sha256').update(documentFrontBuffer).digest('hex'),
            sample: documentFrontBase64.slice(0, 32),
            suffix: documentFrontBase64.slice(-32),
          });
        }

        let documentBackBase64: string | undefined;
        if (documentBack?.innovatrics) {
          try {
            documentBackBase64 = extractBase64Payload(documentBack.innovatrics);
            const documentBackBuffer = Buffer.from(documentBackBase64, 'base64');
            console.log('Document back payload diagnostics', {
              bytes: documentBackBuffer.length,
              sha256: createHash('sha256').update(documentBackBuffer).digest('hex'),
              sample: documentBackBase64.slice(0, 32),
              suffix: documentBackBase64.slice(-32),
            });
          } catch (error: any) {
            documentBackBase64 = undefined;
            console.warn('Failed to decode document back payload before diagnostics', {
              message: error?.message,
            });
          }
        }

        const documentResult = await innovatricsClient.verifyDocument({
          customerId,
          frontImage: documentFrontBase64,
          ...(documentBackBase64 ? { backImage: documentBackBase64 } : {}),
          ...(kycData.documentType
            ? { documentType: kycData.documentType }
            : {}),
          ...(kycData.firstNationality
            ? { issuingCountry: kycData.firstNationality }
            : {}),
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
        console.log('\nSUCCESS: Document verified');
        console.log('   Pages processed successfully');
        console.log(
          '   Document inspection snapshot:',
          JSON.stringify(documentResult.inspection, null, 2),
        );
        console.log(
          '   Disclosed inspection snapshot:',
          JSON.stringify(documentResult.disclosedInspection, null, 2),
        );
        if (!documentResult?.inspection?.documentPortrait) {
          console.warn('   Inspection missing documentPortrait block.');
        }
        if (!documentResult?.disclosedInspection?.documentPortrait) {
          console.warn('   Disclosed inspection missing documentPortrait block.');
        }
        const frontPageData =
          documentResult.pages?.find(page => page.pageType === 'front') ??
          documentResult.pages?.[0];
        if (frontPageData) {
          console.log(
            '   Document front page metadata:',
            JSON.stringify(frontPageData, null, 2)
          );
        }
        console.log('='.repeat(70) + '\n');

        await recordDocumentResult(customerId, {
          documentResult,
          images: documentBack
            ? { front: documentFront.normalized, back: documentBack.normalized }
            : { front: documentFront.normalized },
        });

        // Step 3: Upload main selfie
        console.log('\n' + '='.repeat(70));
        console.log('STEP 3: Uploading selfie image');
        console.log('='.repeat(70));
        const primarySelfieSource = await resolveImageSource({
          base64: kycData.image,
          defaultFileName: `${userIdForTracking}_selfie_primary`,
          tags: ['kyc', 'selfie', 'primary'],
          kind: 'selfie',
        });

        if (!primarySelfieSource) {
          throw new Error('Primary selfie image could not be processed');
        }

        // Extract and sanitize selfie payload ONCE for consistent use
        const selfieInnovatricsPayload = extractBase64Payload(
          primarySelfieSource.innovatrics
        );

        if (!selfieInnovatricsPayload) {
          throw new Error('Primary selfie payload missing after processing');
        }

        const selfieSanitized = selfieInnovatricsPayload.replace(/\s+/g, '');

        // Use sanitized payload for BOTH uploadSelfie and detectFace
        await innovatricsClient.uploadSelfie(
          customerId,
          selfieSanitized
        );
        console.log('\nSUCCESS: Selfie uploaded');
        console.log('='.repeat(70) + '\n');

        const selfieResult = {
          id: customerId,
        };
        results.selfieUpload = selfieResult;
        await recordSelfieResult(customerId, {
          selfieResult,
          image: primarySelfieSource.normalized,
        });
        let selfieBuffer: Buffer | null = null;
        try {
          selfieBuffer = Buffer.from(selfieSanitized, 'base64');
        } catch (error: any) {
          console.warn(
            'Failed to decode primary selfie payload before detection',
            {
              message: error?.message,
            }
          );
        }

        if (selfieBuffer) {
          console.log('Primary selfie payload diagnostics', {
            bytes: selfieBuffer.length,
            sha256: createHash('sha256').update(selfieBuffer).digest('hex'),
            sample: selfieSanitized.slice(0, 32),
            suffix: selfieSanitized.slice(-32),
          });
        }

        // Step 4: Face detection with mask check
        const faceResult = await innovatricsClient.detectFace(selfieSanitized);
        console.log('Primary selfie face detection result:', {
          id: faceResult.id,
          detection: faceResult.detection,
        });
        const maskResult = await innovatricsClient.checkFaceMask(faceResult.id);

        results.faceDetection = {
          id: faceResult.id,
          detection: faceResult.detection,
          maskResult,
        };
        console.log('\nSUCCESS: Face detection completed');
        console.log('='.repeat(70) + '\n');
        await recordFaceDetection(customerId, {
          faceResult,
          maskResult,
          image: primarySelfieSource.normalized,
        });

        // Step 5: Face comparison using Innovatrics inspectCustomer
        // This uses the face Innovatrics already detected during document verification
        console.log('\n' + '='.repeat(70));
        console.log('STEP 5: Comparing document photo with selfie');
        console.log('='.repeat(70));
        
        console.log('Using Innovatrics customer inspection for face comparison...');
        let faceMatchScore: number | null = null;
        const faceMatchScores: number[] = [];
        let comparisonStrategy: 'inspection' | 'manual' = 'inspection';
        let customerInspection: any | undefined;

        try {
          customerInspection = await innovatricsClient.inspectCustomer(customerId);

          if (customerInspection) {
            console.log(
              'Customer inspection result:',
              JSON.stringify(customerInspection, null, 2)
            );
            if (!customerInspection?.documentPortraitComparison) {
              console.warn(
                'Customer inspection missing documentPortraitComparison block. Inspect fields:',
                Object.keys(customerInspection ?? {}),
              );
            } else if (
              typeof customerInspection.documentPortraitComparison?.score !== 'number'
            ) {
              console.warn(
                'Customer inspection documentPortraitComparison present but score missing. Full block:',
                JSON.stringify(customerInspection.documentPortraitComparison, null, 2),
              );
            }
          }

          const inspectionScore = customerInspection?.documentPortraitComparison?.score;
          if (typeof inspectionScore === 'number') {
            faceMatchScore = inspectionScore;
            faceMatchScores.push(inspectionScore);
          }
        } catch (inspectionError: any) {
          console.warn(
            'Customer inspection failed, falling back to manual face comparison.',
            {
              message: inspectionError?.message,
              response: inspectionError?.response?.data,
            }
          );
        }

        if (faceMatchScore === null) {
          comparisonStrategy = 'manual';
          console.log(
            '\nFalling back to manual face comparison using document image templates...'
          );

          const documentBase64 = extractBase64Payload(documentFront.innovatrics);
          const documentSanitized = documentBase64.replace(/\s+/g, '');
          await debugImagePayload('document_full', documentSanitized);

          console.log('Requesting manual document face detection via /faces');
          const documentFaceResult = await innovatricsClient.detectFace(
            documentSanitized
          );
          console.log(
            'Document face detection raw result (manual comparison):',
            JSON.stringify(documentFaceResult, null, 2)
          );

          if (!documentFaceResult?.id) {
            throw new Error(
              'Failed to detect a face in the document image during manual comparison'
            );
          }

          const documentFaceTemplate =
            await innovatricsClient.getFaceTemplate(documentFaceResult.id);
          const referenceFaceTemplate = documentFaceTemplate?.data;

          if (!referenceFaceTemplate) {
            throw new Error(
              'Document face template is missing data for manual comparison'
            );
          }

          console.log('Document face template diagnostics', {
            version: documentFaceTemplate?.version,
            length: referenceFaceTemplate.length,
            sample: referenceFaceTemplate.slice(0, 32),
            suffix: referenceFaceTemplate.slice(-32),
          });

          const referenceFaceRequest = { referenceFaceTemplate };

          const primaryComparison = await innovatricsClient.compareFaces(
            faceResult.id,
            referenceFaceRequest
          );
          faceMatchScores.push(primaryComparison.score);
          console.log('Primary selfie comparison (manual):', primaryComparison);

          for (let i = 0; i < selfieImagesFromBody.length; i++) {
            console.log(
              `\nProcessing additional selfie base64 ${i + 1} (manual comparison)...`
            );
            const additionalSelfie = await resolveImageSource({
              base64: selfieImagesFromBody[i],
              defaultFileName: `${userIdForTracking}_selfie_base64_${i + 1}`,
              tags: ['kyc', 'selfie', 'additional'],
              kind: 'selfie',
            });

            if (!additionalSelfie) {
              console.warn(
                '   Skipping additional selfie due to invalid image data'
              );
              continue;
            }

            const additionalPayload = extractBase64Payload(additionalSelfie.innovatrics);
            const additionalSanitized = additionalPayload.replace(/\s+/g, '');
            await debugImagePayload(
              `additional_selfie_${i + 1}`,
              additionalSanitized
            );

            const additionalFaceResult =
              await innovatricsClient.detectFace(additionalSanitized);
            console.log(
              `Additional selfie ${i + 1} face detection result (manual):`,
              additionalFaceResult
            );

            const additionalComparison =
              await innovatricsClient.compareFaces(
                additionalFaceResult.id,
                referenceFaceRequest
              );
            faceMatchScores.push(additionalComparison.score);
            console.log(
              `Additional selfie ${i + 1} comparison (manual):`,
              additionalComparison
            );
          }

          if (faceMatchScores.length === 0) {
            throw new Error(
              'Manual face comparison failed to produce any scores'
            );
          }

          const averageScore =
            faceMatchScores.reduce((sum: number, score: number) => sum + score, 0) /
            faceMatchScores.length;
          const bestScore = Math.max(...faceMatchScores);
          const worstScore = Math.min(...faceMatchScores);

          faceMatchScore = bestScore;

          console.log('\nManual face comparison summary:');
          console.log('   Scores:', faceMatchScores);
          console.log('   Average:', (averageScore * 100).toFixed(1) + '%');
          console.log('   Best:', (bestScore * 100).toFixed(1) + '%');
          console.log('   Worst:', (worstScore * 100).toFixed(1) + '%');
        }

        if (faceMatchScore === null) {
          throw new Error('Face comparison could not be completed');
        }

        results.faceComparison = {
          score: faceMatchScore,
          strategy: comparisonStrategy,
          ...(faceMatchScores.length > 1
            ? { allScores: faceMatchScores }
            : {}),
        } as any;

        console.log('\n' + '='.repeat(70));
        console.log('Face Matching Results:');
        console.log('='.repeat(70));
        console.log('   Strategy:', comparisonStrategy);
        console.log('   Comparison Score:', (faceMatchScore * 100).toFixed(1) + '%');
        console.log('   Threshold:', (FACE_MATCH_SUCCESS_THRESHOLD * 100).toFixed(1) + '%');
        console.log(
          '   Final Result:',
          faceMatchScore >= FACE_MATCH_SUCCESS_THRESHOLD
            ? '✅ MATCH'
            : '❌ NO MATCH'
        );
        console.log('='.repeat(70) + '\n');

        await recordFaceComparison(customerId, {
          comparisonResult: {
            score: faceMatchScore,
            ...(faceMatchScores.length > 1
              ? { strategy: comparisonStrategy, scores: faceMatchScores }
              : { strategy: comparisonStrategy }),
          },
          image: primarySelfieSource.normalized,
        });

        // Step 6: Inspection-based liveness check (reliable with single selfie)
        console.log('\n' + '='.repeat(70));
        console.log('STEP 6: Performing liveness check');
        console.log('='.repeat(70));

        console.log('Retrieving selfie quality assessment...');
        const inspectionForLiveness =
          customerInspection ?? (await innovatricsClient.inspectCustomer(customerId));

        const hasMask =
          inspectionForLiveness?.selfieInspection?.hasMask || false;
        const faceQuality =
          inspectionForLiveness?.selfieInspection?.faceQuality || 'unknown';

        const livenessResult = {
          status: hasMask ? 'not_live' : 'live',
          confidence: hasMask ? 0 : 0.85,
          method: 'inspection_based',
          indicators: {
            hasMask,
            faceQuality,
          },
        };

        results.livenessCheck = {
          confidence: livenessResult.confidence,
          status: livenessResult.status,
        };

        console.log('\nSUCCESS: Liveness check completed');
        console.log('   Status:', livenessResult.status.toUpperCase());
        console.log(
          '   Confidence:',
          (livenessResult.confidence * 100).toFixed(1) + '%'
        );
        console.log('   Method: Inspection-based quality assessment');
        console.log('   Has Mask:', hasMask ? 'YES (suspicious)' : 'NO');
        console.log('   Face Quality:', faceQuality);
        console.log('='.repeat(70) + '\n');

        await recordLivenessResult(customerId, {
          livenessResult,
          image: primarySelfieSource.normalized,
        });

        const faceMatchPassed =
          typeof faceMatchScore === 'number' &&
          faceMatchScore >= FACE_MATCH_SUCCESS_THRESHOLD;
        const normalizedLivenessStatus = (
          livenessResult.status ?? ''
        ).toLowerCase();
        const livenessPassed =
          normalizedLivenessStatus === LIVENESS_SUCCESS_STATUS;

        if (!faceMatchPassed || !livenessPassed) {
          const declineReasons: string[] = [];
          const declineMessages: string[] = [];

          if (!faceMatchPassed) {
            declineReasons.push('face_match_failed');
            declineMessages.push(
              `Face comparison score ${(faceMatchScore * 100).toFixed(1)}% is below the ${(FACE_MATCH_SUCCESS_THRESHOLD * 100).toFixed(0)}% threshold.`
            );
          }

          if (!livenessPassed) {
            declineReasons.push('liveness_failed');
            declineMessages.push('Liveness check returned a non-live status.');
          }

          const declineReasonTag = declineReasons.join('|') || 'kyc_failed';
          const declineContent =
            declineMessages.length > 0
              ? `KYC verification declined. ${declineMessages.join(' ')}`
              : 'KYC verification declined due to unmet biometric requirements.';

          results.overallStatus = 'failed';
          results.updatedAt = new Date();

          await recordError(customerId, {
            message: declineContent,
            markFailed: true,
            context: {
              faceMatch: {
                score: faceMatchScore,
                threshold: FACE_MATCH_SUCCESS_THRESHOLD,
              },
              liveness: livenessResult,
            },
          }).catch(() => undefined);

          console.log('KYC verification declined:', {
            reasons: declineReasons,
            messages: declineMessages,
          });

          const declinedUser = buildDeclinedUserEvent(
            userPubKey,
            customerId ?? userPubKey,
            declineReasonTag,
            declineContent
          );

          res.status(422);
          return res.json(declinedUser);
        }

        // Update overall status
        results.overallStatus = 'completed';
        results.updatedAt = new Date();

        await markFinished(customerId);
        console.log(
          'Updating Innovatrics customer onboarding status to FINISHED',
          {
            innovatricsCustomerId: customerId,
            externalId,
          }
        );
        await innovatricsClient.storeCustomer(customerId, {
          externalId,
          onboardingStatus: 'FINISHED',
        });
        console.log('Innovatrics confirmed onboarding status update');

        // Final success response
        console.log('\n' + '='.repeat(70));
        console.log('KYC VERIFICATION COMPLETE!');
        console.log('='.repeat(70));
        console.log('   Customer ID:', customerId);
        console.log(
          '   Document Verified:',
          results.documentVerification ? 'YES' : 'NO'
        );
        console.log('   Selfie Uploaded:', results.selfieUpload ? 'YES' : 'NO');
        console.log(
          '   Liveness Check:',
          results.livenessCheck
            ? results.livenessCheck.status
              ? results.livenessCheck.status.toUpperCase()
              : 'INCONCLUSIVE'
            : 'SKIPPED'
        );
        console.log(
          '   Face Match:',
          (results.faceComparison?.score ?? 0) >= FACE_MATCH_SUCCESS_THRESHOLD
            ? 'PASSED'
            : 'FAILED'
        );
        console.log('='.repeat(70) + '\n');

        const acceptedUsers = buildAcceptedUserEvent(
          userIdForTracking,
          'KYC verification completed successfully'
        );

        res.status(200);
        return res.json(acceptedUsers);
      } catch (verificationError: any) {
        // If verification fails, still return partial results
        results.overallStatus = 'failed';
        results.updatedAt = new Date();

        console.error('KYC verification error:', verificationError);
        const errorPayload: Parameters<typeof recordError>[1] = {
          message: verificationError?.message ?? 'Verification failed',
          markFailed: true,
          context: verificationError?.response?.data ?? {
            message: verificationError?.message,
          },
        };

        if (verificationError?.response?.status) {
          errorPayload.code = String(verificationError.response.status);
        }

        await recordError(customerId, errorPayload).catch(() => undefined);

        const declinedUser = buildDeclinedUserEvent(
          userPubKey,
          customerId ?? userPubKey,
          verificationError?.message ?? 'Verification failed',
          'We kindly ask for additional information to continue your verification.'
        );

        res.status(500);
        return res.json(declinedUser);
      }
    } catch (error: any) {
      console.error('KYC processing error:', error);
      if (customerId) {
        const errorPayload: Parameters<typeof recordError>[1] = {
          message: error?.message ?? 'Processing failed',
          markFailed: true,
          context: error?.response?.data ?? {
            message: error?.message,
          },
        };

        if (error?.response?.status) {
          errorPayload.code = String(error.response.status);
        }

        await recordError(customerId, errorPayload).catch(() => undefined);
      }
      const declinedUser = buildDeclinedUserEvent(
        userPubKey || (customerId ?? 'unknown'),
        customerId ?? (userPubKey || undefined),
        error?.message ?? 'Processing failed',
        'We kindly ask for additional information to continue your verification.'
      );

      res.status(500);
      return res.json(declinedUser);
    }
  }
}

interface ResolveImageOptions {
  base64?: string | undefined;
  kind?: 'document' | 'selfie';
  defaultFileName?: string;
  tags?: string[];
}

interface ResolvedImageSource {
  normalized: NormalizedImage;
  innovatrics: InnovatricsImagePayload;
}

async function debugImagePayload(
  label: string,
  base64?: string | null
): Promise<void> {
  if (!base64 || typeof base64 !== 'string') {
    console.warn(`[DEBUG] Image payload (${label}) missing or invalid`);
    return;
  }

  try {
    const sanitized = base64.replace(/\s+/g, '');
    const buffer = Buffer.from(sanitized, 'base64');
    const filePath = path.join(tmpdir(), `kyc-${label}-${Date.now()}.jpg`);
    await fs.writeFile(filePath, buffer);

    console.log(`[DEBUG] Image payload (${label})`, {
      bytes: buffer.length,
      sample: sanitized.slice(0, 32),
      suffix: sanitized.slice(-32),
      filePath,
    });
  } catch (error) {
    console.warn(`[DEBUG] Failed to process image payload (${label})`, {
      message: (error as Error)?.message,
    });
  }
}

async function resolveImageSource(
  options: ResolveImageOptions
): Promise<ResolvedImageSource | null> {
  const { base64, kind } = options;

  let buffer: Buffer | null = null;
  let originalSanitizedBase64: string | null = null;

  if (base64) {
    const normalized = normalizeImagePayload(base64);
    const sanitizedBase64 = normalized.base64?.replace(/\s+/g, '') ?? '';

    if (!sanitizedBase64) {
      console.warn('resolveImageSource received base64 input without data.');
      return null;
    }

    originalSanitizedBase64 = sanitizedBase64; // Preserve for byte-exact return

    try {
      console.log('Decoding base64 image payload', {
        length: sanitizedBase64.length,
        sample: sanitizedBase64.slice(0, 32),
        suffix: sanitizedBase64.slice(-32),
      });
      buffer = Buffer.from(sanitizedBase64, 'base64');
    } catch (decodeError: any) {
      console.warn('Failed to decode base64 payload into buffer.', {
        message: decodeError?.message,
      });
      throw new Error('Invalid image data: unable to decode base64 payload');
    }
  }

  if (!buffer) {
    return null;
  }

  // Get image metadata without modifying the original bytes
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'none' }).metadata();
  } catch (error: any) {
    console.warn(
      'Failed to read image metadata from provided base64 payload.',
      {
        message: error?.message,
        bufferLength: buffer.length,
      }
    );
    throw new Error('Invalid image data: unable to decode base64 payload');
  }

  const minDocumentDimension = 1800;
  const minSelfieDimension = 720;
  const maxDimension = 3000; // Innovatrics limit

  if (metadata.width && metadata.height) {
    const longerSide = Math.max(metadata.width, metadata.height);
    if (kind === 'document' && longerSide < minDocumentDimension) {
      console.warn(
        `Document image longer side ${longerSide}px is below recommended ${minDocumentDimension}px. Using original bytes without resizing.`,
      );
    }
    if (kind === 'selfie' && longerSide < minSelfieDimension) {
      console.warn(
        `Selfie image longer side ${longerSide}px is below recommended ${minSelfieDimension}px. Using original bytes without resizing.`,
      );
    }
    if (longerSide > maxDimension) {
      console.warn(
        `Image longer side ${longerSide}px exceeds Innovatrics ${maxDimension}px limit. Using original bytes; consider capturing at a lower resolution.`,
      );
    }
  }

  const base64Data = originalSanitizedBase64 ?? buffer.toString('base64');

  const normalized: NormalizedImage = {
    base64: base64Data,
    mimeType:
      metadata.format === 'jpeg'
        ? 'image/jpeg'
        : `image/${metadata.format ?? 'jpeg'}`,
    bytes: buffer.length,
    resourceType: 'image',
    ...(metadata.width ? { width: metadata.width } : {}),
    ...(metadata.height ? { height: metadata.height } : {}),
  };

  return {
    normalized,
    innovatrics: base64Data,
  };
}

function toStringArray(input?: string[] | string): string[] {
  if (!input) {
    return [];
  }

  return Array.isArray(input) ? input : [input];
}

function extractBase64Payload(payload: InnovatricsImagePayload): string {
  if (typeof payload === 'string') {
    return payload.replace(/\s+/g, '');
  }

  const raw =
    (payload as any)?.image?.data ??
    (payload as any)?.data ??
    null;

  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Innovatrics image payload is missing base64 data');
  }

  return raw.replace(/\s+/g, '');
}
