import { getSupabaseClient } from '../lib/supabaseClient';
import { DocumentVerificationResult } from './innovatricsClient';
import { NormalizedImage } from '../utils/image';

type JsonValue = unknown;

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

type OnboardingEventType = 'STATUS_CHANGE' | 'STEP_RESULT' | 'ERROR' | 'RETRY';

interface OnboardingEvent {
  type: OnboardingEventType;
  payload?: JsonValue;
}

interface CustomerOnboardingRow {
  id: string;
  retry_count?: number | null;
}

const STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  FINISHED: 'FINISHED',
  FAILED: 'FAILED',
} as const;

function toDbJson(value: unknown): JsonValue {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn('Failed to serialise value for Supabase persistence', error);
    return null;
  }
}

async function fetchOnboardingRow(innovatricsCustomerId: string): Promise<CustomerOnboardingRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('customer_onboarding')
    .select('id,retry_count')
    .eq('innovatrics_customer_id', innovatricsCustomerId)
    .maybeSingle();

  if (error) {
    console.error('Failed to load onboarding record', {
      innovatricsCustomerId,
      error,
    });
    return null;
  }

  return data ?? null;
}

async function insertEvent(customerId: string, event: OnboardingEvent) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('onboarding_events').insert({
    customer_onboarding_id: customerId,
    type: event.type,
    payload: toDbJson(event.payload ?? null),
  });

  if (error) {
    console.error('Failed to record onboarding event', {
      customerId,
      event,
      error,
    });
  }
}

async function updateOnboardingRecord(options: {
  innovatricsCustomerId: string;
  fields: Record<string, unknown>;
  event?: OnboardingEvent;
  existing?: CustomerOnboardingRow | null;
}) {
  const { innovatricsCustomerId, fields, event, existing } = options;
  const supabase = getSupabaseClient();

  let record = existing ?? (await fetchOnboardingRow(innovatricsCustomerId));

  if (!record) {
    console.warn('Cannot update onboarding record because it was not found', {
      innovatricsCustomerId,
    });
    return null;
  }

  const { data, error } = await supabase
    .from('customer_onboarding')
    .update(fields)
    .eq('id', record.id)
    .select('id')
    .single();

  if (error) {
    console.error('Failed to update onboarding record', {
      innovatricsCustomerId,
      fields,
      error,
    });
    return null;
  }

  if (event) {
    await insertEvent(record.id, event);
  }

  return data;
}

export async function initializeOnboardingRecord({
  userId,
  externalId,
  innovatricsCustomerId,
}: InitializeParams) {
  const supabase = getSupabaseClient();
  const existing = await fetchOnboardingRow(innovatricsCustomerId);

  if (existing) {
    return updateOnboardingRecord({
      innovatricsCustomerId,
      existing,
      fields: {
        user_id: userId,
        external_id: externalId ?? null,
        status: STATUS.IN_PROGRESS,
        last_error_code: null,
        last_error_message: null,
      },
      event: {
        type: 'STATUS_CHANGE',
        payload: {
          status: STATUS.IN_PROGRESS,
          at: new Date().toISOString(),
        },
      },
    });
  }

  const { data, error } = await supabase
    .from('customer_onboarding')
    .insert({
      user_id: userId,
      external_id: externalId ?? null,
      innovatrics_customer_id: innovatricsCustomerId,
      status: STATUS.IN_PROGRESS,
      retry_count: 0,
      last_error_code: null,
      last_error_message: null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('Failed to create onboarding record', {
      innovatricsCustomerId,
      error,
    });
    throw new Error('Failed to create onboarding record');
  }

  await insertEvent(data.id, {
    type: 'STATUS_CHANGE',
    payload: {
      status: STATUS.IN_PROGRESS,
      at: new Date().toISOString(),
    },
  });

  return data;
}

export async function getOnboardingByInnovatricsId(innovatricsCustomerId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('customer_onboarding')
    .select('*')
    .eq('innovatrics_customer_id', innovatricsCustomerId)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch onboarding record', {
      innovatricsCustomerId,
      error,
    });
    return null;
  }

  return data ?? null;
}

interface DocumentPersistencePayload {
  documentResult: DocumentVerificationResult;
  images: {
    front: NormalizedImage;
    back?: NormalizedImage;
  };
}

interface SelfiePersistencePayload {
  selfieResult: JsonValue;
  image: NormalizedImage;
}

