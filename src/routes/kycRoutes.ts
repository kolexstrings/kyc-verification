import { Router } from 'express';
import { body } from 'express-validator';
import { KYCVerificationController } from '../controllers/kycController';

// Validation middleware
const validateKYCProfile = [
  body('identificationDocumentImage')
    .optional()
    .custom(value => Array.isArray(value) || typeof value === 'string')
    .withMessage('identificationDocumentImage must be provided as base64 JSON array/string'),
  body('image')
    .optional()
    .isString()
    .isLength({ min: 1 })
    .withMessage('image must be provided as a base64 string'),
  body('name')
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('name is required'),
  body('surname')
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('surname is required'),
  body('dateOfBirth')
    .isString()
    .isLength({ min: 1 })
    .withMessage('dateOfBirth is required'),
  body('userId')
    .optional()
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('userId must be a valid string if provided'),
  body('documentType')
    .optional()
    .isIn(['passport', 'id_card', 'driver_license', 'residence_permit', 'visa', 'other'])
    .withMessage('documentType must be one of: passport, id_card, driver_license, residence_permit, visa, other if provided'),
  body('challengeType')
    .optional()
    .isIn(['passive', 'motion', 'expression'])
    .withMessage('challengeType must be one of: passive, motion, expression if provided'),
];

// Helper function to handle validation errors
const handleValidationErrors = (req: any, res: any, next: any) => {
  const errors = req.validationErrors || [];
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.map((error: any) => error.msg),
    });
  }
  next();
};

const router = Router();

/**
 * @swagger
 * /api/kyc/verify:
 *   post:
 *     summary: Process complete KYC verification
 *     description: Orchestrates the entire KYC verification process from frontend KYCProfile data
 *     tags: [KYC]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - identificationDocumentImage
 *               - image
 *               - name
 *               - surname
 *               - dateOfBirth
 *             properties:
 *               identificationDocumentImage:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: string
 *                 description: Array of base64 encoded document images (front, optional back). Accepts plain base64 or data URI string (data:image/jpeg;base64,...)
 *                 example: ["data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...front", "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...back"]
 *               image:
 *                 type: string
 *                 description: Main profile/selfie image (base64 encoded)
 *                 example: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...selfie"
 *               selfieImages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional additional selfie frames (base64) for passive liveness evaluation
 *                 example: ["data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...liveness"]
 *               name:
 *                 type: string
 *                 description: User's first name
 *                 example: "John"
 *               surname:
 *                 type: string
 *                 description: User's surname
 *                 example: "Doe"
 *               dateOfBirth:
 *                 type: string
 *                 description: User's date of birth (ISO 8601 recommended)
 *                 example: "1990-01-01"
 *               userId:
 *                 type: string
 *                 description: Optional application user identifier. When provided, it is used as the Innovatrics externalId and persisted with onboarding results.
 *                 example: "user_123456"
 *               documentType:
 *                 type: string
 *                 enum: [passport, id_card, driver_license, residence_permit, visa, other]
 *                 description: Type of document being verified (optional, defaults to id_card)
 *                 example: "passport"
 *               challengeType:
 *                 type: string
 *                 enum: [passive, motion, expression]
 *                 description: Type of liveness analysis (optional, defaults to passive)
 *                 example: "passive"
 *             example:
 *               identificationDocumentImage:
 *                 - "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...front"
 *                 - "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...back"
 *               image: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...selfie"
 *               selfieImages:
 *                 - "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ...liveness"
 *               name: "John"
 *               surname: "Doe"
 *               dateOfBirth: "1990-01-01"
 *               userId: "user_123456"
 *               documentType: "passport"
 *               challengeType: "passive"
 *               # All other KYCProfile fields are optional for verification
 *     responses:
 *       200:
 *         description: KYC verification completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     customerId:
 *                       type: string
 *                       example: "cust_abc123"
 *                     externalId:
 *                       type: string
 *                       example: "user_123456"
 *                     userId:
 *                       type: string
 *                       nullable: true
 *                       example: "user_123456"
 *                     documentVerification:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           example: "completed"
 *                         documentType:
 *                           type: string
 *                           example: "passport"
 *                         issuingCountry:
 *                           type: string
 *                           example: "USA"
 *                         verificationStatus:
 *                           type: string
 *                           example: "verified"
 *                         confidence:
 *                           type: number
 *                           example: 0.95
 *                     selfieUpload:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           example: "selfie_123"
 *                     faceDetection:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           example: "face_456"
 *                         detection:
 *                           type: object
 *                           properties:
 *                             score:
 *                               type: number
 *                               example: 0.98
 *                         maskResult:
 *                           type: object
 *                           properties:
 *                             score:
 *                               type: number
 *                               example: 0.95
 *                     livenessCheck:
 *                       type: object
 *                       properties:
 *                         confidence:
 *                           type: number
 *                           example: 0.92
 *                         status:
 *                           type: string
 *                           example: "live"
 *                       description: Result of passive liveness analysis (AI detects natural human characteristics vs spoofing)
 *                     faceComparison:
 *                       type: object
 *                       properties:
 *                         score:
 *                           type: number
 *                           example: 0.85
 *                     overallStatus:
 *                       type: string
 *                       enum: [pending, in_progress, completed, failed]
 *                       example: "completed"
 *                 message:
 *                   type: string
 *                   example: "KYC verification completed successfully"
 */
router.post(
  '/verify',
  validateKYCProfile,
  handleValidationErrors,
  KYCVerificationController.processKYCProfile
);

export default router;
