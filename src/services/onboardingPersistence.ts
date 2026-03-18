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

export async function initializeOnboardingRecord(_: InitializeParams) {
  return null;
}

export async function getOnboardingByInnovatricsId(_: string) {
  return null;
}

export async function recordDocumentResult(
  _: string,
  __: DocumentPersistencePayload
) {
  return null;
}

export async function recordSelfieResult(
  _: string,
  __: SelfiePersistencePayload
) {
  return null;
}

export async function recordFaceDetection(
  _: string,
  __: FaceDetectionPersistencePayload
) {
  return null;
}

export async function recordLivenessResult(
  _: string,
  __: LivenessPersistencePayload
) {
  return null;
}

export async function recordFaceComparison(
  _: string,
  __: FaceComparisonPersistencePayload
) {
  return null;
}

export async function markFinished(_: string) {
  return null;
}

export async function recordError(_: string, __: RecordErrorParams) {
  return null;
}

export async function recordRetry(_: string, __: RecordRetryParams) {
  return null;
}
