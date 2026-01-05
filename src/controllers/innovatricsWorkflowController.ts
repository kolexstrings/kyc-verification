import { Request, Response } from 'express';
import { config } from '../config/env';
import { ResponseHandler } from '../utils/responseHandler';
import {
  InnovatricsEventWorkflow,
  VerificationInput,
} from '../workflows/innovatricsOrchestrationModule';

export class InnovatricsWorkflowController {
  static async processKYCProfile(req: Request, res: Response) {
    try {
      const workflowConfig = {
        baseUrl: config.innovatrics.baseUrl,
        bearerToken: config.innovatrics.bearerToken,
        host: config.innovatrics.host,
      };

      console.log('[InnovatricsWorkflow] Config:', {
        baseUrl: workflowConfig.baseUrl,
        hasBearerToken: !!workflowConfig.bearerToken,
        host: workflowConfig.host,
      });

      const workflow = new InnovatricsEventWorkflow(workflowConfig);

      const verificationInput: VerificationInput = {
        identificationDocumentImage: req.body?.identificationDocumentImage,
        selfieImages: req.body?.selfieImages ?? req.body?.image,
        documentType: req.body?.documentType,
        firstNationality: req.body?.firstNationality,
        userId: req.body?.userId,
        challengeType: req.body?.challengeType,
      };

      const outcome = await workflow.run(verificationInput);

      // Return only the raw Innovatrics results without Nostr event wrapper
      return ResponseHandler.success(
        res,
        outcome.results || outcome,
        'Innovatrics workflow verification completed'
      );
    } catch (error: any) {
      const message = error?.message || 'Innovatrics workflow failed';
      return ResponseHandler.error(
        res,
        'Failed to process KYC verification',
        500,
        message
      );
    }
  }
}
