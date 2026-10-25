type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

export function validateIngestFile(file: { size: number; type: string; name: string }): ValidationResult {
  // 1. Check for empty file
  if (file.size <= 0) {
    return { ok: false, status: 400, error: 'File is empty' };
  }

  // 2. Check for oversized file (15 MiB = 15728640 bytes)
  const maxBytes = 15 * 1024 * 1024;
  if (file.size > maxBytes) {
    return { ok: false, status: 413, error: 'File is too large (max 15MB)' };
  }

  // 3. Type check with trimming and lowercasing
  const type = file.type.trim().toLowerCase();
  const allowedTypes = ['image/heic', 'image/heif', 'image/jpeg', 'image/png'];
  const allowedExtensions = ['.heic', '.heif', '.jpg', '.jpeg', '.png'];

  if (type) {
    // Non-empty type: must be one of the allowed image types
    if (!allowedTypes.includes(type)) {
      return { ok: false, status: 415, error: 'Unsupported file type' };
    }
  } else {
    // Empty type: check extension
    const nameLower = file.name.toLowerCase();
    const hasAllowedExt = allowedExtensions.some(ext => nameLower.endsWith(ext));
    if (!hasAllowedExt) {
      return { ok: false, status: 415, error: 'Unsupported file type' };
    }
  }

  // 4. All checks passed
  return { ok: true };
}
