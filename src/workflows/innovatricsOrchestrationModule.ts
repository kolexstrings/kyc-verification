import sharp from 'sharp';

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
  image: string;
  selfieImages?: string[] | string;
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
  };
  livenessCheck?: LivenessResult;
}

export type SerializedVerificationResult = Omit<VerificationFlowResult, 'createdAt' | 'updatedAt'> & {
  createdAt?: string;
  updatedAt?: string;
};

interface ResolvedImage {
  normalized: NormalizedImage;
  base64: string;
}

interface FailureEventParams {
  customerId?: string;
  userIdentifier?: string;
  reason: string;
  message: string;
  details?: SerializedVerificationResult;
}

interface SuccessEventParams {
  customerId: string;
  userIdentifier?: string;
  relayUrl?: string;
}

export interface VerificationOutcome {
  event: WorkflowEvent;
  results?: SerializedVerificationResult;
}

type HttpMethod = 'GET' | 'POST' | 'PUT';

interface HttpResponse<T> {
  data: T;
}

class HttpError extends Error {
  constructor(message: string, public readonly response?: { status: number; data?: any }) {
    super(message);
    this.name = 'HttpError';
  }
}

export class InnovatricsEventWorkflow {
  private readonly requestTimeoutMs = 120000;

  constructor(private readonly config: InnovatricsWorkflowConfig) {
  }

  async run(input: VerificationInput): Promise<VerificationOutcome> {
    const documentImages = toArray(input.identificationDocumentImage);
    const additionalSelfiesInput = toArray(input.selfieImages);
    const primarySelfieInput = typeof input.image === 'string' ? input.image.trim() : '';
    const userIdentifier = typeof input.userId === 'string' ? input.userId.trim() : undefined;

    if (!documentImages[0] || !primarySelfieInput) {
      return {
        event: this.createFailureEvent({
          reason: 'missing_input',
          message: 'Document front image and primary selfie are required',
          ...(userIdentifier ? { userIdentifier } : {}),
        }),
      };
    }

    let customerId: string | undefined;
    let externalId = userIdentifier;
    let verificationResult: VerificationFlowResult | undefined;

    try {
      const documentFront = await resolveImageSource(documentImages[0]);
      const documentBack = documentImages[1]
        ? await resolveImageSource(documentImages[1])
        : undefined;
      const primarySelfie = await resolveImageSource(primarySelfieInput);

      const supplementalSelfies: string[] = [];
      for (const selfie of additionalSelfiesInput) {
        try {
          const resolved = await resolveImageSource(selfie);
          supplementalSelfies.push(resolved.base64);
        } catch (selfieError) {
          console.warn('Skipping invalid supplemental selfie image', selfieError);
        }
      }

      const customerResponse = await this.createCustomer();
      customerId = customerResponse.id;

      if (!externalId) {
        externalId = `external_${Date.now()}`;
      }

      await this.storeCustomer(customerId, {
        externalId,
        onboardingStatus: 'IN_PROGRESS',
      });

      const verification: VerificationFlowResult = {
        customerId,
        externalId,
        overallStatus: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(userIdentifier ? { userId: userIdentifier } : {}),
      };

      verificationResult = verification;

      const documentVerification = await this.verifyDocument({
        customerId,
        frontImage: documentFront.base64,
        ...(documentBack ? { backImage: documentBack.base64 } : {}),
        ...(input.documentType ? { documentType: input.documentType } : {}),
        ...(input.firstNationality ? { issuingCountry: input.firstNationality } : {}),
      });
      verification.documentVerification = documentVerification;

      const selfieUpload = await this.uploadSelfie(customerId, primarySelfie.base64);
      verification.selfieUpload = selfieUpload;

      const faceDetection = await this.detectFace(primarySelfie.base64);
      const maskResult = await this.checkFaceMask(faceDetection.id);
      verification.faceDetection = {
        id: faceDetection.id,
        detection: faceDetection.detection,
        maskResult,
      };

      const inspection = await this.inspectCustomer(customerId);
      const faceMatchScore = inspection?.faceMatch?.score ?? 0;
      verification.faceComparison = {
        score: faceMatchScore,
      };

      const livenessOptions = {
        ...(supplementalSelfies.length > 0 ? { additionalSelfies: supplementalSelfies } : {}),
        deepfakeCheck: true,
      } as const;

      const livenessResult = await this.evaluatePassiveLiveness(customerId, livenessOptions);
      verification.livenessCheck = livenessResult;

      verification.overallStatus = 'completed';
      verification.updatedAt = new Date();

      await this.storeCustomer(customerId, {
        externalId,
        onboardingStatus: 'FINISHED',
      });

      const serialized = serializeResult(verification);
      if (!serialized) {
        throw new Error('Failed to serialize verification results');
      }

      const resolvedUserTag = verification.userId ?? verification.externalId;
      const successEvent = this.createSuccessEvent({
        customerId,
        ...(resolvedUserTag ? { userIdentifier: resolvedUserTag } : {}),
        ...(this.config.relayUrl ? { relayUrl: this.config.relayUrl } : {}),
      });

      return {
        event: successEvent,
        results: serialized,
      };
    } catch (error: any) {
      if (verificationResult) {
        verificationResult.overallStatus = 'failed';
        verificationResult.updatedAt = new Date();
      }

      const serialized = serializeResult(verificationResult);

      const failureParams: FailureEventParams = {
        reason: 'verification_failed',
        message: error?.message || 'Verification failed',
        ...(customerId ? { customerId } : {}),
        ...(() => {
          const resolvedUserTag = verificationResult?.userId ?? externalId;
          return resolvedUserTag ? { userIdentifier: resolvedUserTag } : {};
        })(),
        ...(serialized ? { details: serialized } : {}),
      };

      const failureEvent = this.createFailureEvent(failureParams);

      return serialized
        ? { event: failureEvent, results: serialized }
        : { event: failureEvent };
    }
  }

