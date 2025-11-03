import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from 'cloudinary';
import { config } from '../config/env';

const { cloudName, apiKey, apiSecret, uploadFolder, uploadPreset } = config.cloudinary;

if (!cloudName || !apiKey || !apiSecret) {
  console.warn(
    'Cloudinary credentials are missing. Uploads will fail until CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are set.'
  );
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
});

export interface CloudinaryUploadOptions {
  folder?: string;
  preset?: string;
  tags?: string[];
  resourceType?: 'image' | 'video' | 'auto';
}

export interface CloudinaryUploadResult {
  secureUrl: string;
  publicId: string;
  format: string;
  bytes: number;
  width?: number;
  height?: number;
}

export async function uploadImageFromBuffer(
  buffer: Buffer,
  fileName: string,
  options: CloudinaryUploadOptions = {}
): Promise<CloudinaryUploadResult> {
  const uploadOptions: UploadApiOptions = {
    resource_type: options.resourceType ?? 'image',
    use_filename: true,
    filename_override: fileName,
  };

  const folderToUse = options.folder ?? uploadFolder;
  if (folderToUse) {
    uploadOptions.folder = folderToUse;
  }

  const presetToUse = options.preset ?? uploadPreset;
  if (presetToUse) {
    uploadOptions.upload_preset = presetToUse;
  }

  if (options.tags) {
    uploadOptions.tags = options.tags;
  }

  const response: UploadApiResponse = await new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error || !result) {
        return reject(error);
      }
      resolve(result);
    });

    upload.end(buffer);
  });

  return {
    secureUrl: response.secure_url,
    publicId: response.public_id,
    format: response.format,
    bytes: response.bytes,
    width: response.width ?? undefined,
    height: response.height ?? undefined,
  };
}

export function getCloudinaryPublicUrl(publicId: string, options?: { resourceType?: string }) {
  return cloudinary.url(publicId, {
    secure: true,
    resource_type: options?.resourceType ?? 'image',
  });
}
