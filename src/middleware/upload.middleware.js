/**
 * middleware/upload.middleware.js — Multer + Cloudinary upload handler.
 * Accepts image files (JPEG, PNG, WebP) up to 5MB.
 * Pipes the in-memory buffer directly to Cloudinary via upload_stream.
 * Attaches secure_url to req.fileUrl and public_id to req.filePublicId.
 */

'use strict';

const multer = require('multer');
const streamifier = require('streamifier');
const cloudinary = require('../config/cloudinary');
const ApiError = require('../utils/ApiError');

const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

// Detect real file type from magic bytes — cannot be spoofed via Content-Type header
const detectMimeFromBuffer = (buf) => {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  // WebP: RIFF????WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
};

// Use memory storage — never write to disk
const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only JPEG, PNG, and WebP images are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_SIZE },
});

/**
 * Uploads a buffer to Cloudinary using upload_stream (no temp files).
 * @param {Buffer} buffer - File buffer from multer memoryStorage
 * @param {string} folder - Cloudinary folder path (e.g. 'slipr/screenshots')
 * @returns {Promise<{secure_url: string, public_id: string}>}
 */
const uploadToCloudinary = (buffer, folder, resourceType = 'image') => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, quality: 'auto', fetch_format: 'auto' },
      (err, result) => {
        if (err) return reject(new ApiError(500, `Cloudinary upload failed: ${err.message}`));
        resolve({ secure_url: result.secure_url, public_id: result.public_id });
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
};

/**
 * Express middleware factory.
 * Usage: router.post('/photo', protect, uploadMiddleware('slipr/profile'), controller)
 *
 * @param {string} folder - Cloudinary destination folder
 * @param {string} fieldName - Multer form field name (default: 'file')
 */
const uploadMiddleware = (folder, fieldName = 'file') => {
  const multerSingle = upload.single(fieldName);

  return async (req, res, next) => {
    multerSingle(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(400, 'File too large — maximum size is 5MB'));
        }
        return next(new ApiError(400, err.message));
      }
      if (err) return next(err);
      if (!req.file) return next(new ApiError(400, 'No file provided'));

      // Verify magic bytes — reject files that lie about their Content-Type
      const detectedMime = detectMimeFromBuffer(req.file.buffer);
      if (!detectedMime) {
        return next(new ApiError(400, 'Invalid image file — unrecognised format'));
      }

      try {
        const result = await uploadToCloudinary(req.file.buffer, folder);
        req.fileUrl = result.secure_url;
        req.filePublicId = result.public_id;
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  };
};

/**
 * Convenience single-file multer middleware — does NOT upload to Cloudinary.
 * Controllers that call uploadSingle still need to call uploadToCloudinary themselves.
 * @param {string} fieldName - Form field name
 */
const uploadSingle = (fieldName) => upload.single(fieldName);

module.exports = { uploadMiddleware, upload, uploadSingle, uploadToCloudinary };
