import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { config } from '../config/env';
import { withRetry, RetryOptions } from '../utils/retry';

export interface CustomerStoreRequest {
  externalId?: string;
  onboardingStatus: 'IN_PROGRESS' | 'FINISHED';
}

export interface CreateCustomerResponse {
  id: string;
  links: {
    self: string;
  };
}

export interface CreateFaceRequest {
  image: string; // base64 encoded image
}

export interface CreateFaceResponse {
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
  links: {
    self: string;
    template: string;
  };
}

export interface FaceSimilarityRequest {
  referenceFace: string; // URL to reference face
  referenceFaceTemplate?: string; // base64 template
}

export interface FaceSimilarityResponse {
  score: number; // 0-1 similarity score
}

export interface LivenessCheckOptions {
  deepfakeCheck?: boolean | undefined;
  // Add other liveness options as needed
}

export interface CreateLivenessRequest {
  challengeType?: 'passive' | 'motion' | 'expression'; // Analysis approach, not user interaction
  options?: LivenessCheckOptions;
}

export interface LivenessChallengeResponse {
  challengeId: string;
  challengeType: string;
  instructions: string;
}

export interface DocumentVerificationRequest {
  customerId: string;
  frontImage: string;
  backImage?: string;
  documentType?: string;
  issuingCountry?: string;
  onRetry?: (params: {
    stage:
      | 'create_document'
      | 'upload_page_front'
      | 'upload_page_back'
      | 'inspect_document'
      | 'disclose_inspection';
    attempt: number;
    delayMs: number;
    error: any;
  }) => void;
}

export interface DocumentPageResult {
  documentType?: {
    type?: string;
    issuingCountry?: string;
    edition?: string;
  };
  pageType?: 'front' | 'back' | 'unknown';
  detection?: any;
  errorCode?: string;
  warnings?: string[];
  links?: any;
}

export interface DocumentVerificationSummary {
  documentType?: string;
  issuingCountry?: string;
  warnings?: string[];
  errors?: string[];
}

export interface DocumentVerificationResult {
  document?: any;
  summary: DocumentVerificationSummary;
  pages: DocumentPageResult[];
  inspection?: any;
  disclosedInspection?: any;
}

