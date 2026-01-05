import { normalizeImagePayload, NormalizedImage } from '../utils/image';
import { withRetry } from '../utils/retry';

export type EventTag = [string, ...string[]];

export interface WorkflowEvent {
  kind: number;
  created_at: number;
  tags: EventTag[];
  content: string;
}

export interface InnovatricsWorkflowConfig {
  baseUrl: string;
  bearerToken: string;
  host?: string;
  relayUrl?: string;
}

export interface VerificationInput {
  identificationDocumentImage: string[] | string;
  selfieImages: string[] | string;
  documentType?: string;
  firstNationality?: string;
  userId?: string;
  challengeType?: string;
}

export interface DocumentVerificationSummary {
  documentType?: string;
  issuingCountry?: string;
  warnings?: string[];
  errors?: string[];
}

export interface DocumentPageResult {
  pageType?: 'front' | 'back' | 'unknown';
  warnings?: string[];
  errorCode?: string;
  documentType?: {
    type?: string;
    issuingCountry?: string;
  };
  [key: string]: any;
}

export interface DocumentVerificationResult {
  document?: any;
  summary: DocumentVerificationSummary;
  pages: DocumentPageResult[];
  inspection?: any;
  disclosedInspection?: any;
}

export interface FaceDetectionResult {
  id: string;
  detection: {
    score: number;
    boundingBox?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    [key: string]: any;
  };
  maskResult: {
    score: number;
    [key: string]: any;
  };
}

export interface LivenessResult {
  confidence: number;
  status: string;
  isDeepfake?: boolean;
  deepfakeConfidence?: number;
  method?: 'passive_liveness' | 'inspection_based' | string;
  indicators?: Record<string, any>;
}

export interface VerificationFlowResult {
  customerId: string;
  externalId: string;
  userId?: string;
  overallStatus: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
  documentVerification?: DocumentVerificationResult;
  selfieUpload?: {
    id: string;
  };
  faceDetection?: FaceDetectionResult;
  faceComparison?: {
    score: number;
    scores?: number[];
    strategy?: 'inspection' | 'manual';
  };
  livenessCheck?: LivenessResult;
}

export type SerializedVerificationResult = Omit<
  VerificationFlowResult,
  'createdAt' | 'updatedAt'
> & {
  createdAt?: string;
  updatedAt?: string;
};

interface ResolvedImage {
  normalized: NormalizedImage;
  base64: string;
}

const FACE_MATCH_SUCCESS_THRESHOLD = 0.465;
const LIVENESS_SUCCESS_STATUS = 'live';
const MIN_DOCUMENT_DIMENSION = 1800;
const MIN_SELFIE_DIMENSION = 720;
const MAX_IMAGE_DIMENSION = 3000;

interface FailureEventParams {
  pubkey: string;
  userId: string;
  reason?: string;
  content: string;
}

interface SuccessEventParams {
  pubkey: string;
}

export interface VerificationOutcome {
  event?: WorkflowEvent;
  results?: SerializedVerificationResult;
  // Allow raw verification results for direct API responses
  [key: string]: any;
}

type HttpMethod = 'GET' | 'POST' | 'PUT';

interface HttpResponse<T> {
  data: T;
}

