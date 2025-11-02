export interface NormalizedImage {
  base64: string;
  mimeType?: string;
}

const DATA_URI_REGEX = /^data:(?<mime>[^;]+);base64,(?<data>.+)$/;

export function normalizeImagePayload(raw: string | undefined | null): NormalizedImage {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Image payload must be a non-empty string');
  }

  const trimmed = raw.trim();
  const match = DATA_URI_REGEX.exec(trimmed);

  if (match?.groups?.data) {
    return {
      base64: match.groups.data,
      mimeType: match.groups.mime,
    };
  }

  return {
    base64: trimmed,
  };
}
