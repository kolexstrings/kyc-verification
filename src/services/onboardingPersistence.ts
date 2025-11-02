import { Prisma, OnboardingEventType, OnboardingStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { DocumentVerificationResult } from './innovatricsClient';

type JsonValue = Prisma.InputJsonValue | Prisma.NullTypes.JsonNull;

interface InitializeParams {
  userId: string;
  externalId?: string;
  innovatricsCustomerId: string;
}

interface RecordErrorParams {
  code?: string;
  message: string;
  markFailed?: boolean;
  context?: JsonValue;
}

interface RecordRetryParams {
  reason: string;
  context?: JsonValue;
}

type UpdateEvent = {
  type: OnboardingEventType;
  payload?: JsonValue;
};

async function updateRecord(
  innovatricsCustomerId: string,
  data: Prisma.CustomerOnboardingUpdateInput,
  event?: UpdateEvent
) {
  return prisma.customerOnboarding.update({
    where: { innovatricsCustomerId },
    data: {
      ...data,
      ...(event
        ? {
            events: {
              create: {
                type: event.type,
                payload: event.payload ?? Prisma.JsonNull,
              },
            },
          }
        : {}),
    },
  });
}

async function safeUpdate(
  innovatricsCustomerId: string,
  data: Prisma.CustomerOnboardingUpdateInput,
  event?: UpdateEvent
) {
  try {
    return await updateRecord(innovatricsCustomerId, data, event);
  } catch (error) {
    console.error('Failed to update onboarding record', {
      innovatricsCustomerId,
      error,
    });
    return null;
  }
}

export async function initializeOnboardingRecord({
  userId,
  externalId,
  innovatricsCustomerId,
}: InitializeParams) {
  return prisma.customerOnboarding.upsert({
    where: { innovatricsCustomerId },
    update: {
      userId,
      externalId: externalId ?? null,
      status: OnboardingStatus.IN_PROGRESS,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
    create: {
      userId,
      externalId: externalId ?? null,
      innovatricsCustomerId,
      status: OnboardingStatus.IN_PROGRESS,
      events: {
        create: {
          type: OnboardingEventType.STATUS_CHANGE,
          payload: {
            status: OnboardingStatus.IN_PROGRESS,
            at: new Date().toISOString(),
          },
        },
      },
    },
  });
}

export async function getOnboardingByInnovatricsId(innovatricsCustomerId: string) {
  return prisma.customerOnboarding.findUnique({
    where: { innovatricsCustomerId },
  });
}

export async function recordDocumentResult(
  innovatricsCustomerId: string,
  documentResult: DocumentVerificationResult
) {
  return safeUpdate(
    innovatricsCustomerId,
    {
      documentSummary: (documentResult.summary as unknown as JsonValue) ?? Prisma.JsonNull,
      documentPages: (documentResult.pages as unknown as JsonValue) ?? Prisma.JsonNull,
      inspection: (documentResult.inspection as unknown as JsonValue) ?? Prisma.JsonNull,
      disclosedInspection: (documentResult.disclosedInspection as unknown as JsonValue) ?? Prisma.JsonNull,
    },
    {
      type: OnboardingEventType.STEP_RESULT,
      payload: {
        step: 'document',
        summary: (documentResult.summary as unknown as JsonValue) ?? Prisma.JsonNull,
      } as JsonValue,
    }
  );
}

export async function recordSelfieResult(innovatricsCustomerId: string, selfieResult: JsonValue) {
  return safeUpdate(
    innovatricsCustomerId,
    {
      selfieResult: selfieResult ?? Prisma.JsonNull,
    },
    {
      type: OnboardingEventType.STEP_RESULT,
      payload: {
        step: 'selfie_upload',
      },
    }
  );
}

export async function recordFaceDetection(
  innovatricsCustomerId: string,
  detectionResult: JsonValue,
  maskResult: JsonValue
) {
  return safeUpdate(
    innovatricsCustomerId,
    {
      faceComparison: detectionResult ?? Prisma.JsonNull,
      livenessResult: maskResult ?? Prisma.JsonNull,
    },
    {
      type: OnboardingEventType.STEP_RESULT,
      payload: {
        step: 'face_detection',
      },
    }
  );
}

export async function recordLivenessResult(
  innovatricsCustomerId: string,
  livenessResult: JsonValue
) {
  return safeUpdate(
    innovatricsCustomerId,
    {
      livenessResult: livenessResult ?? Prisma.JsonNull,
    },
    {
      type: OnboardingEventType.STEP_RESULT,
      payload: {
        step: 'liveness',
      },
    }
  );
}

export async function recordFaceComparison(
  innovatricsCustomerId: string,
  comparisonResult: JsonValue
) {
  return safeUpdate(
    innovatricsCustomerId,
    {
      faceComparison: comparisonResult ?? Prisma.JsonNull,
    },
    {
      type: OnboardingEventType.STEP_RESULT,
      payload: {
        step: 'face_comparison',
      },
    }
  );
}

export async function markFinished(innovatricsCustomerId: string) {
  return safeUpdate(
    innovatricsCustomerId,
    {
      status: OnboardingStatus.FINISHED,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
    {
      type: OnboardingEventType.STATUS_CHANGE,
      payload: {
        status: OnboardingStatus.FINISHED,
        at: new Date().toISOString(),
      },
    }
  );
}

export async function recordError(
  innovatricsCustomerId: string,
  { code, message, markFailed, context }: RecordErrorParams
) {
  return safeUpdate(
    innovatricsCustomerId,
    {
      status: markFailed ? OnboardingStatus.FAILED : OnboardingStatus.IN_PROGRESS,
      lastErrorCode: code ?? null,
      lastErrorMessage: message,
    },
    {
      type: OnboardingEventType.ERROR,
      payload: (
        {
          code,
          message,
          context: context ?? Prisma.JsonNull,
          at: new Date().toISOString(),
        } as unknown
      ) as JsonValue,
    }
  );
}

export async function recordRetry(
  innovatricsCustomerId: string,
  { reason, context }: RecordRetryParams
) {
  return safeUpdate(
    innovatricsCustomerId,
    {
      retryCount: {
        increment: 1,
      },
    },
    {
      type: OnboardingEventType.RETRY,
      payload: (
        {
          reason,
          context: context ?? Prisma.JsonNull,
          at: new Date().toISOString(),
        } as unknown
      ) as JsonValue,
    }
  );
}