export class InnovatricsService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.innovatrics.baseUrl,
      headers: {
        Authorization: `Bearer ${config.innovatrics.bearerToken}`,
        'Content-Type': 'application/json',
        Host: config.innovatrics.host,
      },
      timeout: 60000,
      proxy: false,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
        keepAlive: true,
      }),
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      error => {
        console.error('Innovatrics API Error:', {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message,
        });
        return Promise.reject(error);
      }
    );
  }

  // Customer Management
  async createCustomer(): Promise<CreateCustomerResponse> {
    try {
      console.log('Creating customer in Innovatrics');
      console.log('Using base URL:', config.innovatrics.baseUrl);
      console.log('Bearer token configured:', !!config.innovatrics.bearerToken);

      const response = await this.client.post('/customers');
      console.log('Customer creation successful:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('Detailed customer creation error:', {
        status: error.response?.status,
        data: error.response?.data,
        headers: error.response?.headers,
        config: {
          url: error.config?.url,
          method: error.config?.method,
          baseURL: error.config?.baseURL,
          headers: error.config?.headers,
        },
      });
      throw new Error(
        `Failed to create customer: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async storeCustomer(
    customerId: string,
    payload: CustomerStoreRequest
  ): Promise<void> {
    try {
      await this.client.post(`/customers/${customerId}/store`, payload);
    } catch (error: any) {
      throw new Error(
        `Failed to store customer: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async updateCustomerOnboardingStatus(
    customerId: string,
    status: 'IN_PROGRESS' | 'FINISHED',
    externalId?: string
  ): Promise<void> {
    return this.storeCustomer(customerId, {
      onboardingStatus: status,
      ...(externalId ? { externalId } : {}),
    });
  }

  // Face Biometrics
  async detectFace(imageData: string): Promise<CreateFaceResponse> {
    try {
      const response = await this.client.post('/faces', {
        image: imageData, // base64 encoded
      });
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to detect face: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async compareFaces(
    probeFaceId: string,
    referenceData: { referenceFace?: string; referenceFaceTemplate?: string }
  ): Promise<FaceSimilarityResponse> {
    try {
      const response = await this.client.post(
        `/faces/${probeFaceId}/similarity`,
        referenceData
      );
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to compare faces: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async getFaceTemplate(
    faceId: string
  ): Promise<{ data: string; version: string }> {
    try {
      const response = await this.client.get(`/faces/${faceId}/face-template`);
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to get face template: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async checkFaceMask(faceId: string): Promise<{ score: number }> {
    try {
      const response = await this.client.get(`/faces/${faceId}/face-mask`);
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to check face mask: ${error.response?.data?.message || error.message}`
      );
    }
  }

  // Liveness Detection
  async createLivenessChallenge(
    customerId: string,
    challengeRequest?: CreateLivenessRequest
  ): Promise<LivenessChallengeResponse> {
    try {
      const response = await this.client.put(
        `/customers/${customerId}/liveness/records/challenge`,
        challengeRequest || {}
      );
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to create liveness challenge: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async submitLivenessData(
    customerId: string,
    livenessData: {
      image: string;
      challengeId?: string;
      options?: LivenessCheckOptions;
    }
  ): Promise<{
    confidence: number;
    status: string;
    isDeepfake?: boolean;
    deepfakeConfidence?: number;
  }> {
    try {
      const response = await this.client.put(
        `/customers/${customerId}/liveness`,
        {
          image: livenessData.image,
          challengeId: livenessData.challengeId,
          options: livenessData.options || {},
        }
      );
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to submit liveness data: ${error.response?.data?.message || error.message}`
      );
    }
  }

  /**
   * Evaluate liveness with optional deepfake detection
   * @param customerId - The customer ID
   * @param options - Liveness check options
   * @returns Liveness check results
   */
  async evaluateLiveness(
    customerId: string,
    options: {
      challengeType?: 'passive' | 'motion' | 'expression';
      deepfakeCheck?: boolean;
    } = {}
  ): Promise<{
    confidence: number;
    status: 'live' | 'not_live' | 'suspicious';
    isDeepfake?: boolean;
    deepfakeConfidence?: number;
  }> {
    try {
      // Create a liveness challenge
      const challenge = await this.createLivenessChallenge(customerId, {
        challengeType: options.challengeType || 'passive',
        options: {
          deepfakeCheck: options.deepfakeCheck,
        },
      });

      // Get the selfie that was previously uploaded
      const selfie = await this.getSelfie(customerId);

      // Submit the selfie for liveness check
      const livenessOptions: LivenessCheckOptions = {};
      if (options.deepfakeCheck !== undefined) {
        livenessOptions.deepfakeCheck = options.deepfakeCheck;
      }

      const result = await this.submitLivenessData(customerId, {
        image: selfie.image,
        challengeId: challenge.challengeId,
        options: livenessOptions,
      });

      const response = {
        confidence: result.confidence,
        status: result.status as 'live' | 'not_live' | 'suspicious',
        ...(result.isDeepfake !== undefined && {
          isDeepfake: result.isDeepfake,
        }),
        ...(result.deepfakeConfidence !== undefined && {
          deepfakeConfidence: result.deepfakeConfidence,
        }),
      };

      return response;
    } catch (error: any) {
      throw new Error(`Liveness evaluation failed: ${error.message}`);
    }
  }

  async deleteLivenessData(customerId: string): Promise<void> {
    try {
      await this.client.delete(`/api/v1/customers/${customerId}/liveness`);
    } catch (error: any) {
      throw new Error(
        `Failed to delete liveness data: ${error.response?.data?.message || error.message}`
      );
    }
  }

  // Document Verification
  async verifyDocument(
    request: DocumentVerificationRequest
  ): Promise<DocumentVerificationResult> {
    const { customerId, frontImage, backImage, documentType, issuingCountry } = request;

    try {
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
        createDocumentPayload.advice = {
          classification: classificationAdvice,
        };
      }

      const documentRetryOptions = {
        shouldRetry: (error: any) => this.isRetryableError(error),
        ...(request.onRetry
          ? {
              onRetry: ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: any }) => {
                request.onRetry?.({
                  stage: 'create_document',
                  attempt,
                  delayMs,
                  error,
                });
              },
            }
          : {}),
      } satisfies RetryOptions;

      const documentResponse = await withRetry(
        () =>
          this.client.put(`/customers/${customerId}/document`, createDocumentPayload),
        documentRetryOptions
      );

      const pages: DocumentPageResult[] = [];

      const frontPageRetryOptions = {
        shouldRetry: (error: any) => this.isRetryableError(error),
        ...(request.onRetry
          ? {
              onRetry: ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: any }) => {
                request.onRetry?.({
                  stage: 'upload_page_front',
                  attempt,
                  delayMs,
                  error,
                });
              },
            }
          : {}),
      } satisfies RetryOptions;

      const frontPageResponse = await withRetry(
        () =>
          this.client.put(`/customers/${customerId}/document/pages`, {
            image: {
              data: this.normalizeBase64Image(frontImage),
            },
            advice: {
              classification: {
                pageTypes: ['front'],
              },
            },
          }),
        frontPageRetryOptions
      );
      pages.push(frontPageResponse.data);

      if (backImage) {
        const backPageRetryOptions = {
          shouldRetry: (error: any) => this.isRetryableError(error),
          ...(request.onRetry
            ? {
                onRetry: ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: any }) => {
                  request.onRetry?.({
                    stage: 'upload_page_back',
                    attempt,
                    delayMs,
                    error,
                  });
                },
              }
            : {}),
        } satisfies RetryOptions;

        const backPageResponse = await withRetry(
          () =>
            this.client.put(`/customers/${customerId}/document/pages`, {
              image: {
                data: this.normalizeBase64Image(backImage),
              },
              advice: {
                classification: {
                  pageTypes: ['back'],
                },
              },
            }),
          backPageRetryOptions
        );
        pages.push(backPageResponse.data);
      }

      const inspectRetryOptions = {
        shouldRetry: (error: any) => this.isRetryableError(error),
        ...(request.onRetry
          ? {
              onRetry: ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: any }) => {
                request.onRetry?.({
                  stage: 'inspect_document',
                  attempt,
                  delayMs,
                  error,
                });
              },
            }
          : {}),
      } satisfies RetryOptions;

      const inspectionResponse = await withRetry(
        () => this.client.post(`/customers/${customerId}/document/inspect`),
        inspectRetryOptions
      );

      let disclosedInspection: any | undefined;
      try {
        const discloseRetryOptions = {
          shouldRetry: (error: any) => this.isRetryableError(error),
          ...(request.onRetry
            ? {
                onRetry: ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: any }) => {
                  request.onRetry?.({
                    stage: 'disclose_inspection',
                    attempt,
                    delayMs,
                    error,
                  });
                },
              }
            : {}),
        } satisfies RetryOptions;

        const disclosedResponse = await withRetry(
          () => this.client.post(`/customers/${customerId}/document/inspect/disclose`),
          discloseRetryOptions
        );
        disclosedInspection = disclosedResponse.data;
      } catch (discloseError: any) {
        console.warn('Document inspection disclosure failed:', {
          status: discloseError.response?.status,
          message: discloseError.message,
        });
      }

      const frontPage = pages.find(page => page.pageType === 'front') ?? pages[0];
      const collectedWarnings = pages.flatMap(page => page.warnings ?? []);
      const collectedErrors = pages
        .map(page => page.errorCode)
        .filter((code): code is string => Boolean(code));

      const summary: DocumentVerificationSummary = {
        ...(frontPage?.documentType?.type
          ? { documentType: frontPage.documentType.type }
          : {}),
        ...(frontPage?.documentType?.issuingCountry
          ? { issuingCountry: frontPage.documentType.issuingCountry }
          : {}),
        ...(collectedWarnings.length
          ? { warnings: Array.from(new Set(collectedWarnings)) }
          : {}),
        ...(collectedErrors.length
          ? { errors: Array.from(new Set(collectedErrors)) }
          : {}),
      };

      return {
        document: documentResponse.data,
        summary,
        pages,
        inspection: inspectionResponse.data,
        disclosedInspection,
      };
    } catch (error: any) {
      throw new Error(
        `Failed to process document: ${error.response?.data?.message || error.message}`
      );
    }
  }

  // Selfie Management (Customer-scoped)
  async uploadSelfie(
    customerId: string,
    selfieData: string
  ): Promise<{ id: string }> {
    try {
      const response = await this.client.put(
        `/customers/${customerId}/selfie`,
        {
          image: selfieData, // base64 encoded
        }
      );
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to upload selfie: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async getSelfie(customerId: string): Promise<{ image: string }> {
    try {
      const response = await this.client.get(
        `/api/v1/customers/${customerId}/selfie`
      );
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to get selfie: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async deleteSelfie(customerId: string): Promise<void> {
    try {
      await this.client.delete(`/api/v1/customers/${customerId}/selfie`);
    } catch (error: any) {
      throw new Error(
        `Failed to delete selfie: ${error.response?.data?.message || error.message}`
      );
    }
  }

  // Utility method for binary uploads (for images)
  async uploadBinaryImage(
    customerId: string,
    imageBuffer: Buffer,
    endpoint: string
  ): Promise<any> {
    try {
      const response = await this.client.put(endpoint, imageBuffer, {
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      });
      return response.data;
    } catch (error: any) {
      throw new Error(
        `Failed to upload binary image: ${error.response?.data?.message || error.message}`
      );
    }
  }

  private normalizeBase64Image(image: string): string {
    if (!image) {
      return image;
    }

    const commaIndex = image.indexOf(',');
    const base64Data = commaIndex >= 0 ? image.slice(commaIndex + 1) : image;
    return base64Data.trim();
  }

  private isRetryableError(error: any): boolean {
    const status = error?.response?.status;
    if (!status) {
      return true;
    }

    if (status >= 500 || status === 429) {
      return true;
    }

    return false;
  }
}
