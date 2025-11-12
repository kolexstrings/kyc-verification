export interface NormalizedImage {
  base64?: string;
  mimeType?: string;
  url?: string;
  publicId?: string;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
  resourceType?: string;
}

const DATA_URI_MIME_REGEX = /^data:(?<mime>[^;,]+)/i;

export function normalizeImagePayload(
  raw: string | undefined | null
): NormalizedImage {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Image payload must be a non-empty string');
  }

  const trimmed = raw.trim();
  const mimeMatch = DATA_URI_MIME_REGEX.exec(trimmed);
  const detectedMime = mimeMatch?.groups?.mime;

  let current = trimmed;

  // Strip any leading data URI headers, even if repeated or malformed
  while (current.toLowerCase().startsWith('data:')) {
    const commaIndex = current.indexOf(',');
    if (commaIndex === -1) {
      const semicolonIndex = current.indexOf(';');
      if (semicolonIndex === -1) {
        current = current.slice('data:'.length).trim();
        break;
      }
      current = current.slice(semicolonIndex + 1).trim();
    } else {
      current = current.slice(commaIndex + 1).trim();
    }
  }

  // Remove stray base64 markers that may precede the data
  while (/^base64[,;]/i.test(current)) {
    current = current.replace(/^base64[,;]/i, '').trim();
  }

  // Some malformed inputs may still include additional headers without commas
  current = current.replace(/^(?:data:[^,;]+[;,])+?/gi, '');

  const sanitizedBase64 = current
    .replace(/^[^A-Za-z0-9+/=]+/, '')
    .replace(/\s+/g, '');

  return {
    base64: sanitizedBase64,
    ...(detectedMime ? { mimeType: detectedMime } : {}),
  };
}