class HttpError extends Error {
  constructor(
    message: string,
    public readonly response?: { status: number; data?: any }
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class InnovatricsEventWorkflow {
  private readonly requestTimeoutMs = 120000;

  constructor(private readonly config: InnovatricsWorkflowConfig) {}

  async run(input: VerificationInput): Promise<VerificationOutcome> {
    const documentImages = toArray(input.identificationDocumentImage);
    const primarySelfieCandidates = toArray(input.selfieImages);
    const primarySelfieInput =
      (primarySelfieCandidates[0] ?? '').trim?.() ??
      primarySelfieCandidates[0] ??
      '';
    const additionalSelfiesInput = primarySelfieCandidates.slice(1);
    const providedUserId =
      typeof input.userId === 'string' ? input.userId.trim() : '';
    const passiveLivenessEnabled =
      (process.env.DIS_USE_PASSIVE_LIVENESS ?? 'true').toLowerCase() !==
      'false';

    if (!documentImages[0] || !primarySelfieInput) {
      const failureResult = {
        overallStatus: 'failed',
        reason: 'missing_input',
        content: 'Document front image and primary selfie are required',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return failureResult;
    }

    let customerId: string | undefined;

    try {
      const documentFront = await resolveImageSource(
        documentImages[0],
        'document'
      );
      const documentBack = documentImages[1]
        ? await resolveImageSource(documentImages[1], 'document')
        : undefined;
      const primarySelfie = await resolveImageSource(
        primarySelfieInput,
        'selfie'
      );

      const supplementalSelfies: ResolvedImage[] = [];
      for (const selfie of additionalSelfiesInput) {
        try {
          supplementalSelfies.push(await resolveImageSource(selfie, 'selfie'));
        } catch (selfieError) {
          console.warn(
            'Skipping invalid supplemental selfie image',
            selfieError
          );
        }
      }

      const additionalPassiveSelfies = supplementalSelfies
        .map(selfie => selfie.base64?.replace(/\s+/g, '') ?? '')
        .filter(value => value.length > 0);

      const customerResponse = await this.createCustomer();
      customerId = customerResponse.id;

      const externalId = providedUserId || `external_${Date.now()}`;
      const pubkey = externalId;

      const verification: VerificationFlowResult = {
        customerId,
        externalId,
        overallStatus: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(providedUserId ? { userId: providedUserId } : {}),
      };

      const documentVerification = await this.verifyDocument({
        customerId,
        frontImage: documentFront.base64,
        ...(documentBack ? { backImage: documentBack.base64 } : {}),
        ...(input.documentType ? { documentType: input.documentType } : {}),
        ...(input.firstNationality
          ? { issuingCountry: input.firstNationality }
          : {}),
      });
      verification.documentVerification = documentVerification;

      const selfieUpload = await this.uploadSelfie(
        customerId,
        primarySelfie.base64
      );
      verification.selfieUpload = selfieUpload;

      const primaryFaceDetection = await this.detectFace(primarySelfie.base64);
      const maskResult = await this.checkFaceMask(primaryFaceDetection.id);
      verification.faceDetection = {
        id: primaryFaceDetection.id,
        detection: primaryFaceDetection.detection,
        maskResult,
      };

      const faceMatchScores: number[] = [];
      let faceMatchScore: number | null = null;
      let comparisonStrategy: 'inspection' | 'manual' = 'inspection';

      const inspection = await this.inspectCustomer(customerId).catch(error => {
        console.warn(
          'Customer inspection failed; switching to manual face comparison.',
          error
        );
        return undefined;
      });

      const inspectionScore = inspection?.documentPortraitComparison?.score;
      if (typeof inspectionScore === 'number') {
        faceMatchScore = inspectionScore;
        faceMatchScores.push(inspectionScore);
      } else {
        console.warn(
          'Customer inspection missing documentPortraitComparison score; switching to manual fallback.'
        );
      }

      if (faceMatchScore === null) {
        comparisonStrategy = 'manual';

        const portraitImageData = await this.getDocumentPortrait(
          customerId
        ).catch((error: unknown) => {
          console.warn(
            'Document portrait retrieval failed, falling back to front page',
            error
          );
          return undefined;
        });

        const portraitBase64 = (() => {
          if (!portraitImageData) {
            return documentFront.base64;
          }
          if (typeof portraitImageData === 'string') {
            return portraitImageData;
          }
          const candidate =
            (portraitImageData as any)?.image?.data ??
            (portraitImageData as any)?.data;
          return typeof candidate === 'string' && candidate.length > 0
            ? candidate
            : documentFront.base64;
        })();

        const documentFaceResult = await this.detectFace(
          portraitBase64.replace(/\s+/g, '')
        );
        const documentFaceTemplate = await this.getFaceTemplate(
          documentFaceResult.id
        );
        const referenceFaceTemplate = documentFaceTemplate?.data;

        if (!referenceFaceTemplate) {
          throw new Error(
            'Document face template is missing data for manual comparison'
          );
        }

        const primaryComparison = await this.compareFaceWithTemplate(
          primaryFaceDetection.id,
          referenceFaceTemplate
        );
        faceMatchScores.push(primaryComparison.score);

        for (const [index, selfie] of supplementalSelfies.entries()) {
          try {
            const supplementalFace = await this.detectFace(selfie.base64);
            const comparison = await this.compareFaceWithTemplate(
              supplementalFace.id,
              referenceFaceTemplate
            );
            faceMatchScores.push(comparison.score);
            console.log(
              `Supplemental selfie [${index + 1}] similarity score: ${(comparison.score * 100).toFixed(1)}%`
            );
          } catch (comparisonError) {
            console.warn(
              'Skipping supplemental selfie due to comparison error',
              comparisonError
            );
          }
        }

        if (!faceMatchScores.length) {
          throw new Error(
            'Manual face comparison failed to produce any scores'
          );
        }

        faceMatchScore = Math.max(...faceMatchScores);
      }

      if (faceMatchScore === null) {
        throw new Error('Face comparison could not be completed');
      }

      verification.faceComparison = {
        score: faceMatchScore,
        scores: faceMatchScores,
        strategy: comparisonStrategy,
      };

      let finalLivenessResult: LivenessResult | null = null;

      if (passiveLivenessEnabled) {
        try {
          finalLivenessResult = await this.evaluatePassiveLiveness(customerId, {
            additionalSelfies: additionalPassiveSelfies,
            deepfakeCheck: true,
          });
        } catch (passiveError) {
          console.warn(
            'Passive liveness evaluation failed, falling back to inspection-based assessment.',
            passiveError
          );
        }
      }

      if (!finalLivenessResult) {
        const inspectionForLiveness =
          inspection ?? (await this.inspectCustomer(customerId));
        const hasMask =
          inspectionForLiveness?.selfieInspection?.hasMask ?? false;
        const faceQuality =
          inspectionForLiveness?.selfieInspection?.faceQuality ?? 'unknown';

        finalLivenessResult = {
          confidence: hasMask ? 0 : 0.85,
          status: hasMask ? 'not_live' : 'live',
          method: 'inspection_based',
          indicators: {
            hasMask,
            faceQuality,
          },
        };
      }

      verification.livenessCheck = finalLivenessResult;

      const livenessResult = verification.livenessCheck;
      const faceMatchPassed =
        faceMatchScores.length > 0 &&
        faceMatchScore >= FACE_MATCH_SUCCESS_THRESHOLD;
      const livenessPassed =
        (livenessResult?.status ?? '').toLowerCase() ===
        LIVENESS_SUCCESS_STATUS;

      if (!faceMatchPassed || !livenessPassed) {
        verification.overallStatus = 'failed';
        verification.updatedAt = new Date();

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
        const declineContent = declineMessages.length
          ? `KYC verification declined. ${declineMessages.join(' ')}`
          : 'KYC verification declined due to unmet biometric requirements.';

        // Create failure result with decline information
        const failureResult = {
          ...verification,
          declineReason: declineReasonTag,
          declineContent: declineContent,
        };

        const serialized = serializeResult(failureResult);
        return serialized || failureResult;
      }

      verification.overallStatus = 'completed';
      verification.updatedAt = new Date();

      const serialized = serializeResult(verification);
      return serialized || verification;
    } catch (error: any) {
      const failureResult = {
        overallStatus: 'failed',
        reason: 'verification_failed',
        content: error?.message || 'Verification failed',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return failureResult;
    }
  }

  private async createCustomer(): Promise<{ id: string }> {
    const response = await this.post<{ id: string }>('customers', {});
    return response.data;
  }

  private async verifyDocument(params: {
    customerId: string;
    frontImage: string;
    backImage?: string;
    documentType?: string;
    issuingCountry?: string;
  }): Promise<DocumentVerificationResult> {
    const { customerId, frontImage, backImage, documentType, issuingCountry } =
      params;

    const classificationAdvice: Record<string, any> = {};
    if (documentType) {
      classificationAdvice.types = [documentType];
    }
    if (issuingCountry) {
      classificationAdvice.countries = [issuingCountry];
    }

    const createDocumentPayload: Record<string, any> = {
      sources: ['VIZ', 'MRZ', 'DOCUMENT_PORTRAIT'],
      // Try different field extraction approaches
      enableFieldExtraction: true,
      extractPersonalData: true,
    };
    if (Object.keys(classificationAdvice).length > 0) {
      createDocumentPayload.advice = { classification: classificationAdvice };
    }

    const documentResponse = await withRetry(
      () =>
        this.put(`/customers/${customerId}/document`, createDocumentPayload),
      {
        shouldRetry: this.isRetryableError,
      }
    );

    const pages: DocumentPageResult[] = [];

    const frontPageResponse = await withRetry(
      () =>
        this.put(`/customers/${customerId}/document/pages`, {
          image: this.buildImagePayload(frontImage),
          advice: {
            classification: {
              pageTypes: ['front'],
            },
            // Request field extraction at page level
            extractFields: true,
            enableOcr: true,
          },
        }),
      {
        shouldRetry: this.isRetryableError,
      }
    );
    pages.push(frontPageResponse.data);

    if (backImage) {
      const backPageResponse = await withRetry(
        () =>
          this.put(`/customers/${customerId}/document/pages`, {
            image: this.buildImagePayload(backImage),
            advice: {
              classification: {
                pageTypes: ['back'],
              },
              // Request field extraction at page level
              extractFields: true,
              enableOcr: true,
            },
          }),
        {
          shouldRetry: this.isRetryableError,
        }
      );
      pages.push(backPageResponse.data);
    }

    const inspectionResponse = await withRetry(
      () => this.post(`/customers/${customerId}/document/inspect`),
      {
        shouldRetry: this.isRetryableError,
      }
    );

    let disclosedInspection: any | undefined;
    try {
      // Try different approaches for field extraction
      console.log('[DEBUG] Attempting OCR field extraction...');

      // Method 1: Try direct OCR endpoint
      let ocrResponse;
      try {
        ocrResponse = await this.get(`/customers/${customerId}/document/ocr`);
        console.log(
          '[DEBUG] OCR response:',
          JSON.stringify(ocrResponse, null, 2)
        );
      } catch (ocrError: any) {
        console.log(
          '[DEBUG] OCR endpoint not available:',
          ocrError?.message || ocrError
        );
      }

      // Method 2: Try disclose with different payload
      const disclosedResponse = await withRetry(
        () =>
          this.post(`/customers/${customerId}/document/inspect/disclose`, {
            // Try minimal payload
            extractText: true,
            includeMrz: true,
            includeVisualZone: true,
          }),
        {
          shouldRetry: this.isRetryableError,
        }
      );
      disclosedInspection = disclosedResponse.data;
      console.log(
        '[DEBUG] Disclosed inspection response:',
        JSON.stringify(disclosedInspection, null, 2)
      );
    } catch (discloseError) {
      console.warn('Document inspection disclosure failed', discloseError);
    }

    const frontPage = pages.find(page => page.pageType === 'front') ?? pages[0];
    const collectedWarnings = Array.from(
      new Set(pages.flatMap(page => page.warnings ?? []))
    );
    const collectedErrors = Array.from(
      new Set(
        pages
          .map(page => page.errorCode)
          .filter((code): code is string => Boolean(code))
      )
    );

    const summary: DocumentVerificationSummary = {
      ...(frontPage?.documentType?.type
        ? { documentType: frontPage.documentType.type }
        : {}),
      ...(frontPage?.documentType?.issuingCountry
        ? { issuingCountry: frontPage.documentType.issuingCountry }
        : {}),
      ...(collectedWarnings.length ? { warnings: collectedWarnings } : {}),
      ...(collectedErrors.length ? { errors: collectedErrors } : {}),
      // Include disclosed inspection data which may contain extracted fields
      ...(disclosedInspection ? { disclosedInspection } : {}),
    };

    return {
      document: documentResponse.data,
      summary,
      pages,
      inspection: inspectionResponse.data,
      disclosedInspection,
    };
  }

  private async uploadSelfie(
    customerId: string,
    imageBase64: string
  ): Promise<{ id: string }> {
    const response = await this.put(`/customers/${customerId}/selfie`, {
      image: this.buildImagePayload(imageBase64),
    });
    return response.data;
  }

  private async detectFace(imageBase64: string): Promise<{
    id: string;
    detection: any;
  }> {
    const response = await this.post('/faces', {
      image: this.buildImagePayload(imageBase64),
    });
    return response.data;
  }

  private async getFaceTemplate(
    faceId: string
  ): Promise<{ data: string; version?: string }> {
    const response = await this.get<{ data: string; version?: string }>(
      `/faces/${faceId}/face-template`
    );
    return response.data;
  }

  private async compareFaceWithTemplate(
    probeFaceId: string,
    referenceFaceTemplate: string
  ): Promise<{ score: number }> {
    const response = await this.post<{ score: number }>(
      `/faces/${probeFaceId}/similarity`,
      {
        referenceFaceTemplate,
      }
    );
    return response.data;
  }

  private async compareFaces(
    probeFaceId: string,
    referenceFaceId: string
  ): Promise<{ score: number }> {
    const response = await this.post(`/faces/${probeFaceId}/similarity`, {
      referenceFace: `/api/v1/faces/${referenceFaceId}`,
    });
    return response.data;
  }

  private async checkFaceMask(faceId: string): Promise<{ score: number }> {
    const response = await this.get(`/faces/${faceId}/face-mask`);
    return response.data;
  }

  private async inspectCustomer(customerId: string): Promise<any> {
    const response = await this.post(`/customers/${customerId}/inspect`);
    return response.data;
  }

  private async getDocumentPortrait(customerId: string): Promise<any> {
    const response = await this.get(
      `/customers/${customerId}/document/portrait`
    );
    return response.data;
  }

  private async evaluatePassiveLiveness(
    customerId: string,
    options: { additionalSelfies?: string[]; deepfakeCheck?: boolean }
  ): Promise<LivenessResult> {
    await this.ensureLivenessRecord(customerId);

    if (options.additionalSelfies && options.additionalSelfies.length > 0) {
      for (const selfie of options.additionalSelfies) {
        await this.uploadAdditionalSelfie(customerId, selfie, 'NONE');
      }
    }

    const evaluationPayload = { type: 'PASSIVE_LIVENESS' };
    console.log(
      'DEBUG: Passive liveness evaluation payload:',
      JSON.stringify(evaluationPayload)
    );

    const evaluationResponse = await this.post(
      `/customers/${customerId}/liveness/evaluation`,
      evaluationPayload
    );

    const baseResult = evaluationResponse.data ?? {};
    const normalizedConfidence =
      typeof baseResult?.confidence === 'number'
        ? baseResult.confidence
        : typeof baseResult?.score === 'number'
          ? baseResult.score
          : 0;
    const normalizedStatus = ((): 'live' | 'not_live' | 'suspicious' => {
      if (
        baseResult?.status === 'live' ||
        baseResult?.status === 'not_live' ||
        baseResult?.status === 'suspicious'
      ) {
        return baseResult.status;
      }
      if (normalizedConfidence >= 0.5) {
        return 'live';
      }
      return 'not_live';
    })();

    console.log(
      'Passive liveness raw response:',
      JSON.stringify(baseResult, null, 2)
    );

    if ((baseResult as any)?.errorCode) {
      console.warn(
        '⚠️  Passive liveness returned error:',
        baseResult.errorCode
      );
      return {
        confidence: 0,
        status: 'not_live',
        method: 'passive_liveness',
      };
    }

    if (options.deepfakeCheck) {
      try {
        const deepfakePayload = {
          type: 'DEEPFAKE',
          livenessResources: ['PASSIVE'],
        };
        console.log(
          'DEBUG: Extended deepfake evaluation payload:',
          JSON.stringify(deepfakePayload)
        );

        const deepfakeResponse = await this.post(
          `/customers/${customerId}/liveness/evaluation/extended`,
          deepfakePayload
        );
        const deepfakeResult = deepfakeResponse.data ?? {};
        console.log(
          'Deepfake raw response:',
          JSON.stringify(deepfakeResult, null, 2)
        );

        return {
          confidence: normalizedConfidence,
          status: normalizedStatus,
          method: 'passive_liveness',
          isDeepfake: deepfakeResult.isDeepfake,
          deepfakeConfidence: deepfakeResult.confidence,
        };
      } catch (deepfakeError) {
        console.warn('Deepfake evaluation failed', deepfakeError);
      }
    }

    return {
      confidence: normalizedConfidence,
      status: normalizedStatus,
      method: 'passive_liveness',
    };
  }

  private async ensureLivenessRecord(customerId: string): Promise<void> {
    await this.put(`/customers/${customerId}/liveness`);
  }

  private async uploadAdditionalSelfie(
    customerId: string,
    imageBase64: string,
    assertion: 'NONE' | 'NEUTRAL' | 'SMILE' | 'BLINK' | 'HEAD_TURN' = 'NONE'
  ): Promise<void> {
    await this.post(`/customers/${customerId}/liveness/selfies`, {
      assertion,
      image: this.buildImagePayload(imageBase64),
    });
  }

  private async request<T = any>(
    method: HttpMethod,
    path: string,
    body?: unknown
  ): Promise<HttpResponse<T>> {
    // Manually construct URL to avoid JavaScript's URL constructor behavior
    const baseUrl = this.config.baseUrl.endsWith('/')
      ? this.config.baseUrl.slice(0, -1)
      : this.config.baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(baseUrl + normalizedPath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const hasBody = body !== undefined;
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(hasBody),
        signal: controller.signal,
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
      });

      const parsedBody = await this.parseResponseBody(response);

      if (!response.ok) {
        throw new HttpError(
          `Request failed with status ${response.status}` as const,
          {
            status: response.status,
            data: parsedBody,
          }
        );
      }

      return { data: parsedBody as T };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HttpError('Request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private post<T = any>(
    path: string,
    body?: unknown
  ): Promise<HttpResponse<T>> {
    return this.request('POST', path, body);
  }

  private put<T = any>(path: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request('PUT', path, body);
  }

  private get<T = any>(path: string): Promise<HttpResponse<T>> {
    return this.request('GET', path);
  }

  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.bearerToken}`,
    };

    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.config.host) {
      headers.Host = this.config.host;
    }

    return headers;
  }

  private async parseResponseBody(response: Response): Promise<any> {
    const contentLength = response.headers.get('content-length');
    const contentType = response.headers.get('content-type') ?? '';

    if (response.status === 204 || contentLength === '0') {
      return undefined;
    }

    if (contentType.includes('application/json')) {
      try {
        return await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) {
          return undefined;
        }
        throw error;
      }
    }

    try {
      const text = await response.text();
      return text.length > 0 ? text : undefined;
    } catch (error) {
      if (error instanceof TypeError) {
        return undefined;
      }
      throw error;
    }
  }

  private buildImagePayload(imageBase64: string): { data: string } {
    return {
      data: stripDataUriPrefix(imageBase64),
    };
  }

  private readonly isRetryableError = (error: any, attempt: number) => {
    const status = error?.response?.status;
    if (!status) {
      return attempt <= 3;
    }
    if (status >= 500 || status === 429) {
      return true;
    }
    return false;
  };

  private createSuccessEvent(params: SuccessEventParams): WorkflowEvent {
    const { pubkey } = params;
    return {
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', pubkey, 'wss://clientnode.com/', 'user']],
      content: '',
    };
  }

  private createFailureEvent(params: FailureEventParams): WorkflowEvent {
    const {
      pubkey,
      userId,
      reason = 'insufficient Information',
      content,
    } = params;
    return {
      kind: 1984,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', userId, reason],
        ['p', pubkey],
      ],
      content,
    };
  }
}

function toArray(value?: string[] | string): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(
      item => typeof item === 'string' && item.trim().length > 0
    );
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value];
  }
  return [];
}

function stripDataUriPrefix(value: string): string {
  const commaIndex = value.indexOf(',');
  return commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
}

function serializeResult(
  result?: VerificationFlowResult
): SerializedVerificationResult | undefined {
  if (!result) {
    return undefined;
  }

  return {
    ...result,
    createdAt: result.createdAt?.toISOString(),
    updatedAt: result.updatedAt?.toISOString(),
  };
}

async function resolveImageSource(
  raw: string,
  kind: 'document' | 'selfie'
): Promise<ResolvedImage> {
  const normalizedInput = normalizeImagePayload(raw);
  const sanitizedBase64 = normalizedInput.base64?.replace(/\s+/g, '') ?? '';

  if (!sanitizedBase64) {
    throw new Error('Image payload is empty');
  }

  let originalBuffer: Buffer;
  try {
    originalBuffer = Buffer.from(sanitizedBase64, 'base64');
  } catch (error) {
    console.warn('Failed to decode base64 payload into buffer.', error);
    throw new Error('Invalid image data: unable to decode base64 payload');
  }

  return {
    normalized: {
      base64: sanitizedBase64,
      mimeType: normalizedInput.mimeType ?? 'image/jpeg',
      bytes: originalBuffer.length,
      resourceType: 'image',
    },
    base64: sanitizedBase64,
  };
}