interface FaceDetectionPersistencePayload {
  faceResult: JsonValue;
  maskResult: JsonValue;
  image: NormalizedImage;
}

interface LivenessPersistencePayload {
  livenessResult: JsonValue;
  image?: NormalizedImage;
}

interface FaceComparisonPersistencePayload {
  comparisonResult: JsonValue;
  image: NormalizedImage;
}

export async function recordDocumentResult(
  innovatricsCustomerId: string,
  payload: DocumentPersistencePayload
) {
  const { documentResult, images } = payload;

  return updateOnboardingRecord({
    innovatricsCustomerId,
    fields: {
      document_summary: toDbJson(documentResult.summary),
      document_pages: toDbJson(documentResult.pages),
      inspection: toDbJson(documentResult.inspection),
      disclosed_inspection: toDbJson(documentResult.disclosedInspection),
    },
    event: {
      type: 'STEP_RESULT',
      payload: {
        step: 'document',
        summary: documentResult.summary ?? null,
        images,
      },
    },
  });
}

export async function recordSelfieResult(
  innovatricsCustomerId: string,
  payload: SelfiePersistencePayload
) {
  return updateOnboardingRecord({
    innovatricsCustomerId,
    fields: {
      selfie_result: toDbJson(payload.selfieResult),
    },
    event: {
      type: 'STEP_RESULT',
      payload: {
        step: 'selfie_upload',
        image: payload.image,
      },
    },
  });
}

export async function recordFaceDetection(
  innovatricsCustomerId: string,
  payload: FaceDetectionPersistencePayload
) {
  return updateOnboardingRecord({
    innovatricsCustomerId,
    fields: {
      face_comparison: toDbJson(payload.faceResult),
      liveness_result: toDbJson(payload.maskResult),
    },
    event: {
      type: 'STEP_RESULT',
      payload: {
        step: 'face_detection',
        image: payload.image,
      },
    },
  });
}

export async function recordLivenessResult(
  innovatricsCustomerId: string,
  payload: LivenessPersistencePayload
) {
  return updateOnboardingRecord({
    innovatricsCustomerId,
    fields: {
      liveness_result: toDbJson(payload.livenessResult),
    },
    event: {
      type: 'STEP_RESULT',
      payload: {
        step: 'liveness',
        image: payload.image,
      },
    },
  });
}

export async function recordFaceComparison(
  innovatricsCustomerId: string,
  payload: FaceComparisonPersistencePayload
) {
  return updateOnboardingRecord({
    innovatricsCustomerId,
    fields: {
      face_comparison: toDbJson(payload.comparisonResult),
    },
    event: {
      type: 'STEP_RESULT',
      payload: {
        step: 'face_comparison',
        image: payload.image,
      },
    },
  });
}

export async function markFinished(innovatricsCustomerId: string) {
  return updateOnboardingRecord({
    innovatricsCustomerId,
    fields: {
      status: STATUS.FINISHED,
      last_error_code: null,
      last_error_message: null,
    },
    event: {
      type: 'STATUS_CHANGE',
      payload: {
        status: STATUS.FINISHED,
        at: new Date().toISOString(),
      },
    },
  });
}

export async function recordError(
  innovatricsCustomerId: string,
  { code, message, markFailed, context }: RecordErrorParams
) {
  const status = markFailed ? STATUS.FAILED : STATUS.IN_PROGRESS;

  return updateOnboardingRecord({
    innovatricsCustomerId,
    fields: {
      status,
      last_error_code: code ?? null,
      last_error_message: message,
    },
    event: {
      type: 'ERROR',
      payload: {
        code: code ?? null,
        message,
        context: context ?? null,
        at: new Date().toISOString(),
      },
    },
  });
}

export async function recordRetry(
  innovatricsCustomerId: string,
  { reason, context }: RecordRetryParams
) {
  const existing = await fetchOnboardingRow(innovatricsCustomerId);

  if (!existing) {
    console.warn('Cannot record retry because onboarding record was not found', {
      innovatricsCustomerId,
    });
    return null;
  }

  const nextRetryCount = (existing.retry_count ?? 0) + 1;

  return updateOnboardingRecord({
    innovatricsCustomerId,
    existing,
    fields: {
      retry_count: nextRetryCount,
    },
    event: {
      type: 'RETRY',
      payload: {
        reason,
        context: context ?? null,
        at: new Date().toISOString(),
      },
    },
  });
}