  private async createCustomer(): Promise<{ id: string }> {
    const response = await this.post<{ id: string }>('/customers');
    return response.data;
  }

  private async storeCustomer(
    customerId: string,
    payload: { externalId?: string; onboardingStatus: 'IN_PROGRESS' | 'FINISHED' }
  ): Promise<void> {
    await this.post(`/customers/${customerId}/store`, payload);
  }

  private async verifyDocument(params: {
    customerId: string;
    frontImage: string;
    backImage?: string;
    documentType?: string;
    issuingCountry?: string;
  }): Promise<DocumentVerificationResult> {
    const { customerId, frontImage, backImage, documentType, issuingCountry } = params;

    const classificationAdvice: Record<string, any> = {};
    if (documentType) {
      classificationAdvice.types = [documentType];
    }
    if (issuingCountry) {
      classificationAdvice.countries = [issuingCountry];
    }

    const createDocumentPayload: Record<string, any> = {
      sources: ['VIZ', 'MRZ', 'DOCUMENT_PORTRAIT'],
    };
    if (Object.keys(classificationAdvice).length > 0) {
      createDocumentPayload.advice = { classification: classificationAdvice };
    }

    const documentResponse = await withRetry(() =>
      this.put(`/customers/${customerId}/document`, createDocumentPayload),
    {
      shouldRetry: this.isRetryableError,
    });

    const pages: DocumentPageResult[] = [];

    const frontPageResponse = await withRetry(() =>
      this.put(`/customers/${customerId}/document/pages`, {
        image: this.buildImagePayload(frontImage),
        advice: {
          classification: {
            pageTypes: ['front'],
          },
        },
      }),
    {
      shouldRetry: this.isRetryableError,
    });
    pages.push(frontPageResponse.data);

    if (backImage) {
      const backPageResponse = await withRetry(() =>
        this.put(`/customers/${customerId}/document/pages`, {
          image: this.buildImagePayload(backImage),
          advice: {
            classification: {
              pageTypes: ['back'],
            },
          },
        }),
      {
        shouldRetry: this.isRetryableError,
      });
      pages.push(backPageResponse.data);
    }

    const inspectionResponse = await withRetry(() =>
      this.post(`/customers/${customerId}/document/inspect`),
    {
      shouldRetry: this.isRetryableError,
    });

    let disclosedInspection: any | undefined;
    try {
      const disclosedResponse = await withRetry(() =>
        this.post(`/customers/${customerId}/document/inspect/disclose`),
      {
        shouldRetry: this.isRetryableError,
      });
      disclosedInspection = disclosedResponse.data;
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

  private async checkFaceMask(faceId: string): Promise<{ score: number }> {
    const response = await this.get(`/faces/${faceId}/face-mask`);
    return response.data;
  }

  private async inspectCustomer(customerId: string): Promise<any> {
    const response = await this.post(`/customers/${customerId}/inspect`);
    return response.data;
  }

  private async evaluatePassiveLiveness(
    customerId: string,
    options: { additionalSelfies?: string[]; deepfakeCheck?: boolean }
  ): Promise<LivenessResult> {
    await this.ensureLivenessRecord(customerId);

    if (options.additionalSelfies && options.additionalSelfies.length > 0) {
      for (const selfie of options.additionalSelfies) {
        await this.uploadAdditionalSelfie(customerId, selfie);
      }
    }

    const evaluationResponse = await this.post(
      `/customers/${customerId}/liveness/evaluation`,
      {
        type: 'PASSIVE_LIVENESS',
      }
    );

    const baseResult = evaluationResponse.data ?? {};

    if (options.deepfakeCheck) {
      try {
        const deepfakeResponse = await this.post(
          `/customers/${customerId}/liveness/evaluation/extended`,
          {
            type: 'DEEPFAKE',
            livenessResources: ['PASSIVE'],
          }
        );
        const deepfakeResult = deepfakeResponse.data ?? {};
        return {
          confidence: baseResult.confidence ?? 0,
          status: baseResult.status ?? 'not_live',
          isDeepfake: deepfakeResult.isDeepfake,
          deepfakeConfidence: deepfakeResult.confidence,
        };
      } catch (deepfakeError) {
        console.warn('Deepfake evaluation failed', deepfakeError);
      }
    }

    return {
      confidence: baseResult.confidence ?? 0,
      status: baseResult.status ?? 'not_live',
    };
  }

  private async ensureLivenessRecord(customerId: string): Promise<void> {
    await this.put(`/customers/${customerId}/liveness`);
  }

  private async uploadAdditionalSelfie(
    customerId: string,
    imageBase64: string
  ): Promise<void> {
    await this.post(`/customers/${customerId}/liveness/selfies`, {
      image: this.buildImagePayload(imageBase64),
    });
  }

  private async request<T = any>(method: HttpMethod, path: string, body?: unknown): Promise<HttpResponse<T>> {
    const url = new URL(path, this.config.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const hasBody = body !== undefined;
      const response = await fetch(
        url,
        {
          method,
          headers: this.buildHeaders(hasBody),
          signal: controller.signal,
          ...(hasBody ? { body: JSON.stringify(body) } : {}),
        }
      );

      const parsedBody = await this.parseResponseBody(response);

      if (!response.ok) {
        throw new HttpError(`Request failed with status ${response.status}` as const, {
          status: response.status,
          data: parsedBody,
        });
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

  private post<T = any>(path: string, body?: unknown): Promise<HttpResponse<T>> {
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
    const { customerId, userIdentifier, relayUrl } = params;
    const tags: EventTag[] = [];

    const eventTag: string[] = ['e', customerId, 'kyc_verification'];
    tags.push(eventTag as EventTag);

    if (userIdentifier) {
      const userTag: string[] = ['p', userIdentifier];
      if (relayUrl) {
        userTag.push(relayUrl);
      }
      userTag.push('user');
      tags.push(userTag as EventTag);
    }

    return {
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    };
  }

  private createFailureEvent(params: FailureEventParams): WorkflowEvent {
    const { customerId, userIdentifier, reason, message, details } = params;
    const tags: EventTag[] = [];

    const eventTag: string[] = ['e', customerId ?? 'unknown', reason];
    tags.push(eventTag as EventTag);

    if (userIdentifier) {
      const userTag: string[] = ['p', userIdentifier];
      userTag.push('user');
      tags.push(userTag as EventTag);
    }

    const contentPayload: Record<string, unknown> = {
      message,
    };

    if (details) {
      contentPayload.details = details;
    }

    return {
      kind: 1984,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify(contentPayload),
    };
  }
}

function toArray(value?: string[] | string): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string' && item.trim().length > 0);
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

async function resolveImageSource(raw: string): Promise<ResolvedImage> {
  const normalizedInput = normalizeImagePayload(raw);
  if (!normalizedInput.base64) {
    throw new Error('Image payload is empty');
  }

  const originalBuffer = Buffer.from(normalizedInput.base64, 'base64');
  const metadata = await sharp(originalBuffer).metadata();

  const minDimension = 1800;
  const maxDimension = 3000;

  let targetWidth = metadata.width ?? minDimension;
  let targetHeight = metadata.height ?? minDimension;

  if (metadata.width && metadata.height) {
    const longerSide = Math.max(metadata.width, metadata.height);

    if (longerSide < minDimension) {
      const scale = minDimension / longerSide;
      targetWidth = Math.round(metadata.width * scale);
      targetHeight = Math.round(metadata.height * scale);
    } else if (longerSide > maxDimension) {
      const scale = maxDimension / longerSide;
      targetWidth = Math.round(metadata.width * scale);
      targetHeight = Math.round(metadata.height * scale);
    }
  }

  const resizedBuffer = await sharp(originalBuffer)
    .resize(targetWidth, targetHeight, {
      fit: 'fill',
      kernel: 'lanczos3',
    })
    .jpeg({
      quality: 90,
      mozjpeg: true,
    })
    .toBuffer();

  const resizedMetadata = await sharp(resizedBuffer).metadata();
  const base64 = resizedBuffer.toString('base64');

  const normalized: NormalizedImage = {
    base64,
    mimeType: 'image/jpeg',
    bytes: resizedBuffer.length,
    width: resizedMetadata.width,
    height: resizedMetadata.height,
    resourceType: 'image',
  };

  return {
    normalized,
    base64,
  };
}
