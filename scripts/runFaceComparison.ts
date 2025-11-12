import { promises as fs } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import sharp from 'sharp';

import { InnovatricsService } from '../src/services/innovatricsClient';
import { normalizeImagePayload } from '../src/utils/image';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function readBase64(fileName: string): Promise<string> {
  const filePath = path.resolve(__dirname, '..', 'data', fileName);
  const raw = await fs.readFile(filePath, 'utf8');
  const normalized = normalizeImagePayload(raw);
  if (!normalized.base64) {
    throw new Error(`File ${fileName} does not contain valid base64 data`);
  }
  return normalized.base64;
}

async function detectFace(
  client: InnovatricsService,
  label: string,
  base64: string
): Promise<string> {
  const result = await client.detectFace(base64);
  const detection = result.detection as any;
  console.log(`Detected ${label} face`, {
    id: result.id,
    confidence: detection?.confidence ?? detection?.score,
    boundingBox: detection?.faceRectangle ?? detection?.boundingBox,
  });
  return result.id;
}

async function compareFace(
  client: InnovatricsService,
  suite: string,
  probeLabel: string,
  probeFaceId: string,
  referenceTemplate: string
): Promise<void> {
  const response = await client.compareFaces(probeFaceId, {
    referenceFaceTemplate: referenceTemplate,
  });

  console.log(`[${suite}] Similarity ${probeLabel} → document`, {
    score: response.score,
  });
}

const minDimension = 1800;
const maxDimension = 3000;

async function pipelineSelfieTransform(base64: string, label: string): Promise<string> {
  const sanitized = base64.replace(/\s+/g, '');
  const buffer = Buffer.from(sanitized, 'base64');
  const metadata = await sharp(buffer, { failOn: 'none' }).metadata();

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
    } else {
      targetWidth = metadata.width;
      targetHeight = metadata.height;
    }
  }

  const resizedBuffer = await sharp(buffer)
    .rotate()
    .resize(targetWidth, targetHeight, {
      fit: 'inside',
      kernel: 'lanczos3',
      withoutEnlargement: false,
    })
    .jpeg({
      quality: 95,
      mozjpeg: true,
    })
    .toBuffer();

  console.log('Pipeline selfie transform', {
    label,
    originalBytes: buffer.length,
    resizedBytes: resizedBuffer.length,
    targetWidth,
    targetHeight,
  });

  return resizedBuffer.toString('base64');
}

async function rawSelfieTransform(base64: string): Promise<string> {
  return base64;
}

async function runSuite(
  client: InnovatricsService,
  suiteLabel: string,
  selfieTransform: (base64: string, label: string) => Promise<string>,
  baseImages: Record<string, string>
): Promise<void> {
  console.log(`\n=== ${suiteLabel.toUpperCase()} SUITE ===`);

  const documentFaceId = await detectFace(client, `${suiteLabel}:document`, baseImages.document);
  const documentTemplate = await client.getFaceTemplate(documentFaceId);
  console.log(`[${suiteLabel}] Document template diagnostics`, {
    version: documentTemplate.version,
    length: documentTemplate.data.length,
    sample: documentTemplate.data.slice(0, 32),
    suffix: documentTemplate.data.slice(-32),
  });

  const selfieFaceIds: Record<string, string> = {};
  for (const label of ['profile', 'selfie1', 'selfie2', 'selfie3']) {
    const transformed = await selfieTransform(baseImages[label], label);
    selfieFaceIds[label] = await detectFace(client, `${suiteLabel}:${label}`, transformed);
  }

  for (const label of ['profile', 'selfie1', 'selfie2', 'selfie3']) {
    await compareFace(client, suiteLabel, label, selfieFaceIds[label], documentTemplate.data);
  }
}

async function main(): Promise<void> {
  const innovatrics = new InnovatricsService();

  const baseImages = {
    document: await readBase64('document_front_base64.txt'),
    profile: await readBase64('profile_image_base64.txt'),
    selfie1: await readBase64('selfie1_base64.txt'),
    selfie2: await readBase64('selfie2_base64.txt'),
    selfie3: await readBase64('selfie3_base64.txt'),
  };

  await runSuite(innovatrics, 'raw', async (base64) => rawSelfieTransform(base64), baseImages);
  await runSuite(innovatrics, 'pipeline', pipelineSelfieTransform, baseImages);
}

main().catch((error) => {
  console.error('Face comparison harness failed:', error);
  process.exit(1);
});
